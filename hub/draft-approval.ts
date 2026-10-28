// The one shape of "ask the owner before anything is sent": a mail reply or send, an SNS comment, reply or post, a chat message.
// The features build the asking message with draftApprovalBlock; the gateway reads it back with parseDraftApproval, so the bell shows
// the draft itself and the bottom sheet offers 1) send 2) change 3) do not send. A pick maps to an action with draftActionOf.
//
//   > 받는이: <recipient or target>          (label: 받는이 | 대상 | 대화방, one line; a mail's 받는 사람 may be a comma list)
//   > 참조: <addresses>                      (optional, a mail that goes to 참조 as well, one comma list)
//   > 제목: <subject>                        (optional)
//   > 첨부: <name> (<size>)                  (optional, one line per file that goes out; "> 첨부: 없음" = the mail it answers had files and this
//                                            reply carries none, so the owner sees they are not included)
//   > 이어서: <what it follows> (<link>)  (optional, a draft made as a follow-up of an approved action, e.g. "댓글 답글에 이어서" + the comment's link)
//   > 규칙: <name>                         (optional, the 자동 초안 규칙 that drafted it: the card's badge)
//   >
//   > <body, every line quoted>
//   >                                       (optional second part, a mail that goes out with a comment reply and is approved by the same pick:)
//   > 함께 보낼 메일
//   > 받는이: <address>   > 제목: <subject>   > 첨부: <name> (<size>)   >   > <mail body, every line quoted>
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

export const NO_ATTACHMENT_WARNING = "본문에 파일을 보낸다고 썼지만 첨부파일이 없어요";
export const LIBRARY_MISS = "첨부 파일 폴더에서 맞는 파일을 찾지 못했어요";
// A mail sent through a source that cannot carry files (a webmail-no-api site): the 첨부 row says so and names the files that stay behind.
export const CANNOT_ATTACH = "이 메일은 파일을 붙여 보낼 수 없어요";
export const CANNOT_ATTACH_WARNING = `${CANNOT_ATTACH}. 파일은 직접 보내야 해요`;
const NOTE_BODY = "본문에는 보낸다고 썼어요";
const NOTE_ASKED = "받은 메일이 파일을 요청했어요";
// An outgoing file: size in bytes when building a block, as the block shows it ("340KB") once parsed.
export type DraftFileIn = { name: string; size?: number };
export type DraftFile = { name: string; size?: string };
export type DraftOrigin = { text: string; link?: string };
export type DraftApproval = { toLabel: string; to: string; cc?: string[]; mode?: "reply" | "all"; subject?: string; body: string; ref?: string; attachments?: DraftFile[]; noAttachments?: true; warning?: string; note?: string; origin?: DraftOrigin; rule?: string; mail?: DraftApproval };
// One part of a card: the reply (or the mail) with its recipient line, files and body.
export type DraftPart = { origin?: DraftOrigin; rule?: string; to: string; toLabel?: DraftToLabel; cc?: string[]; subject?: string; body: string; attachments?: DraftFileIn[]; attachmentsNone?: boolean; asksFile?: boolean; libraryMiss?: boolean; /** The source cannot send files: the names of the files staged for it (they do not go out), [] when none. */ cannotAttach?: string[] };
// `mail`: the mail that goes out right after this comment reply, shown below it in the same card (hub/comments).
export type DraftInput = DraftPart & { ref: string; question?: string; sendResult?: string; mail?: DraftPart };
export const MAIL_MARK = "함께 보낼 메일";

export function fileSizeText(b: number): string {
	return b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : b >= 1024 ? `${Math.round(b / 1024)}KB` : `${Math.max(0, Math.round(b))}B`;
}

// The draft says it attaches something ("첨부합니다", "attached"). A refusal ("첨부하지 못", "첨부 없음") is not a claim.
const CLAIM = /첨부\s*(?:파일|자료|문서|서류)?\s*(?:을|를|은|는)?\s*(?:합니다|했습니다|했어요|해요|드립니다|드려요|드릴게요|해\s*드립니다|해\s*드려요|해\s*드릴게요|하였습니다)|첨부(?:파일|자료|문서|서류)?\s*(?:을|를)?\s*(?:보내|함께)|\b(?:attached|attaching)\b|\bI(?:'ve| have)?\s+attach|\bplease\s+find\b.*\battach/i;
const NO_CLAIM = /첨부\s*(?:파일)?\s*(?:은|는|이|가)?\s*(?:없|못|불가)|첨부(?:하지|할 수 없)|not\s+attach|no\s+attach|보내\s*(?:드리지|지)\s*못|못\s*보내|보내\s*드릴 수 없|보낼 수 없/i;
// Nouns that name a file when a draft says it sends one or a mail asks for one.
const FILE_NOUN = "악보|파일|자료|문서|견적서|청구서|계약서|제안서|보고서|이력서|영수증|사진|이미지|영상|음원|녹음|양식|서식|신청서|스캔본|스캔|첨부|pdf|hwpx?|docx?|xlsx?|pptx?|zip";
const SENDS = "보내\\s*드(?:립니다|려요|릴게요|릴께요|리겠습니다|렸습니다|렸어요|립니다만)|보냅니다|보내요|보낼게요|보냈(?:습니다|어요)";
// "행방불명 OST 또다시 악보 보내드립니다", "보내드린 악보는": the draft says it sends a file-like thing.
const SENDS_FILE = new RegExp(`(?:${FILE_NOUN})[가-힣]{0,2}\\s*(?:을|를|은|는|도|만)?\\s*(?:[가-힣A-Za-z0-9]+\\s+){0,2}(?:${SENDS})|(?:보내\\s*드린|보낸)\\s*(?:${FILE_NOUN})|\\b(?:I'm sending|I'll send|I sent|I've sent|sending you|here is|here's)\\b[^.\\n]{0,40}\\b(?:file|pdf|document|score|sheet music|photo|invoice|quote)s?\\b`, "i");
const ASK = /부탁|보내\s*주|보내\s*줘|보내\s*달|(?:공유|전달)\s*해?\s*(?:주|달)|주세요|주시면|주실 수|주실래/;
const ASK_EN = /\b(?:please|could you|can you|would you)\b[^.\n]{0,40}\b(?:send|share|attach|forward)\b[^.\n]{0,40}\b(?:file|pdf|document|score|sheet music|photo|invoice|quote|copy)s?\b/i;
export const claimsAttachment = (text: string): boolean => (CLAIM.test(text) || SENDS_FILE.test(text)) && !NO_CLAIM.test(text);
// The mail being answered asks for a file ("악보 부탁드립니다", "견적서 보내주세요").
export const asksForFile = (text: string): boolean =>
	ASK_EN.test(text) || text.split(/[.!?\n]+/).some(sentence => new RegExp(FILE_NOUN, "i").test(sentence) && ASK.test(sentence));

const quote = (s: string) => s.split("\n").map(l => (l ? `> ${l}` : ">"));

function partLines(d: DraftPart): string[] {
	const files = (d.attachments ?? []).map(f => `> 첨부: ${f.name.replace(/\s+/g, " ").trim()}${f.size !== undefined ? ` (${fileSizeText(f.size)})` : ""}`);
	const note = files.length ? "" : (d.toLabel ?? "받는이") !== "받는이" ? "" : claimsAttachment(`${d.subject ?? ""}\n${d.body}`) ? NOTE_BODY : d.asksFile ? NOTE_ASKED : "";
	// A mail always says what goes with it, files or 없음, so a missing file is seen before 보내기 (owner 2026-10-26).
	const mail = (d.toLabel ?? "받는이") === "받는이";
	const left = (d.cannotAttach ?? []).map(n => n.replace(/\s+/g, " ").trim());
	const reasons = [...(d.cannotAttach && (left.length || note) ? [CANNOT_ATTACH] : []), ...(left.length ? [`빠진 파일: ${left.join(", ")}`] : []), ...(note ? [note] : []), ...(note && d.libraryMiss ? [LIBRARY_MISS] : [])];
	const none = reasons.length ? `> 첨부: 없음 (${reasons.join(" · ")})` : d.attachmentsNone || mail ? "> 첨부: 없음" : "";
	const cc = (d.cc ?? []).map(a => a.replace(/\s+/g, " ").trim()).filter(Boolean);
	const head = [`> ${d.toLabel ?? "받는이"}: ${d.to.replace(/\s+/g, " ").trim()}`, ...(cc.length ? [`> 참조: ${cc.join(", ")}`] : []), ...(d.subject ? [`> 제목: ${d.subject.replace(/\s+/g, " ").trim()}`] : []), ...(files.length ? files : none ? [none] : []), ...(d.origin ? [`> 이어서: ${d.origin.text.replace(/\s+/g, " ").trim()}${d.origin.link ? ` (${d.origin.link.replace(/\s+/g, "")})` : ""}`] : []), ...(d.rule ? [`> 규칙: ${d.rule.replace(/\s+/g, " ").trim()}`] : []), ">"];
	return [...head, ...quote(d.body.replace(/\r\n?/g, "\n").trim())];
}

export function draftApprovalBlock(d: DraftInput): string {
	const options = [
		{ name: DRAFT_SEND, result: d.sendResult ?? `${d.to.replace(/\s+/g, " ").trim()}에 이 글을 그대로 보내요` },
		{ name: `${DRAFT_EDIT} …`, result: d.mail ? "답글과 메일 중 어느 쪽을 어떻게 고칠지 알려 주면 고쳐서 다시 물어봐요" : "어떻게 고칠지 알려 주면 고쳐서 다시 물어봐요" },
		{ name: DRAFT_DROP, result: d.mail ? "답글과 메일을 모두 버려요" : "이 초안은 버려요" },
	];
	const mail = d.mail ? [">", `> ${MAIL_MARK}`, ...partLines({ ...d.mail, toLabel: "받는이" })] : [];
	return [...partLines(d), ...mail, issueBlock(`${d.question ?? "보낼까요?"} (${d.ref})`, options)].join("\n");
}

// A card made before a change to how drafts are read (the always-shown 첨부 row, 2026-10-26) re-read from its own text with the current
// rules: the head (recipient, subject, files, warning, origin) is replaced, the body and ref stay (the stored text may be cut shorter).
const HEAD_KEYS = ["toLabel", "to", "cc", "subject", "attachments", "noAttachments", "warning", "note", "origin", "rule"] as const;
export function refreshDraft(old: DraftApproval, text: string): DraftApproval {
	const fresh = parseQuotedDraft(text);
	if (!fresh) return old;
	const head = (o: DraftApproval, f: DraftApproval): DraftApproval => {
		const out: Record<string, unknown> = { ...o };
		for (const k of HEAD_KEYS) {
			if (f[k] === undefined) delete out[k];
			else out[k] = f[k];
		}
		return out as DraftApproval;
	};
	const next = head(old, fresh);
	if (old.mail && fresh.mail) next.mail = head(old.mail, fresh.mail);
	return next;
}

// The stored asking message of a card whose 받는 사람·참조 changed (hub/draft-recipients.ts): its 받는이 line and 참조 line become the new ones,
// everything else (제목, 첨부, 이어서, body) stays, so the card is re-read as the same card after a restart.
export function rewriteDraftTo(text: string, to: string, cc: readonly string[]): string {
	const lines = text.split("\n");
	const head = lines.findIndex(l => /^>\s*받는이\s*[:：]/.test(l));
	if (head < 0) return text;
	const out = [...lines.slice(0, head), `> 받는이: ${to.replace(/\s+/g, " ").trim()}`, ...(cc.length ? [`> 참조: ${cc.join(", ")}`] : [])];
	let i = head + 1;
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		if (/^>\s*참조\s*[:：]/.test(line)) continue;
		if (!/^>\s*(?:제목|첨부|이어서)\s*[:：]/.test(line)) break;
		out.push(line);
	}
	return [...out, ...lines.slice(i)].join("\n");
}

const HEADER = /^(받는이|대상|대화방)\s*[:：]\s*(.*)$/;
const CC = /^참조\s*[:：]\s*(.*)$/;
const SUBJECT = /^제목\s*[:：]\s*(.*)$/;
const ATTACH = /^첨부\s*[:：]\s*(.*)$/;
const ORIGIN = /^이어서\s*[:：]\s*(.*?)(?:\s+\(((?:https?:\/\/|#|\/)\S*)\))?$/;
const RULE = /^규칙\s*[:：]\s*(.+)$/;
const NONE_NOTE = /^없음\s*\((.+)\)$/;
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
	const cut = quoted.indexOf(MAIL_MARK);
	if (cut < 0) return parseDraftLines(quoted);
	const mail = parseDraftLines(quoted.slice(cut + 1));
	const main = parseDraftLines(quoted.slice(0, cut));
	return main && mail ? { ...main, mail } : main;
}

// One part (the reply or the mail) from its quoted lines: recipient line, optional subject / files / origin, then the body.
function parseDraftLines(quoted: string[]): DraftApproval | undefined {
	let toLabel = "받는이";
	let to = "";
	let subject: string | undefined;
	let cc: string[] = [];
	const attachments: DraftFile[] = [];
	let none = false;
	let note: string | undefined;
	let origin: DraftOrigin | undefined;
	let rule: string | undefined;
	let i = 0;
	for (; i < quoted.length; i++) {
		const h = HEADER.exec(quoted[i]!) ?? undefined;
		const c = to && !cc.length ? CC.exec(quoted[i]!) : null;
		const s = SUBJECT.exec(quoted[i]!);
		const a = to ? ATTACH.exec(quoted[i]!) : null;
		const o = to && !origin ? ORIGIN.exec(quoted[i]!) : null;
		const r = to && rule === undefined ? RULE.exec(quoted[i]!) : null;
		if (h && !to) {
			toLabel = h[1]!;
			to = h[2]!.trim();
		} else if (c) cc = c[1]!.split(/\s*,\s*/).map(a => a.trim()).filter(Boolean);
		else if (s && subject === undefined) subject = s[1]!.trim();
		else if (r) rule = r[1]!.trim();
		else if (o && o[1]!.trim()) origin = { text: o[1]!.trim(), ...(o[2] ? { link: o[2] } : {}) };
		else if (a) {
			const v = a[1]!.trim();
			const m = FILE_SIZE.exec(v);
			const nn = NONE_NOTE.exec(v);
			// One line naming several files ("a.xlsx, b.pdf", a hand-written block) is one file per name.
			const parts = v.split(/\s*,\s+/);
			if (v === "없음") none = true;
			else if (nn) note = nn[1]!.trim();
			else if (parts.length > 1 && parts.every(x => /\.[A-Za-z0-9]{1,5}(?:\s+\([^()]+\))?$/.test(x)))
				for (const x of parts) {
					const pm = FILE_SIZE.exec(x);
					attachments.push(pm ? { name: pm[1]!, size: pm[2]! } : { name: x });
				}
			else if (v) attachments.push(m ? { name: m[1]!, size: m[2]! } : { name: v });
		} else break;
	}
	const body = quoted.slice(i).join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
	if (!body) return undefined;
	const clipped = body.slice(0, DRAFT_BODY_MAX);
	const warn = toLabel === "받는이" && !attachments.length && (!!note || claimsAttachment(`${subject ?? ""}\n${clipped}`));
	return { toLabel, to, ...(cc.length ? { cc } : {}), ...(subject ? { subject } : {}), body: clipped, ...(attachments.length ? { attachments } : none || toLabel === "받는이" ? { noAttachments: true as const } : {}), ...(warn ? { warning: note?.startsWith(CANNOT_ATTACH) ? CANNOT_ATTACH_WARNING : NO_ATTACHMENT_WARNING } : {}), ...(note ? { note } : {}), ...(origin ? { origin } : {}), ...(rule ? { rule } : {}) };
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
