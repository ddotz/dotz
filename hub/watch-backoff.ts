/** The first quiet time of a failing watch after it told the owner. */
export const FAIL_ALERT_EVERY_MS = 12 * 3600_000;
const GAPS_MS = [FAIL_ALERT_EVERY_MS, 24 * 3600_000, 72 * 3600_000];

/** The quiet time after the `told`-th failure alert of one episode (1 = the first): 12 hours, 24 hours, then 3 days. */
export const failAlertGapMs = (told = 1): number => GAPS_MS[Math.min(Math.max(told, 1), GAPS_MS.length) - 1]!;

type Alerted = { failAlertAt?: number; failAlerts?: number };
/** The owner was told of the failure now: the next repeat waits the next gap. */
export function markFailAlert(s: Alerted, at = Date.now()): void {
	s.failAlertAt = at;
	s.failAlerts = (s.failAlerts ?? 0) + 1;
}
