// The owner's stop answers what it found (routes-settings.ts) and says "ended" only once the turn really is no longer working.
import { log } from "./config.ts";

export const STOP_WAIT_MS = 3000;
const STEP_MS = 100;

/** What a stop found in one conversation: a turn running, a request open; working() tells whether the turn has ended since. */
export type StopFound = { running: boolean; request: boolean; working: () => boolean };

/** The one hub.log line per stop: the conversation, what was running, what the stop closed. No message text. */
export function stopFound(key: string, running: boolean, request: boolean, working: () => boolean): StopFound {
	log(`owner stop in ${key}: turn ${running ? "aborted" : "none running"}, request ${request ? "closed" : "none open"}`);
	return { running, request, working };
}

/** Whether the turn ended within `ms`: checked now, then every step; false = it is still working when the wait is over. */
export async function endedWithin(working: () => boolean, ms = STOP_WAIT_MS, step = STEP_MS): Promise<boolean> {
	for (let left = ms; working(); left -= step) {
		if (left <= 0) return false;
		await new Promise(resolve => setTimeout(resolve, step));
	}
	return true;
}

export type StopAnswer = { ok: true; stopped: boolean; ended: boolean };

/** What the page is told: stopped = a turn was running or a request open; ended = no turn is running any more. */
export async function stopAnswer(found: StopFound | undefined): Promise<StopAnswer> {
	if (!found) return { ok: true, stopped: false, ended: true };
	return { ok: true, stopped: found.running || found.request, ended: found.running ? await endedWithin(found.working) : true };
}
