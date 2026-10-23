// The one shape of "ask the owner before anything is sent": a mail reply or send, an SNS comment, reply or post, a chat message.
// The features build the asking message with draftApprovalBlock; the gateway reads it back with parseDraftApproval, so the bell shows
// the draft itself and the bottom sheet offers 1) send 2) change 3) do not send. A pick maps to an action with draftActionOf.
//
//   > 받는이: <recipient or target>          (label: 받는이 | 대상 | 대화방, one line)
//   > 제목: <subject>                        (optional)
//   > 첨부: <name> (<size>)                  (optional, one line per file that goes out; "> 첨부: 없음" = the mail it answers had files and this
//                                            reply carries none, so the owner sees they are not included)
//   >
//   > <body, every line quoted>
//   결정: <question> (<ref>)                 (ref = the id the approve command takes: draft id, job id, draft code)
//   **1) 보내기** ← 추천
//   <what happens>
//   **2) 고치기 …**   **3) 보내지 않기** ...
//
// 2) 고치기 is an option that needs detail (hub/choices.ts detailOf; the bot's own mark is a trailing " …" on the name): the web sheet and the
// Discord modal ask for the change first, and the answer is "2) 고치기 - <change>".
// The answer comes back as the owner's own inbox message with picks [{q: "<question> (<ref>)", n, label}] (hub/notices.ts answerDecision),
// which is what the per-feature approval checks read (hub/kakao/send.ts verdict, orchestrator turn "결정 답: ... → 1) 보내기").
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { issueBlock, parseDecisions } from "./choices.ts";

export const DRAFT_SEND = "보내기";
export const DRAFT_EDIT = "고치기";
export const DRAFT_DROP = "보내지 않기";
export type DraftAction = "send" | "edit" | "drop";
export type DraftToLabel = "받는이" | "대상" | "대화방";
export const DRAFT_BODY_MAX = 6000;

export const NO_ATTACHMENT_WARNING = "본문에 첨부라고 썼지만 첨부파일이 없어요";
// An outgoing file: size in bytes when building a block, as the block shows it ("340KB") once parsed.
export type DraftFileIn = { name: string; size?: number };
export type DraftFile = { name: string; size?: string };
export type DraftApproval = { toLabel: string; to: string; subject?: string; body: string; ref?: string; attachments?: DraftFile[]; noAttachments?: true; warning?: string };
export type DraftInput = { to: string; toLabel?: DraftToLabel; subject?: string; body: string; ref: string; question?: string; sendResult?: string; attachments?: DraftFileIn[]; attachmentsNone?: boolean };

export function fileSizeText(b: number): string {
	return b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : b >= 1024 ? `${Math.round(b / 1024)}KB` : `${Math.max(0, Math.round(b))}B`;
}

// The draft says it attaches something ("첨부합니다", "attached"). A refusal ("첨부하지 못", "첨부 없음") is not a claim.
const CLAIM = /첨부\s*(?:파일|자료|문서|서류)?\s*(?:을|를|은|는)?\s*(?:합니다|했습니다|했어요|해요|드립니다|드려요|드릴게요|해\s*드립니다|해\s*드려요|해\s*드릴게요|하였습니다)|첨부(?:파일|자료|문서|서류)?\s*(?:을|를)?\s*(?:보내|함께)|\b(?:attached|attaching)\b|\bI(?:'ve| have)?\s+attach|\bplease\s+find\b.*\battach/i;
const NO_CLAIM = /첨부\s*(?:파일)?\s*(?:은|는|이|가)?\s*(?:없|못|불가)|첨부(?:하지|할 수 없)|not\s+attach|no\s+attach/i;
export const claimsAttachment = (text: string): boolean => CLAIM.test(text) && !NO_CLAIM.test(text);

const quote = (s: string) => s.split("\n").map(l => (l ? `> ${l}` : ">"));

export function draftApprovalBlock(d: DraftInput): string {
	const files = (d.attachments ?? []).map(f => `> 첨부: ${f.name.replace(/\s+/g, " ").trim()}${f.size !== undefined ? ` (${fileSizeText(f.size)})` : ""}`);
	const head = [`> ${d.toLabel ?? "받는이"}: ${d.to.replace(/\s+/g, " ").trim()}`, ...(d.subject ? [`> 제목: ${d.subject.replace(/\s+/g, " ").trim()}`] : []), ...(files.length ? files : d.attachmentsNone ? ["> 첨부: 없음"] : []), ">"];
	const options = [
		{ name: DRAFT_SEND, result: d.sendResult ?? `${d.to.replace(/\s+/g, " ").trim()}에 이 글을 그대로 보내요` },
		{ name: `${DRAFT_EDIT} …`, result: "어떻게 고칠지 알려 주면 고쳐서 다시 물어봐요" },
		{ name: DRAFT_DROP, result: "이 초안은 버려요" },
	];
	return [...head, ...quote(d.body.replace(/\r\n?/g, "\n").trim()), issueBlock(`${d.question ?? "보낼까요?"} (${d.ref})`, options)].join("\n");
}

const HEADER = /^(받는이|대상|대화방)\s*[:：]\s*(.*)$/;
const SUBJECT = /^제목\s*[:：]\s*(.*)$/;
const ATTACH = /^첨부\s*[:：]\s*(.*)$/;
const FILE_SIZE = /^(.*\S)\s+\((\d+(?:\.\d+)?(?:B|KB|MB|GB))\)$/;
const REF = /\(([A-Za-z0-9][A-Za-z0-9_.:-]{1,63})\)\s*$/;

// The draft a message asks approval for; undefined when the message is not a draft-approval decision (one block whose options are exactly
// 보내기 / 고치기 / 보내지 않기, with a quoted draft above it).
export function parseDraftApproval(text: string): DraftApproval | undefined {
	const pc = parseDecisions(text);
	const block = pc.blocks.length === 1 ? pc.blocks[0]! : undefined;
	if (!block || block.options.map(o => o.label).join("|") !== [DRAFT_SEND, DRAFT_EDIT, DRAFT_DROP].join("|")) return undefined;
	const draft = parseQuotedDraft(text);
	const ref = REF.exec(block.title)?.[1];
	return draft && ref ? { ...draft, ref } : draft;
}

// The quoted draft of a message as a draft (recipient line, optional subject, body), whatever the options below it are; undefined when the
// message quotes none. Blank lines in the body are collapsed to one (a mail quoted with doubled breaks reads as normal paragraphs).
export function parseQuotedDraft(text: string): DraftApproval | undefined {
	let fence = false;
	const quoted: string[] = [];
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		const m = fence ? null : /^\s*>\s?(.*)$/.exec(line);
		if (m) quoted.push(m[1]!);
	}
	if (!quoted.length) return undefined;
	const first = quoted.findIndex(l => HEADER.test(l));
	if (first > 0) quoted.splice(0, first); // a quote above the draft (the comment being answered) is not part of it
	let toLabel = "받는이";
	let to = "";
	let subject: string | undefined;
	const attachments: DraftFile[] = [];
	let none = false;
	let i = 0;
	for (; i < quoted.length; i++) {
		const h = HEADER.exec(quoted[i]!) ?? undefined;
		const s = SUBJECT.exec(quoted[i]!);
		const a = to ? ATTACH.exec(quoted[i]!) : null;
		if (h && !to) {
			toLabel = h[1]!;
			to = h[2]!.trim();
		} else if (s && subject === undefined) subject = s[1]!.trim();
		else if (a) {
			const v = a[1]!.trim();
			const m = FILE_SIZE.exec(v);
			if (v === "없음") none = true;
			else if (v) attachments.push(m ? { name: m[1]!, size: m[2]! } : { name: v });
		} else break;
	}
	const body = quoted.slice(i).join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
	if (!body) return undefined;
	const clipped = body.slice(0, DRAFT_BODY_MAX);
	const warn = toLabel === "받는이" && !attachments.length && claimsAttachment(`${subject ?? ""}\n${clipped}`);
	return { toLabel, to, ...(subject ? { subject } : {}), body: clipped, ...(attachments.length ? { attachments } : none ? { noAttachments: true as const } : {}), ...(warn ? { warning: NO_ATTACHMENT_WARNING } : {}) };
}

// The quoted draft of a message (recipient line first, as draftApprovalBlock writes it), as standard "> " lines; undefined when the message
// quotes no draft (a quote that does not start with the recipient line is something else, e.g. the mail being answered).
export function quotedDraft(text: string): string | undefined {
	let fence = false;
	let out: string[] | undefined;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		const m = fence ? null : /^\s*>\s?(.*)$/.exec(line);
		if (!m) {
			if (out) break;
			continue;
		}
		if (!out && !HEADER.test(m[1]!)) continue;
		(out ??= []).push(m[1]! ? `> ${m[1]}` : ">");
	}
	return out?.join("\n").replace(/(?:\n>)+$/, "");
}

// What a picked label means; anything else (a label outside the three) is not a draft answer.
export function draftActionOf(label: string): DraftAction | undefined {
	return label === DRAFT_SEND ? "send" : label === DRAFT_EDIT ? "edit" : label === DRAFT_DROP ? "drop" : undefined;
}

export type DraftVerdict = { verdict: DraftAction | "none"; detail?: string };
const OWNER_SOURCES = new Set(["web", "discord", "terminal"]);
const TAIL_BYTES = 2 * 1024 * 1024;

// What the owner picked for the draft `ref` (the id in the question's trailing "(<ref>)") after `sinceMs`, read from the inbox log.
// Only the owner's own messages count (web, discord, terminal; not a session's lane_message) and the latest pick wins. For 고치기 the
// detail is the change the owner typed ("2) 고치기 - <change>").
export function draftVerdict(inboxPath: string, ref: string, sinceMs: number): DraftVerdict {
	if (!existsSync(inboxPath)) return { verdict: "none" };
	const size = statSync(inboxPath).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const buf = Buffer.alloc(size - start);
	const fd = openSync(inboxPath, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift();
	const tag = `(${ref})`;
	let out: DraftVerdict = { verdict: "none" };
	for (const line of lines) {
		let e: { ts?: unknown; kind?: unknown; source?: unknown; text?: unknown; picks?: unknown };
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!e || e.kind !== "message" || typeof e.source !== "string" || !OWNER_SOURCES.has(e.source) || typeof e.ts !== "string" || !(Date.parse(e.ts) > sinceMs)) continue;
		for (const p of Array.isArray(e.picks) ? (e.picks as { q?: unknown; label?: unknown }[]) : []) {
			if (typeof p?.q !== "string" || !p.q.includes(tag) || typeof p.label !== "string") continue;
			const verdict = draftActionOf(p.label);
			if (!verdict) continue;
			const detail = verdict === "edit" && typeof e.text === "string" ? e.text.split(" - ").slice(1).join(" - ").trim() : "";
			out = { verdict, ...(detail ? { detail } : {}) };
		}
	}
	return out;
}
