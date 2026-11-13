// What an owner's typed chat message asks of an open reply card, read by code before any model turn (the reply unification design, 3.2):
// send, drop or revise, or nothing. Pure: no I/O. The card a message is about is the one it quotes, else the conversation's only open draft
// card when that card is also the newest there; with two open cards and no quote it is about none of them. The model's fallback is one marker
// line, `[revise <ref>] <change>`, which `reviseMarker` reads out of its post.
import { textVerdict } from "./draft-approval.ts";

export type OpenCard = { ref: string; newest?: boolean };
export type OwnerIntent = { act: "send" | "drop"; ref: string } | { act: "revise"; ref: string; change: string };

const MAX_REVISE = 500;
const EXPLICIT = /^\s*(?:2\)\s*)?고치기\s*[-:：]\s*(.+)$/s;
const VERBS = ["바꿔", "바꾸", "고쳐", "고치", "수정", "빼", "삭제", "지워", "추가", "넣어", "붙여", "줄여", "늘려", "다시 써", "다듬"];
const MANNER = ["짧게", "길게", "간단하게", "간결하게", "자세하게", "공손하게", "정중하게", "부드럽게", "친근하게", "가볍게", "단호하게"];
const STYLE = /(?:말투|톤|존댓말|반말|이모지|인사|서명)(?:은|는|이|가|을|를|도|로|으로)/;
// A request addressed to the assistant, not a change to the draft ("19번 카드 열어", "확인해줘").
const COMMAND = /^\s*(?:\/|!)|(?:열어|보여|찾아|알려|확인해)\s*(?:줘|주세요|봐)?\s*[.!]?\s*$/;

/** A free-text change to a draft: not a question or a command, short, and with a change cue (a verb, a manner word or a style noun with a particle). */
export function textRevise(text: string): string | undefined {
	const t = text.trim();
	if (!t || [...t].length > MAX_REVISE || /[?？]/.test(t) || COMMAND.test(t)) return undefined;
	const cue = VERBS.some(v => t.includes(v)) || MANNER.some(m => t.includes(m)) || STYLE.test(t);
	return cue ? t : undefined;
}

/** The card a message is about: its quote, else the one open card when it is the newest. */
function targetOf(cards: OpenCard[], quoted?: string): string | undefined {
	if (quoted) return cards.some(c => c.ref === quoted) ? quoted : undefined;
	return cards.length === 1 && cards[0]!.newest ? cards[0]!.ref : undefined;
}

/** What the owner's message asks of an open card, or undefined for an ordinary chat turn. */
export function ownerIntent(message: { text: string }, o: { cards: OpenCard[]; quoted?: string }): OwnerIntent | undefined {
	const ref = targetOf(o.cards, o.quoted);
	if (!ref) return undefined;
	const said = textVerdict(message.text);
	if (said) return { act: said, ref };
	const explicit = EXPLICIT.exec(message.text)?.[1]?.trim();
	if (explicit) return { act: "revise", ref, change: explicit };
	const change = textRevise(message.text);
	return change ? { act: "revise", ref, change } : undefined;
}

/** The model's one revise line for an open card, and its post without that line; a ref that is not open is left as it is. */
export function reviseMarker(text: string, openRefs: readonly string[]): { ref: string; change: string; rest: string } | undefined {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^\s*\[revise\s+([A-Za-z0-9]{2,16})\]\s*(.+?)\s*$/.exec(lines[i]!);
		if (!m || !openRefs.includes(m[1]!)) continue;
		return { ref: m[1]!, change: m[2]!, rest: [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim() };
	}
	return undefined;
}
