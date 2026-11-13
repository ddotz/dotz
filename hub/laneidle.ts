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
// The stop ends the lane's task workers and their background runs with it, and a worker blocking on a long wait writes nothing, so past
// the stall window (bgwork.ts) it stops counting as running: reply-voice's worker st_01a1abe7 began a 1700 s wait at 23:10:16 KST
// on 2026-11-05, read as stalled at 23:25:16, and the stop at 23:25:23 cut off an eval whose items were still landing at 23:25:21, with
// no word to anyone. A silent worker or an awaited shell now holds the stop for as long as it lives, which costs memory only (no turn);
// parkLane refuses them whoever asks. Past JOB_BOUND_MIN the owner is told once what is keeping ~1 GB up, the choice being his: the
// longest silence of 224 workers over 7 days was that 28.5 min wait, and the longest wait of a lane on its own shell over 10 days 72.6
// min. A worker stopped on a provider error holds it too: note-merge was stopped at 12:00 KST on 2026-11-06 with st_01a1aea0 on three
// stream timeouts, its worker lost. A lane stopped with its plan open is the resume sweep's (laneresume.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lanesIdleStopMin, log } from "./config.ts";
import { waitsOnMain } from "./forline.ts";
import { msg } from "./i18n.ts";
import { type Lane, laneBusy, laneJobs, lanes, parkLane } from "./lanes.ts";
import { dir, hooks } from "./lanestate.ts";
import { parseTone } from "./tone.ts";
import { trackTimer } from "./shutdown.ts";

export const CHECK_MS = 60_000;
const JOB_BOUND_MIN = 120;
// Lanes whose hold is already in the log.
const held = new Set<string>();
// Lanes whose owner was told of a job past the bound.
const told = new Set<string>();
// The [wait]-on-main report each stopped lane already told main about (lane -> report text).
const waitTold = new Map<string, string>();

// A lane stopped while its last report waits on main tells main once (Claude Code's idle notification): main may have missed or
// forgotten that report, and the stopped lane can no longer remind it (2026-11-10..12: five lanes sat 23-173 min, projects/session-stalls).
function tellMainWaiting(lane: Lane, now: number): void {
	const file = join(dir(lane.name), "report.md");
	const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
	const { tone, text: body } = parseTone(text);
	if (tone !== "wait" || !waitsOnMain(text) || waitTold.get(lane.name) === text) return;
	waitTold.set(lane.name, text);
	const minutes = Math.round((now - (lane.lastFrameAt ?? now)) / 60_000);
	log(`lane ${lane.name} stopped while waiting on main for ${minutes} min: main is told once`);
	hooks.report(lane, msg().laneIdleWaitMain(lane.name, minutes, body.trim().slice(0, 600)));
}

// Pure decision: an idle lane with a session, nothing running for it, quiet for at least `minutes`.
export function shouldPark(lane: Pick<Lane, "status" | "proc" | "revive" | "sessionFile" | "lastFrameAt" | "name">, busy: boolean, minutes: number, now: number): boolean {
	if (minutes <= 0 || !lane.proc || lane.status !== "idle" || lane.revive || !lane.sessionFile || busy) return false;
	return now - (lane.lastFrameAt ?? now) >= minutes * 60_000;
}

export function parkIdleLanes(now = Date.now(), minutes = lanesIdleStopMin()): string[] {
	const parked: string[] = [];
	for (const lane of lanes.values()) {
		if (!shouldPark(lane, laneBusy(lane, false), minutes, now)) continue;
		const jobs = laneJobs(lane);
		if (jobs.length) {
			if (!held.has(lane.name)) log(`lane ${lane.name} idle for ${minutes}+ min, kept up for: ${jobs.map(j => j.what).join(", ")}`);
			held.add(lane.name);
			if (!told.has(lane.name) && jobs.every(j => now - j.since >= JOB_BOUND_MIN * 60_000)) {
				told.add(lane.name);
				hooks.report(lane, msg().laneIdleHeld(jobs.map(j => j.what), JOB_BOUND_MIN));
			}
			continue;
		}
		held.delete(lane.name);
		told.delete(lane.name);
		if (!parkLane(lane)) continue;
		parked.push(lane.name);
		tellMainWaiting(lane, now);
		log(`lane ${lane.name} idle for ${minutes}+ min: process stopped to free memory, the next message resumes ${lane.sessionFile}`);
	}
	return parked;
}

export function startLaneIdleStop(): void {
	if (lanesIdleStopMin() <= 0) return;
	const timer = setInterval(() => parkIdleLanes(), CHECK_MS);
	timer.unref();
	trackTimer("lane idle stop", timer);
}
