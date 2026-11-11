// A session that was paused on a limit or a block ran a turn anyway (the runtime retried by itself, or the owner reset the limit elsewhere): its
// pause is over everywhere, not only in the status word. The caller has already stopped its resume timer. What is left of the pause: the
// saved record (a restart would hold messages again), the limit-pause state (the watch would keep asking), the shown end time, the status.
import { log } from "./config.ts";
import type { limitPauseState } from "./limit-watch.ts";

export function stalePauseEnded(d: { who: string; orch: { status: string; rateLimitedUntil?: string }; lp: ReturnType<typeof limitPauseState>; save: (s: { pausedUntil: undefined; pausedKind: undefined; pausedAuth: undefined }) => void }): void {
	log(`${d.who} a turn ran while a pause was recorded; the pause is over`);
	d.save({ pausedUntil: undefined, pausedKind: undefined, pausedAuth: undefined });
	d.lp.clear();
	d.orch.rateLimitedUntil = "";
	if (d.orch.status === "rate-limited") d.orch.status = "working";
}
