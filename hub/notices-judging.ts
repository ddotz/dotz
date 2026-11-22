import { now } from "./config.ts";
import type { HubEvent } from "./events.ts";
import { broadcast } from "./notices-read.ts";
import { hasChoice, isOpenDecision, laterOn, wordsOf } from "./notices-rules.ts";
import { items, save, unreadCount } from "./notices-store.ts";
import type { Notice, OwnerSaid } from "./notices-types.ts";

/** `updated` tells, after the turn the question was listed for, whether anything touched it since (hub/ask-followup.ts). */
export type ListedChoice = { id: string; title: string; updated: string };
const TITLE_MAX = 60;
/** The choice questions still open in conversation `target`, newest first, titles cut to TITLE_MAX: what the bot is told with the owner's next message there. A card put off until later is not one. */
export function openChoices(target: string, max = 3): ListedChoice[] {
	return items
		.filter(i => isOpenDecision(i) && hasChoice(i) && !i.decision!.draft && i.decision!.to === target && !laterOn(i.decision))
		.sort((a, b) => b.updated.localeCompare(a.updated))
		.slice(0, max)
		.map(i => ({ id: i.id, title: i.title.slice(0, TITLE_MAX), updated: i.updated }));
}
/** Of `listed`, the questions still open and untouched since: nothing answered, resolved, ignored or asked them again. */
export const untouchedChoices = (listed: readonly ListedChoice[]): ListedChoice[] => listed.filter(q => items.some(i => i.id === q.id && i.updated === q.updated && isOpenDecision(i)));

/** The longest an owner message shows as being judged: its turn and the one follow-up turn (hub/ask-followup.ts) end well within it, and one that never ends is cut here (sweepJudging). */
export const JUDGING_MS = 30 * 60_000;

function announce(hit: Notice[]): void {
	if (!hit.length) return;
	save();
	const unread = unreadCount();
	for (const n of hit) broadcast({ ts: now(), kind: "notice", source: "gateway", item: n, unread });
}

/** The owner message `said` went to the model with `listed` as the open questions it may answer: each card still open shows it is being judged. */
export function markJudging(listed: readonly ListedChoice[], said: OwnerSaid): void {
	const ids = new Set(listed.map(q => q.id));
	const hit = items.filter(i => ids.has(i.id) && isOpenDecision(i));
	for (const n of hit) {
		n.decision!.judging = { at: said.ts, text: wordsOf(said.text) };
		delete n.decision!.kept_open;
	}
	announce(hit);
}

/** The judging of every open card `pick` accepts is over without an answer: it stays open, marked kept_open with the owner message's ts. */
export function keepOpen(pick: (n: Notice) => boolean): number {
	const hit = items.filter(i => isOpenDecision(i) && i.decision!.judging && pick(i));
	for (const n of hit) {
		n.decision!.kept_open = { at: n.decision!.judging!.at };
		delete n.decision!.judging;
	}
	announce(hit);
	return hit.length;
}

/** A judging older than JUDGING_MS: its turn never settled (a restart, a turn cut short), so the card is kept open. */
export const sweepJudging = (at = now()): number => keepOpen(n => Date.parse(at) - Date.parse(n.decision!.judging!.at) >= JUDGING_MS);

/** A session's turn-end report: the owner message it took in with the session's open questions is judged, and what its turn did not close stays open. */
export function laneTurnEnded(e: HubEvent): void {
	if (e.kind !== "lane_report" || typeof e.lane !== "string" || !e.lane) return;
	const to = `lane:${e.lane}`;
	keepOpen(n => n.decision!.to === to && n.decision!.judging!.at < e.ts);
}
