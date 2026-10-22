// The one shape of "ask the owner before anything is sent": a mail reply or send, an SNS comment, reply or post, a chat message.
// The features build the asking message with draftApprovalBlock; the gateway reads it back with parseDraftApproval, so the bell shows
// the draft itself and the bottom sheet offers 1) send 2) change 3) do not send. A pick maps to an action with draftActionOf.
//
//   > 받는이: <recipient or target>          (label: 받는이 | 대상 | 대화방, one line)
//   > 제목: <subject>                        (optional)
//   >
//   > <body, every line quoted>
//   결정: <question> (<ref>)                 (ref = the id the approve command takes: draft id, job id, draft code)
//   **1) 보내기** ← 추천
//   <what happens>
//   **2) 고치기** ...   **3) 보내지 않기** ...
//
// 2) 고치기 is an option that needs detail (hub/choices.ts detailOf; the bot's own mark is a trailing " …" on the name): the web sheet and the
// Discord modal ask for the change first, and the answer is "2) 고치기 - <change>".
// The answer comes back as the owner's own inbox message with picks [{q: "<question> (<ref>)", n, label}] (hub/notices.ts answerDecision),
// which is what the per-feature approval checks read (hub/kakao/send.ts verdict, orchestrator turn "결정 답: ... → 1) 보내기").
import { issueBlock, parseDecisions } from "./choices.ts";

export const DRAFT_SEND = "보내기";
export const DRAFT_EDIT = "고치기";
export const DRAFT_DROP = "보내지 않기";
export type DraftAction = "send" | "edit" | "drop";
export type DraftToLabel = "받는이" | "대상" | "대화방";
export const DRAFT_BODY_MAX = 6000;

export type DraftApproval = { toLabel: string; to: string; subject?: string; body: string; ref?: string };
export type DraftInput = { to: string; toLabel?: DraftToLabel; subject?: string; body: string; ref: string; question?: string; sendResult?: string };

const quote = (s: string) => s.split("\n").map(l => (l ? `> ${l}` : ">"));

export function draftApprovalBlock(d: DraftInput): string {
	const head = [`> ${d.toLabel ?? "받는이"}: ${d.to.replace(/\s+/g, " ").trim()}`, ...(d.subject ? [`> 제목: ${d.subject.replace(/\s+/g, " ").trim()}`] : []), ">"];
	const options = [
		{ name: DRAFT_SEND, result: d.sendResult ?? `${d.to.replace(/\s+/g, " ").trim()}에 이 글을 그대로 보내요` },
		{ name: DRAFT_EDIT, result: "무엇을 고칠지 알려 주면 고쳐서 다시 물어봐요" },
		{ name: DRAFT_DROP, result: "이 초안은 버려요" },
	];
	return [...head, ...quote(d.body.replace(/\r\n?/g, "\n").trim()), issueBlock(`${d.question ?? "보낼까요?"} (${d.ref})`, options)].join("\n");
}

const HEADER = /^(받는이|대상|대화방)\s*[:：]\s*(.*)$/;
const SUBJECT = /^제목\s*[:：]\s*(.*)$/;
const REF = /\(([A-Za-z0-9][A-Za-z0-9_.:-]{1,63})\)\s*$/;

// The draft a message asks approval for; undefined when the message is not a draft-approval decision (one block whose options are exactly
// 보내기 / 고치기 / 보내지 않기, with a quoted draft above it).
export function parseDraftApproval(text: string): DraftApproval | undefined {
	const pc = parseDecisions(text);
	const block = pc.blocks.length === 1 ? pc.blocks[0]! : undefined;
	if (!block || block.options.map(o => o.label).join("|") !== [DRAFT_SEND, DRAFT_EDIT, DRAFT_DROP].join("|")) return undefined;
	let fence = false;
	const quoted: string[] = [];
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		const m = fence ? null : /^\s*>\s?(.*)$/.exec(line);
		if (m) quoted.push(m[1]!);
	}
	if (!quoted.length) return undefined;
	let toLabel = "받는이";
	let to = "";
	let subject: string | undefined;
	let i = 0;
	for (; i < quoted.length; i++) {
		const h = HEADER.exec(quoted[i]!) ?? undefined;
		const s = SUBJECT.exec(quoted[i]!);
		if (h && !to) {
			toLabel = h[1]!;
			to = h[2]!.trim();
		} else if (s && subject === undefined) subject = s[1]!.trim();
		else break;
	}
	const body = quoted.slice(i).join("\n").replace(/^\n+|\s+$/g, "");
	if (!body) return undefined;
	const ref = REF.exec(block.title)?.[1];
	return { toLabel, to, ...(subject ? { subject } : {}), body: body.slice(0, DRAFT_BODY_MAX), ...(ref ? { ref } : {}) };
}

// What a picked label means; anything else (a label outside the three) is not a draft answer.
export function draftActionOf(label: string): DraftAction | undefined {
	return label === DRAFT_SEND ? "send" : label === DRAFT_EDIT ? "edit" : label === DRAFT_DROP ? "drop" : undefined;
}
