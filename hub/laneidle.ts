// Idle lanes cost memory for nothing: a lane waiting on the owner kept its senpi (~600 MB) and claude child (~400 MB) alive
// for hours, and every gateway restart respawned it (measured 2026-10-21). A lane idle for lanes.idle_stop_min minutes
// (no turn, no task worker; default 20, 0 = never) has its process stopped. Its session file stays, so the next message
// resumes the same conversation (sendToLane -> resumeLane); the cost is the process start paid by that first message only
// (0.3-0.4 s to the first rpc frame without extensions, measured 2026-10-21).
// The prompt cache is the server's and does not care about the process: three kill + --session resumes of a throwaway omo
// session (haiku, anthropic-subscription) read back exactly the prefix the killed process had written (first resumed turn
// cacheRead 25698 = 25503 read + 195 written before the kill; 25744 = 25503 + 241; 27853 = 27416 + 437), also after a 5 min 33 s
// gap (25662 = 25353 + 309). That path kept the cache past 5 min with PI_CACHE_RETENTION unset as well as "long", i.e. the
// 1 h TTL, so a lane stopped at 20 min and resumed within the hour still reads its cache; after the TTL the miss is the same
// whether the process lived or not. Notes: /tmp/dz-qa/dyn-limits/notes.md.
import { lanesIdleStopMin, log } from "./config.ts";
import { type Lane, laneBusy, lanes, parkLane } from "./lanes.ts";
import { trackTimer } from "./shutdown.ts";

export const CHECK_MS = 60_000;

// Pure decision: an idle lane with a session, nothing running for it, quiet for at least `minutes`.
export function shouldPark(lane: Pick<Lane, "status" | "proc" | "revive" | "sessionFile" | "lastFrameAt" | "name">, busy: boolean, minutes: number, now: number): boolean {
	if (minutes <= 0 || !lane.proc || lane.status !== "idle" || lane.revive || !lane.sessionFile || busy) return false;
	return now - (lane.lastFrameAt ?? now) >= minutes * 60_000;
}

export function parkIdleLanes(now = Date.now(), minutes = lanesIdleStopMin()): string[] {
	const parked: string[] = [];
	for (const lane of lanes.values()) {
		if (shouldPark(lane, laneBusy(lane), minutes, now) && parkLane(lane)) {
			parked.push(lane.name);
			log(`lane ${lane.name} idle for ${minutes}+ min: process stopped to free memory, the next message resumes ${lane.sessionFile}`);
		}
	}
	return parked;
}

export function startLaneIdleStop(): void {
	if (lanesIdleStopMin() <= 0) return;
	const timer = setInterval(() => parkIdleLanes(), CHECK_MS);
	timer.unref();
	trackTimer("lane idle stop", timer);
}
