// The options an asking message gets when it holds no choice block (hub/notices.ts decisionsOf, and stored decisions on load), so a
// question on the bell and the 'needs you' list is not left with only "직접 답하기" (2026-10-22: mail-thread and work-channel [ask]s
// such as "감사 답장 한 통만 남았어요. 보내도 될까요?" came without options).
//   a send question with a known draft id  -> 1) 보내기  2) 고치기 …  3) 보내지 않기   (hub/draft-approval.ts labels)
//   any other yes / no question            -> 1) 네  2) 아니요 …
//   an open question (what, which, tell me) -> none: no fixed answer fits, the owner answers in words
import type { DecisionOption } from "./choices.ts";
import { DRAFT_DROP, DRAFT_EDIT, DRAFT_SEND } from "./draft-approval.ts";

const FENCE = /^\s*```/;
// Asks for content, not a yes / no: a question word or a request to tell / choose something.
const OPEN = /어떤|어떻게|어느|무슨|무엇|뭘|뭐|뭔|언제|어디|누구|누가|몇|얼마|왜|알려\s*주|적어\s*주|골라\s*주|정해\s*주|\b(?:which|what|when|where|who|how|why)\b/i;
const SEND = /보내|발송|전송|회신|답장|게시|올릴|올려|\bsend\b|\bpost\b|\breply\b/i;
// The id an approval command takes: "(<ref>)" closing the question, or "초안 id: <ref>" / "draft: <ref>" anywhere in the message.
const REF_END = /\(([A-Za-z0-9][A-Za-z0-9_.:-]{1,63})\)\s*[?？]?\s*$/;
const REF_ANY = /(?:초안|draft)\s*(?:id|ID|번호)?\s*[:：]\s*`?([A-Za-z0-9][A-Za-z0-9_.:-]{1,63})`?/i;

// The last sentence of the message that asks something (ends in "?", or in "까요" / "나요" without one): plain lines only (no code, no
// quoted draft), split at sentence ends.
function lastQuestion(text: string): string | undefined {
	let fence = false;
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		if (FENCE.test(line)) {
			fence = !fence;
			continue;
		}
		if (!fence && !/^\s*>/.test(line)) lines.push(line.replace(/^\s*\[[^\]\n]{1,10}\][ \t]*/, "").replace(/[*_`#]/g, "").trim());
	}
	const sentences = lines.flatMap(l => l.split(/(?<=[.!?？。])\s+/)).map(s => s.trim()).filter(Boolean);
	return sentences.reverse().find(s => /[?？]\s*$/.test(s) || /(?:까요|나요)\s*$/.test(s));
}

// A question about sending something that quotes no draft (no line starting with ">"): the owner cannot decide on it alone.
export function asksSendWithoutDraft(text: string): boolean {
	const q = lastQuestion(text);
	return !!q && !OPEN.test(q) && SEND.test(q) && !/^\s*>/m.test(text);
}

export function askDefaults(text: string): DecisionOption[] {
	const q = lastQuestion(text);
	if (!q || OPEN.test(q)) return [];
	const ref = SEND.test(q) ? (REF_END.exec(q) ?? REF_ANY.exec(text))?.[1] : undefined;
	if (ref)
		return [
			{ n: 1, label: DRAFT_SEND, desc: "그대로 보내요", rec: true },
			{ n: 2, label: DRAFT_EDIT, desc: "무엇을 고칠지 알려 주면 고쳐서 다시 물어봐요", rec: false, detail: true },
			{ n: 3, label: DRAFT_DROP, desc: "보내지 않아요", rec: false },
		];
	return [
		{ n: 1, label: "네", desc: "", rec: true },
		{ n: 2, label: "아니요", desc: "", rec: false, detail: true },
	];
}
