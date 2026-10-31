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
import { parseDraftApproval } from "./draft-approval.ts";
import { parseTone, stripHandoff } from "./tone.ts";

export type Held = { ref: string; target: string; text: string; extra: Record<string, unknown> };
type Shown = { ref: string; target: string; text: string; ids?: string[]; pending?: boolean };
export type Route = { action: "post" } | { action: "hold"; left: number } | { action: "same" } | { action: "update" };

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

const LEFT = /^-# 남은 \d+건$/;
/** The card text with its "남은 N건" line (right under the first line, where a card's notes go), or without it for 0. */
export function withLeft(text: string, left: number): string {
	const lines = text.split("\n").filter(l => !LEFT.test(l.trim()));
	if (left > 0) lines.splice(1, 0, `-# 남은 ${left}건`);
	return lines.join("\n");
}

export function createApprovalQueue(deps: ApprovalQueueDeps) {
	let held: Held[] = deps.load?.() ?? [];
	const shown = new Map<string, Shown>();
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
		const next = withLeft(s.text, heldIn(conv).length);
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
			const now = withLeft(text, heldIn(conv).length);
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
		shown.set(conv, { ref, target, text, pending: true });
		return { action: "post" };
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
		if (s && (!ref || s.ref === ref) && !s.pending) shown.delete(conv);
		release(conv);
	}

	function release(conv: string): void {
		if (waiting(conv) || deps.openRefs(conv).length) return;
		const next = heldIn(conv)[0];
		if (!next) return;
		held = held.filter(h => h !== next);
		save();
		const left = heldIn(conv).length;
		const text = withLeft(next.text, left);
		shown.set(conv, { ref: next.ref, target: next.target, text, pending: true });
		deps.log(`approval card ${next.ref} in ${conv} shown from the queue (${left} left)`);
		deps.post(next.target, text, next.extra);
	}

	/** Every conversation with held cards and nothing open (after a restart). */
	const releaseAll = () => {
		for (const conv of new Set(held.map(h => deps.convOf(h.target)))) release(conv);
	};

	return { route, posted, closed, releaseAll, held: () => held.slice() };
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
