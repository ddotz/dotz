// What an owner's typed chat message asks of an open reply card, and the model's marker lines (the reply intent design, 2026-11-16). Typed chat
// is read by the model in its turn, never by keyword: the one answer code reads itself is the card's own numbered option typed out whole
// ("1) 보내기", "2) 고치기 - <내용>", "3) 보내지 않기", "4) 이대로 보내기"), about the quoted card or the conversation's only open card. The model answers
// the rest with one marker line per card, `[send <ref>]`, `[drop <ref>]` or `[revise <ref>] <change>`: `cardMarkers` reads them out of its post
// and `applyCardMarkers` acts on them. A send only posts a confirm card (its 보내기 is the owner's); a drop or a revise in an answer to the owner is his word.
import { REF_ID } from "./draft-approval.ts";
import type { ActCtx, ActInput, ActResult } from "./reply-actions.ts";
import type { ReplyItem } from "./reply-types.ts";

export type OwnerPick = { act: "send"; asIs?: true } | { act: "drop" } | { act: "revise"; change: string };
export type OwnerIntent = OwnerPick & { ref: string };

const CARD_LINE = { drop: "이 답장은 보내지 않을게요", revise: "고쳐서 카드에 다시 올릴게요" } as const;
const HEAD_CHARS = 40;
/** The start of a draft's text on one line: what a send's gateway line, the confirm card and the model's card note show. */
export function draftHead(text: string): string {
	const chars = [...text.replace(/\s+/g, " ").trim()];
	return chars.length > HEAD_CHARS ? `${chars.slice(0, HEAD_CHARS).join("")}…` : chars.join("");
}
/** The one gateway line after a typed answer acted on a card. A send says who gets what (the recipient and the start of the text) and how long the card can take it back. */
export function cardLine(act: OwnerIntent["act"], item: Pick<ReplyItem, "draft" | "send"> | undefined, now: number): string {
	if (act !== "send") return CARD_LINE[act];
	if (!item) return "보낼게요";
	const left = item.send?.state === "undo" ? Math.max(1, Math.round((item.send.until - now) / 1000)) : 0;
	return `보낼게요 - ${item.draft.toLabel} ${item.draft.to}: "${draftHead(item.draft.text)}"${left ? `. 카드에서 ${left}초 안에 되돌릴 수 있어요` : ""}`;
}

// The card's own options, typed out whole; number and name must agree ("2) 보내기" is no pick), and a 고치기 carries its change.
const OPTION = /^\s*([1-4])\)\s*(보내기|고치기(?:\s*[-:：]\s*(.+?))?|보내지 않기|이대로 보내기)\s*$/s;
const NAMED: Record<string, string> = { "1": "보내기", "3": "보내지 않기", "4": "이대로 보내기" };
/** The card option a message types out whole, or undefined: everything else is the model's to read. */
export function ownerPick(text: string): OwnerPick | undefined {
	const [, n, label, change] = OPTION.exec(text) ?? [];
	if (n === "2") return label?.startsWith("고치기") && change?.trim() ? { act: "revise", change: change.trim() } : undefined;
	if (!n || NAMED[n] !== label) return undefined;
	return n === "3" ? { act: "drop" } : n === "4" ? { act: "send", asIs: true } : { act: "send" };
}

/** What the owner's message asks of an open card of his conversation: a typed option, about the card he quoted or else the only open one; undefined is the model's turn. */
export function ownerIntent(message: { text: string }, o: { cards: { ref: string }[]; quoted?: string }): OwnerIntent | undefined {
	const pick = ownerPick(message.text);
	const ref = o.quoted ? o.cards.find(c => c.ref === o.quoted)?.ref : o.cards.length === 1 ? o.cards[0]!.ref : undefined;
	return pick && ref ? { ...pick, ref } : undefined;
}

export type CardMark = { act: "send" | "drop"; ref: string } | { act: "revise"; ref: string; change: string };
export type CardMarks = { acts: CardMark[]; rest: string; unknown: { verb: string; ref: string; why: string }[] };
const MARK = new RegExp(`^\\s*\\[(send|drop|revise)\\s+(${REF_ID})\\]\\s*(.*?)\\s*$`);
/** The model's marker lines (each one leads its line) for the cards open here, and its post without them. A ref that is not open and a revise with
 * no change act on nothing; two revises for one card are one revise (their changes joined), any other two markers for one card contradict each
 * other and act on nothing; every marker line leaves the post. */
export function cardMarkers(text: string, openRefs: readonly string[]): CardMarks {
	const acts: CardMark[] = [], unknown: CardMarks["unknown"] = [], rest: string[] = [];
	for (const line of text.split("\n")) {
		const [, verb, ref, change] = MARK.exec(line) ?? [];
		if (!verb || !ref) rest.push(line);
		else if (!openRefs.includes(ref)) unknown.push({ verb, ref, why: "not an open card of this conversation" });
		else if (verb === "revise" && !change) unknown.push({ verb, ref, why: "no change" });
		else if (verb === "revise") acts.push({ act: "revise", ref, change: change! });
		else acts.push({ act: verb === "send" ? "send" : "drop", ref });
	}
	const byRef = new Map<string, CardMark[]>();
	for (const a of acts) byRef.set(a.ref, [...(byRef.get(a.ref) ?? []), a]);
	const kept: CardMark[] = [];
	for (const [ref, group] of byRef) {
		const changes = group.flatMap(a => (a.act === "revise" ? [a.change] : []));
		if (group.length === 1) kept.push(group[0]!);
		else if (changes.length === group.length) kept.push({ act: "revise", ref, change: changes.join("; ") });
		else for (const a of group) unknown.push({ verb: a.act, ref, why: TWICE });
	}
	return { acts: kept, rest: rest.join("\n").trim(), unknown };
}

const NOT_FOUND = "보낼 카드를 찾지 못했어요. 카드의 보내기를 눌러 주세요";
const TWICE = "two markers for one card";
const STILL_REVISING = "고치는 중이에요. 고친 카드가 올라오면 거기서 보내기를 눌러 주세요";
const DROP_ON_CARD = "버리기는 카드에서 눌러 주세요";
export type MarkDeps = {
	replies: { act: (input: ActInput, ctx: ActCtx) => Promise<ActResult>; confirm: (input: { ref: string }, ctx: ActCtx) => Promise<ActResult> };
	owner?: { mid: string; text: string };
	mayDrop?: (ref: string) => boolean;
	/** One gateway line in the conversation. */
	tell: (line: string) => Promise<unknown>;
	log: (line: string) => void;
};
/** Acts on the model's markers: `[send]` posts the confirm card (nothing is sent) and only in an answer to the owner's own message; `[revise]` there
 * is his word (a sealed pick naming his message), and `[drop]` too when `mayDrop` says that message is his newest one, written after the card.
 * Anywhere else they are the agent's own: a drop is refused and the session told to have the owner press the card. */
export async function applyCardMarkers(marks: CardMarks, d: MarkDeps): Promise<void> {
	for (const u of marks.unknown) {
		d.log(`card marker ${u.verb} ${u.ref} refused: ${u.why}`);
		if (u.verb === "send" && u.why !== TWICE) await d.tell(NOT_FOUND);
	}
	const clashed = [...new Set(marks.unknown.filter(u => u.why === TWICE).map(u => u.ref))];
	if (clashed.length) await d.tell(`한 카드에 서로 맞지 않는 표시가 겹쳐서 반영하지 않았어요 (${clashed.join(", ")}). 보낼지 고칠지 버릴지 한 번만 알려 주세요`);
	const from = d.owner ? ` for owner msg ${d.owner.mid} "${d.owner.text.replace(/\s+/g, " ").slice(0, 80)}"` : "";
	for (const m of marks.acts) {
		if (m.act === "send" && !d.owner) {
			d.log(`card marker ${m.act} ${m.ref} refused: the post answers no owner message`);
			continue;
		}
		const ctx: ActCtx = d.owner && (m.act !== "drop" || d.mayDrop?.(m.ref) === true) ? { surface: "chat", owner: d.owner } : { surface: "chat", agent: true };
		const asOwner = "owner" in ctx;
		const r = await (m.act === "send" ? d.replies.confirm({ ref: m.ref }, ctx) : d.replies.act(m.act === "revise" ? { ref: m.ref, action: "revise", change: m.change } : { ref: m.ref, action: "drop" }, ctx));
		d.log(`card marker ${m.act} ${m.ref}${from}: ${r.body.ok ? "done" : `refused ${r.body.code}`}`);
		if (!r.body.ok) await d.tell(m.act !== "send" ? `답장 카드에 반영하지 못했어요: ${r.body.error}${m.act === "drop" && r.body.code === "owner_only" ? `. ${DROP_ON_CARD}` : ""}` : r.body.code === "revising" ? STILL_REVISING : r.body.code === "unknown_ref" ? NOT_FOUND : `보낼 수 없어요: ${r.body.error}`);
		else if (m.act !== "send" && asOwner) await d.tell(cardLine(m.act, undefined, Date.now()));
	}
}
