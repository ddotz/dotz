// One send-approval card at a time per conversation (owner 2026-10-31, from a user's log of 2026-10-30: 29 comment cards landed in one
// channel within two minutes although she had asked "한 건씩 나한테 보낼지 고칠지 물어봐", and the same card was posted twice).
//
// The assistant's post that is a draft approval (hub/draft-approval.ts parseDraftApproval: one 보내기 / 고치기 / 보내지 않기 block with a
// trailing "(<ref>)") goes through route() before it is shown:
//   - no card waits in that conversation: it is posted (and becomes the visible one);
//   - another card waits there: it is held, and the visible card says "남은 N건"; prose above the card goes out now (splitCardLead);
//   - a card for the same ref is already open (or held): nothing new is posted; a changed text replaces the open card in place.
// When the visible card closes (answered, resolved, ignored: notices.ts onDecisionClosed), the next held card is posted with its own
// "남은 N건". Held cards are kept on disk, so a restart shows them later instead of losing them.
// One item, one card (2026-11-02): a card is keyed by the item it is about (deps.itemOf: the bot's `mail:<id>` card and the app's reply draft of that
// mail are one item). A newer card of an item that has an open or held card replaces it in place (one that waits behind another card is replaced on the
// load/sweep path too), and a held card whose item was handled meanwhile (deps.handled) is dropped instead of being shown.
import { DECISION_HEAD } from "./choices.ts";
import { keepBrief, parseDraftApproval, withRecipientMark } from "./draft-approval.ts";
import { readState } from "./statefile.ts";
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
	/** The item a card is about (default: its ref): cards of one item never wait behind each other. */
	itemOf?: (conv: string, ref: string) => string;
	/** Whether the item behind a ref was handled elsewhere (sent, dropped, answered by the owner himself): such a held card is dropped, never shown. */
	handled?: (ref: string, conv: string) => boolean | Promise<boolean>;
};

/** The closed form of a send-approval card on Discord: its first line kept, then how it ended (the buttons are removed by the caller). */
export function closedCardText(text: string, how: "answered" | "resolved" | "ignored", label = ""): string {
	const first = (parseTone(stripHandoff(text)).text.trim().split("\n", 1)[0] ?? "").trim();
	const note = how === "resolved" ? "-# 다른 곳에서 처리됐어요" : `-# 처리됨: ${label.replace(/\s+/g, " ").trim().slice(0, 80) || (how === "ignored" ? "무시" : "답변")}`;
	return first ? `${first}\n${note}` : note;
}

/** A send-approval card's text with its send state as the last line (Discord shows it in place): the undo window, sending, or why it did not go. */
export function withSendState(text: string, state: string, why = "", left = 0): string {
	const line = state === "undo" ? `-# ${Math.max(1, Math.ceil(left / 1000))}초 후 보내요. 되돌리려면 웹앱 답장 대기에서 되돌리기` : state === "queued" || state === "sending" ? "-# 보내는 중" : state === "failed" ? `-# 보내지 못했어요${why ? ` - ${why.split("\n", 1)[0]!.slice(0, 160)}` : ""}` : state === "unsure" ? "-# 보냈는지 확인되지 않았어요. 자동으로 다시 보내지 않아요" : "";
	const base = text.replace(/\n-# (?:\d+초 후 보내요|보내는 중|보내지 못했어요|보냈는지 확인되지 않았어요)[^\n]*$/, "");
	return line ? `${base.replace(/\s+$/, "")}\n${line}` : base;
}

/** The draft ref a post asks approval for, or undefined when it is no send-approval card. */
export function cardRef(text: string): string | undefined {
	return parseDraftApproval(parseTone(stripHandoff(text)).text.trim())?.ref;
}

/**
 * One post that asks about several drafts: one post per draft, so each is a real card (a draft, its own notice, its turn in the queue) instead of one
 * message the queue does not know. Undefined unless every part is a draft approval with a ref of its own.
 */
export function splitDraftCards(text: string): string[] | undefined {
	const lines = text.split("\n");
	const starts: number[] = [];
	let fence = false, decided = false;
	lines.forEach((line, i) => {
		if (/^\s*```/.test(line)) fence = !fence;
		else if (!fence && /^\s*>/.test(line) && (!starts.length || decided)) {
			starts.push(i);
			decided = false;
		} else if (!fence && DECISION_HEAD.test(line)) decided = true;
	});
	if (starts.length < 2) return undefined;
	const lead = lines.slice(0, starts[0]).join("\n").trim() || "[ask] 답장 초안이에요";
	const head = lead.includes("\n") ? "[ask] 답장 초안이에요" : lead;
	const cards = starts.map((from, i) => `${i ? head : lead}\n${lines.slice(from, starts[i + 1]).join("\n").trim()}`);
	const refs = cards.map(cardRef);
	return refs.every(Boolean) && new Set(refs).size === refs.length ? cards : undefined;
}

/**
 * A post whose answer comes before its card: the prose, and the card from its head paragraph (or a later `[ask]` line) down. Only the card
 * may wait; held whole, the answer went with it (2026-11-04 13:33 UTC: a 2,296-char report "롱폼 공개됐어" stayed held behind a card
 * open since 09:21, and the owner saw no reply). Undefined when the post is the card alone.
 */
export function splitCardLead(text: string): { lead: string; card: string } | undefined {
	const lines = text.split("\n");
	let fence = false, quote = -1;
	for (let i = 0; i < lines.length && quote < 0; i++) {
		if (/^\s*```/.test(lines[i]!)) fence = !fence;
		else if (!fence && /^\s*>/.test(lines[i]!)) quote = i;
	}
	if (quote < 0) return undefined;
	let head = quote;
	while (head > 0 && !lines[head - 1]!.trim()) head--;
	while (head > 0 && lines[head - 1]!.trim()) head--;
	const ask = lines.findIndex((l, i) => i > 0 && i < quote && /^\s*\[ask\]/i.test(l));
	if (ask > 0) head = ask;
	const lead = lines.slice(0, head).join("\n").trim();
	if (!lead) return undefined;
	const rest = lines.slice(head).join("\n");
	// The ask belongs to the card: a lead that kept the tag would read as a question without buttons.
	const asked = /^\s*\[ask\]\s*/i;
	const split = asked.test(lead) ? { lead: lead.replace(asked, ""), card: asked.test(rest) ? rest : `[ask] ${rest}` } : { lead, card: rest };
	return split.lead && cardRef(split.card) === cardRef(text) ? split : undefined;
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
	const itemOf = (conv: string, ref: string) => deps.itemOf?.(conv, ref) ?? ref;
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
		const item = itemOf(conv, ref);
		const parts = splitCardLead(text);
		const h = held.find(x => itemOf(conv, x.ref) === item && deps.convOf(x.target) === conv);
		if (h) {
			if (h.ref !== ref) Object.assign(h, { ref, target, extra });
			h.text = keepBrief(h.text, parts?.card ?? text);
			save();
			deps.log(`approval card ${ref} in ${conv} is already held (as one item); its text is replaced`);
			return parts ? { action: "post", text: parts.lead } : { action: "same" };
		}
		const s = shown.get(conv);
		// A card still on its way (no notice yet) cannot be rewritten into another ref: that newer card waits like any other.
		const sameShown = !!s && itemOf(conv, s.ref) === item && waiting(conv) && !(s.pending && s.ref !== ref);
		const openRef = deps.openRefs(conv).find(r => itemOf(conv, r) === item);
		if (sameShown || openRef !== undefined) {
			const now = marked(conv, text);
			if (sameShown && s!.ref === ref && withLeft(s!.text, 0) === withLeft(text, 0)) return { action: "same" };
			// The card as it was out (its old ref finds the open notice), then the shown card follows the newer ref.
			const at = sameShown ? { ...s! } : { ref: openRef!, target };
			if (sameShown) Object.assign(s!, { ref, text: now });
			deps.rewrite(conv, at, now);
			deps.log(`approval card ${ref} in ${conv} is open (${at.ref}); the new text replaces it instead of a second post`);
			return { action: "update" };
		}
		if (waiting(conv) || deps.openRefs(conv).length) {
			held.push({ ref, target, text: parts?.card ?? text, extra });
			save();
			const left = heldIn(conv).length;
			deps.log(`approval card ${ref} in ${conv} held: ${left} wait behind the open one`);
			recount(conv);
			return parts ? { action: "post", text: parts.lead } : { action: "hold", left };
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
		const r = release(conv);
		if (r instanceof Promise) r.catch(e => deps.log(`approval queue release in ${conv} failed: ${e}`));
	}

	// Held cards drop out of the queue with a log line each; the open card's count follows.
	function drop(conv: string, cards: Held[], why: string): void {
		if (!cards.length) return;
		held = held.filter(h => !cards.includes(h));
		save();
		for (const c of cards) deps.log(`approval card ${c.ref} in ${conv} dropped from the queue: ${why}`);
		recount(conv);
	}
	const heldConvs = () => [...new Set(held.map(h => deps.convOf(h.target)))];
	/**
	 * Held cards that no longer need a post of their own: all but the newest of one item, and a card whose item already has an open card, which
	 * replaces that open card in place with its text (as route() does) so the newest card always wins (2026-11-02: a dropped newer card left the
	 * bot's `mail:<id>` card open over the app's reply draft of the same mail, and the draft's staged files with it).
	 */
	function dropRedundant(): void {
		for (const conv of heldConvs()) {
			const list = heldIn(conv);
			const older = list.filter((h, i) => {
				const newer = list.find((o, j) => j > i && itemOf(conv, o.ref) === itemOf(conv, h.ref));
				if (newer) newer.text = keepBrief(h.text, newer.text);
				return !!newer;
			});
			drop(conv, older, "a newer card of the same item is held");
			for (const h of heldIn(conv)) {
				const item = itemOf(conv, h.ref);
				const s = shown.get(conv);
				// A card still on its way (no notice yet) cannot be rewritten into another ref: the held card waits, as route() holds it.
				if (s?.pending && itemOf(conv, s.ref) === item) continue;
				const sameShown = !!s && waiting(conv) && itemOf(conv, s.ref) === item;
				const openRef = deps.openRefs(conv).find(r => itemOf(conv, r) === item);
				if (!sameShown && openRef === undefined) continue;
				// The held card is newer than the open one: the open card shows its text, and the shown card follows its ref (as in route()).
				held = held.filter(x => x !== h);
				save();
				const now = marked(conv, h.text);
				const at = sameShown ? { ...s! } : { ref: openRef!, target: h.target };
				if (sameShown) Object.assign(s!, { ref: h.ref, target: h.target, text: now });
				deps.rewrite(conv, at, now);
				deps.log(`approval card ${h.ref} in ${conv} replaces the open card ${at.ref} (same item)`);
				recount(conv);
			}
		}
	}
	/** Held cards whose item was handled elsewhere meanwhile. */
	async function dropHandled(): Promise<void> {
		for (const conv of heldConvs()) {
			const gone: Held[] = [];
			for (const h of heldIn(conv)) if (await Promise.resolve(deps.handled?.(h.ref, conv)).catch(() => false)) gone.push(h);
			drop(conv, gone, "its item was handled elsewhere");
		}
	}
	/** Drops what no longer needs asking: duplicates and handled items. Running it twice changes nothing the second time. */
	const purge = async (): Promise<void> => {
		dropRedundant();
		await dropHandled();
	};

	// Async only when `handled` is (a Kakao room is read from its database); without it the release is as synchronous as it was.
	function release(conv: string): void | Promise<void> {
		if (waiting(conv) || deps.openRefs(conv).length) return;
		const next = heldIn(conv)[0];
		if (!next) return;
		const h = deps.handled?.(next.ref, conv);
		if (h instanceof Promise) return h.catch(() => false).then(v => show(conv, next, v));
		return show(conv, next, h === true);
	}

	function show(conv: string, next: Held, handled: boolean): void | Promise<void> {
		// The queue moved while the answer was awaited: look again.
		if (!held.includes(next)) return release(conv);
		if (waiting(conv) || deps.openRefs(conv).length) return;
		if (handled) {
			drop(conv, [next], "its item was handled elsewhere");
			return release(conv);
		}
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
	const releaseAll = (): void | Promise<void> => {
		const go = () => {
			const rest = heldConvs().map(release).filter((r): r is Promise<void> => !!r);
			return rest.length ? Promise.all(rest).then(() => undefined) : undefined;
		};
		if (deps.handled) return purge().then(go);
		dropRedundant();
		return go();
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

	/** The Discord message ids of the visible card `ref` in `conv`, while this process knows them. */
	const idsOf = (conv: string, ref: string): string[] | undefined => (shown.get(conv)?.ref === ref ? shown.get(conv)!.ids : undefined);

	return { route, posted, closed, releaseAll, purge, take, targetOf, openCard, idsOf, held: () => held.slice(), heldIn };
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
export function loadHeld(file: string, note: (line: string) => void): Held[] {
	const read = readState(file, note);
	const list = read.state === "ok" ? read.value : undefined;
	return Array.isArray(list) ? list.filter(h => h && typeof h.ref === "string" && typeof h.target === "string" && typeof h.text === "string").map(h => ({ ...h, extra: h.extra ?? {} })) : [];
}
