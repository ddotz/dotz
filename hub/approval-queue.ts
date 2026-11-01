// One send-approval card at a time per conversation (owner 2026-10-31, from a user's log of 2026-10-30: 29 comment cards landed in one
// channel within two minutes although she had asked "한 건씩 나한테 보낼지 고칠지 물어봐", and the same card was posted twice).
//
// The assistant's post that is a draft approval (hub/draft-approval.ts parseDraftApproval: one 보내기 / 고치기 / 보내지 않기 block with a
// trailing "(<ref>)") goes through route() before it is shown:
//   - no card waits in that conversation: it is posted (and becomes the visible one);
//   - another card waits there: it is held, and the visible card says "남은 N건";
//   - a card for the same ref is already open (or held): nothing new is posted; a changed text replaces the open card in place.
// When the visible card closes (answered, resolved, ignored: notices.ts onDecisionClosed), the next held card is posted with its own
// "남은 N건". Held cards are kept on disk, so a restart shows them later instead of losing them.
import { existsSync, readFileSync } from "node:fs";
import { parseDraftApproval, withRecipientMark } from "./draft-approval.ts";
import { parseTone, stripHandoff } from "./tone.ts";

export type Held = { ref: string; target: string; text: string; extra: Record<string, unknown> };
type Shown = { ref: string; target: string; text: string; ids?: string[]; pending?: boolean };
// `text`: the card as it goes out, with its progress line ("남은 N건 (k/T)" / "마지막 카드예요"), when that differs from what was routed.
export type Route = { action: "post"; text?: string } | { action: "hold"; left: number } | { action: "same" } | { action: "update" };

export type ApprovalQueueDeps = {
	/** The conversation a target's posts belong to (notices.ts decision.to). */
	convOf: (target: string) => string;
	/** The refs of the send-approval cards still open in that conversation. */
	openRefs: (conv: string) => string[];
	/** Posts a held card (back through outbound.out, marked so it is not routed again). */
	post: (target: string, text: string, extra: Record<string, unknown>) => void;
	/** Shows a new text on a card already out: the open notice and, when known, its Discord message. */
	rewrite: (conv: string, shown: { ref: string; target: string; ids?: string[] }, text: string) => void;
	persist: (held: Held[]) => void;
	log: (line: string) => void;
	/** What a previous process left held. */
	load?: () => Held[];
};

/** The draft ref a post asks approval for, or undefined when it is no send-approval card. */
export function cardRef(text: string): string | undefined {
	return parseDraftApproval(parseTone(stripHandoff(text)).text.trim())?.ref;
}

const LEFT = /^-# (?:남은 \d+건(?: \(\d+\/\d+\))?|마지막 카드예요(?: \(\d+\/\d+\))?)$/;
export type CardPos = { k: number; total: number };
/**
 * The card text with its progress line right under the first line (where a card's notes go): "남은 N건 (k/T)" while cards wait behind it,
 * "마지막 카드예요 (T/T)" on the last one of a run of several, nothing for a lone card. Without `pos` only the count: "남은 N건", none for 0.
 */
export function withLeft(text: string, left: number, pos?: CardPos): string {
	const lines = text.split("\n").filter(l => !LEFT.test(l.trim()));
	const line = pos && pos.total > 1 ? (left > 0 ? `-# 남은 ${left}건 (${pos.k}/${pos.total})` : `-# 마지막 카드예요 (${pos.total}/${pos.total})`) : left > 0 ? `-# 남은 ${left}건` : "";
	if (line) lines.splice(1, 0, line);
	return lines.join("\n");
}

// "(19/28)": the bot numbering the cards of one batch it asks one by one in its first line (2026-10-31: a user's 28 comment cards were
// posted one per turn, so none was ever held and the queue alone could not count them).
const NUMBERED = /\((\d{1,4})\s*\/\s*(\d{1,4})\)/;
export function numberedOf(text: string): CardPos | undefined {
	const m = NUMBERED.exec(text.split("\n", 1)[0] ?? "");
	const k = Number(m?.[1]), total = Number(m?.[2]);
	return m && k >= 1 && k <= total ? { k, total } : undefined;
}

/** The card's first line without its tone tag: what a pointer to it or the bot's list of waiting cards names it by. */
export const cardTitle = (text: string): string => (parseTone(stripHandoff(text)).text.trim().split("\n", 1)[0] ?? "").replace(/\s+/g, " ").slice(0, 120);

export function createApprovalQueue(deps: ApprovalQueueDeps) {
	let held: Held[] = deps.load?.() ?? [];
	const shown = new Map<string, Shown>();
	// The place of the shown card in its conversation's current run of cards (1 = the first shown since nothing waited there).
	const place = new Map<string, number>();
	// Where a card stands: the bot's own numbering when it gives one (never fewer than what the queue holds), else the queue's run.
	const progress = (conv: string, text: string): { left: number; pos: CardPos } => {
		const h = heldIn(conv).length, n = numberedOf(text);
		if (n) {
			const total = Math.max(n.total, n.k + h);
			return { left: total - n.k, pos: { k: n.k, total } };
		}
		const k = place.get(conv) ?? 1;
		return { left: h, pos: { k, total: k + h } };
	};
	const marked = (conv: string, text: string) => {
		const p = progress(conv, text);
		return withRecipientMark(withLeft(text, p.left, p.pos));
	};
	const save = () => deps.persist(held.slice());
	const heldIn = (conv: string) => held.filter(h => deps.convOf(h.target) === conv);
	// The visible card still waits: posted and open, or on its way out (a post being localized has no notice yet).
	const waiting = (conv: string) => {
		const s = shown.get(conv);
		return !!s && (s.pending || deps.openRefs(conv).includes(s.ref));
	};
	// The visible card's "남은 N건" follows the number held behind it.
	const recount = (conv: string) => {
		const s = shown.get(conv);
		if (!s || s.pending || !deps.openRefs(conv).includes(s.ref)) return;
		const next = marked(conv, s.text);
		if (next === s.text) return;
		s.text = next;
		deps.rewrite(conv, s, next);
	};

	function route(target: string, text: string, extra: Record<string, unknown> = {}): Route {
		const ref = cardRef(text);
		if (!ref) return { action: "post" };
		const conv = deps.convOf(target);
		const h = held.find(x => x.ref === ref && deps.convOf(x.target) === conv);
		if (h) {
			h.text = text;
			save();
			deps.log(`approval card ${ref} in ${conv} is already held; its text is replaced`);
			return { action: "same" };
		}
		const s = shown.get(conv);
		if ((s && s.ref === ref && waiting(conv)) || deps.openRefs(conv).includes(ref)) {
			const now = marked(conv, text);
			if (s && s.ref === ref && withLeft(s.text, 0) === withLeft(text, 0)) return { action: "same" };
			const at = s && s.ref === ref ? s : { ref, target };
			if (s && s.ref === ref) s.text = now;
			deps.rewrite(conv, at, now);
			deps.log(`approval card ${ref} in ${conv} is open; the new text replaces it instead of a second post`);
			return { action: "update" };
		}
		if (waiting(conv) || deps.openRefs(conv).length) {
			held.push({ ref, target, text, extra });
			save();
			const left = heldIn(conv).length;
			deps.log(`approval card ${ref} in ${conv} held: ${left} wait behind the open one`);
			recount(conv);
			return { action: "hold", left };
		}
		// Nothing waits here: a new run of cards starts with this one.
		place.set(conv, 1);
		const out = marked(conv, text);
		shown.set(conv, { ref, target, text: out, pending: true });
		return out === text ? { action: "post" } : { action: "post", text: out };
	}

	/** The card route() let through is out (with its Discord message ids when it went there). */
	function posted(target: string, text: string, ids?: string[]): void {
		const ref = cardRef(text);
		const conv = deps.convOf(target);
		const s = shown.get(conv);
		if (!ref || !s || s.ref !== ref) return;
		shown.set(conv, { ref, target, text, ...(ids?.length ? { ids } : {}) });
		recount(conv);
	}

	/** A decision closed in `conv`: when no card waits there any more, the next held one goes out. */
	function closed(conv: string, ref?: string): void {
		const s = shown.get(conv);
		// The shown card itself closed, even one whose post has not finished yet (the owner can answer as soon as it shows).
		if (s && (ref ? s.ref === ref : !s.pending)) shown.delete(conv);
		release(conv);
	}

	function release(conv: string): void {
		if (waiting(conv) || deps.openRefs(conv).length) return;
		const next = heldIn(conv)[0];
		if (!next) return;
		held = held.filter(h => h !== next);
		save();
		const left = heldIn(conv).length;
		// After a restart the first card shown is the first of its run.
		place.set(conv, place.has(conv) ? place.get(conv)! + 1 : 1);
		const text = marked(conv, next.text);
		shown.set(conv, { ref: next.ref, target: next.target, text, pending: true });
		deps.log(`approval card ${next.ref} in ${conv} shown from the queue (${left} left)`);
		deps.post(next.target, text, next.extra);
	}

	/** Every conversation with held cards and nothing open (after a restart). */
	const releaseAll = () => {
		for (const conv of new Set(held.map(h => deps.convOf(h.target)))) release(conv);
	};

	/** Answered without being shown (the web's batch review, hub/approval-batch.ts): these held cards leave the queue, and the open card's count follows. */
	function take(conv: string, refs: string[]): void {
		const before = held.length;
		held = held.filter(h => !(refs.includes(h.ref) && deps.convOf(h.target) === conv));
		if (held.length === before) return;
		save();
		deps.log(`approval cards ${refs.join(", ")} in ${conv} answered from the batch review`);
		recount(conv);
		release(conv);
	}

	/** The target the card of `ref` in `conv` was (or will be) posted to. */
	const targetOf = (conv: string, ref: string): string | undefined => {
		const s = shown.get(conv);
		return s?.ref === ref ? s.target : heldIn(conv).find(h => h.ref === ref)?.target ?? s?.target;
	};

	/**
	 * The card that waits for the owner in `conv`, as the bot's turn and a later post name it: title, progress line, where it is (Discord
	 * message ids) and how many wait behind it; undefined when none is open there.
	 */
	function openCard(conv: string): { ref: string; target: string; title: string; progress: string; ids?: string[]; held: number } | undefined {
		const s = shown.get(conv);
		if (!s || s.pending || !deps.openRefs(conv).includes(s.ref)) return undefined;
		const p = progress(conv, s.text);
		const line = withLeft("x", p.left, p.pos).split("\n")[1]?.replace(/^-# /, "") ?? "";
		return { ref: s.ref, target: s.target, title: cardTitle(s.text), progress: line, ...(s.ids ? { ids: s.ids } : {}), held: heldIn(conv).length };
	}

	return { route, posted, closed, releaseAll, take, targetOf, openCard, held: () => held.slice(), heldIn };
}

/** The line a later post in the conversation ends with while a card waits above it. */
export function cardPointer(c: { title: string; progress: string }, link?: string): string {
	return `-# ↑ 답을 기다리는 카드: ${c.title.replace(/^\[\w+\]\s*/, "")}${c.progress ? ` · ${c.progress}` : ""}${link ? ` · [카드로 가기](${link})` : ""}`;
}

export const CARDS_LEAD = "[pending cards]";
export type PendingCard = { ref: string; title: string; notice: string; progress?: string; link?: string };
/**
 * The note an owner message to the bot starts with while send-approval cards wait in its conversation: each open card with where it is,
 * and how many are held behind it. Undefined when none waits.
 */
export function pendingCardsNote(cards: PendingCard[], held: number): string | undefined {
	if (!cards.length && !held) return undefined;
	const rows = cards.map(c => `- ${c.title} (${c.ref})${c.progress ? ` · ${c.progress}` : ""} · ${c.link ? `Discord: ${c.link}` : `web: /?n=${c.notice}`}`);
	return [
		`${CARDS_LEAD} Send-approval cards waiting for the owner's answer in this conversation (the gateway's list, current as of this message):`,
		...rows,
		...(held ? [`- ${held} more held by the gateway; each is posted by itself as soon as the open card is answered.`] : []),
		"If the owner asks where a card is, answer with this list and its link instead of posting the card again. When you ask a numbered batch one card at a time, post the next card in the same turn the previous one is answered.",
	].join("\n");
}

/** The held cards a previous process wrote. */
export function loadHeld(file: string): Held[] {
	try {
		if (!existsSync(file)) return [];
		const list = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(list) ? list.filter(h => h && typeof h.ref === "string" && typeof h.target === "string" && typeof h.text === "string").map(h => ({ ...h, extra: h.extra ?? {} })) : [];
	} catch {
		return [];
	}
}
