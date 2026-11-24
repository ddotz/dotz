import { items } from "./notices-store.ts";
import { watchLabelOf } from "./notices-wiring.ts";
import { watchCardId, watchSubject } from "./watch-ask.ts";

/** The first quiet time of a failing watch after it told the owner. */
export const FAIL_ALERT_EVERY_MS = 12 * 3600_000;
const GAPS_MS = [FAIL_ALERT_EVERY_MS, 24 * 3600_000, 72 * 3600_000];
const QUIET_MS = GAPS_MS.at(-1)!;

/** The quiet time after the `told`-th failure alert of one episode (1 = the first): 12 hours, 24 hours, then 3 days. */
export const failAlertGapMs = (told = 1): number => GAPS_MS[Math.min(Math.max(told, 1), GAPS_MS.length) - 1]!;

type Alerted = { failAlertAt?: number; failAlerts?: number };
/** The owner was told of the failure now: the next repeat waits the next gap. */
export function markFailAlert(s: Alerted, at = Date.now()): void {
	s.failAlertAt = at;
	s.failAlerts = (s.failAlerts ?? 0) + 1;
}

type Skipped = Alerted & { recoveredAt?: number; skipAt?: number; skipAlerts?: number };

/** When the owner himself answered the issue card of the watch `name` (hub/watch-ask.ts): the card with the id `watches:<name>`, or a card stored
 *  without an id whose title names the watch's label. Undefined while it is open, dismissed or not there, and when it closed without his answer:
 *  expired after its window, or closed by the gateway (`done`, `gone`, settled by a later message). */
export function watchCardAnsweredAt(name: string): number | undefined {
	const id = watchCardId(name), label = watchLabelOf(name);
	const d = items.findLast(n => n.decision?.to === "alert" && (n.decision.card_id === undefined ? watchSubject(n.title) === label : n.decision.card_id === id))?.decision;
	return d?.state === "answered" && !d.resolved && d.answered_at ? Date.parse(d.answered_at) : undefined;
}

const SLOT_SLACK_MS = 3600_000;

/** Whether a skipped release slot is told now. A skipped slot fails only the tick that finds it, so the episode's failAlerts never grow; this
 *  count does: the first skipped slot is told at once, and while the owner has not answered the card since the last tell, the next one waits the
 *  gap after it (failAlertGapMs): 12 hours, 24 hours, then every 3 days. The gap is counted an hour short: the day's slots are 6 or 12 hours apart
 *  and a slot's tick lands seconds to minutes after it, so the slot at the end of a gap is told whether its tick came a little early or late.
 *  The owner's own answer after the last tell, or 3 days without a skipped slot, start the count over. */
export function skipAlertDue(s: Skipped, answeredAt: number | undefined, at = Date.now()): boolean {
	const quiet = s.skipAt !== undefined && at - s.skipAt >= QUIET_MS - SLOT_SLACK_MS;
	if (quiet || (answeredAt !== undefined && s.failAlertAt !== undefined && answeredAt >= s.failAlertAt)) s.skipAlerts = undefined;
	s.skipAt = at;
	return !s.skipAlerts || at - (s.failAlertAt ?? 0) >= failAlertGapMs(s.skipAlerts) - SLOT_SLACK_MS;
}

/** A skipped slot was told now (after markFailAlert): it is no outage to recover from, and the next skipped slot waits one gap longer. */
export function markSkipAlert(s: Skipped): void {
	s.recoveredAt = s.failAlertAt;
	s.skipAlerts = (s.skipAlerts ?? 0) + 1;
}
