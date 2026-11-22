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
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lanesIdleStopMin, log } from "./config.ts";
import { waitsOnMain } from "./forline.ts";
import { msg } from "./i18n.ts";
import { type Lane, laneBusy, laneJobs, lanes, parkLane } from "./lanes.ts";
import { dir, hooks, persist } from "./lanestate.ts";
import { parseTone } from "./tone.ts";
import { trackTimer } from "./shutdown.ts";

export const CHECK_MS = 60_000;
const JOB_BOUND_MIN = 120;
// Lanes whose hold is already in the log.
const held = new Set<string>();
// Lanes whose owner was told of a job past the bound.
const told = new Set<string>();
const MIN = 60_000;
// Minutes into a lane's [wait] on main at which main is told of it again, until a message reaches the lane (sendToLane ends the count);
// the last step tells the owner instead, once. One reminder at the idle stop was not enough: five lanes sat 23-173 min on main
// 2026-11-10..12 (projects/session-stalls), and one that main put off or forgot heard nothing more (review-a G1). The count lives on
// the lane record (waitingMain), so a gateway restart neither forgets nor repeats a step (G6).
export const WAIT_MAIN_STEPS_MIN: readonly number[] = [20, 60, 180, 360];

// The lane's last report if it is a [wait] on main, with when it was written.
function waitOnMain(lane: Lane): { text: string; at: number } | undefined {
	const file = join(dir(lane.name), "report.md");
	if (!existsSync(file)) return undefined;
	const text = readFileSync(file, "utf8").trim();
	return parseTone(text).tone === "wait" && waitsOnMain(text) ? { text, at: statSync(file).mtimeMs } : undefined;
}

// Every idle lane waiting on main, stopped, held up by a job or kept up because the idle stop is off (G5): main may have missed or
// forgotten that report, and a waiting lane cannot remind it (Claude Code's idle notification). Returns the lanes told now.
export function remindMainWaits(now = Date.now()): string[] {
	const told: string[] = [];
	for (const lane of lanes.values()) {
		if (lane.status !== "idle") continue;
		const wait = waitOnMain(lane);
		if (lane.waitingMain?.text !== wait?.text) {
			lane.waitingMain = wait && { text: wait.text, since: wait.at, tells: 0 };
			persist(lane);
		}
		const w = lane.waitingMain;
		const step = w && WAIT_MAIN_STEPS_MIN[w.tells];
		if (!w || step === undefined) continue;
		// After a restart that skipped steps, the next one still waits its own gap after the last tell.
		const gap = step - (WAIT_MAIN_STEPS_MIN[w.tells - 1] ?? 0);
		if (now < Math.max(w.since + step * MIN, (w.toldAt ?? 0) + gap * MIN)) continue;
		w.tells += 1;
		w.toldAt = now;
		persist(lane);
		const minutes = Math.round((now - w.since) / MIN);
		const text = msg().laneIdleWaitMain(lane.name, minutes, parseTone(w.text).text.trim().slice(0, 600));
		const owner = w.tells === WAIT_MAIN_STEPS_MIN.length;
		log(`lane ${lane.name} has waited on main for ${minutes} min: ${owner ? "the owner" : "main"} is told (${w.tells} of ${WAIT_MAIN_STEPS_MIN.length})`);
		if (owner) hooks.notice(lane, text);
		else hooks.report(lane, text);
		told.push(lane.name);
	}
	return told;
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
		log(`lane ${lane.name} idle for ${minutes}+ min: process stopped to free memory, the next message resumes ${lane.sessionFile}`);
	}
	return parked;
}

/** Starts the wait-on-main reminders and, unless lanes.idle_stop_min is 0, the idle stop; the returned function stops both. */
export function startLaneIdleStop(): () => void {
	const timers = [setInterval(() => remindMainWaits(), CHECK_MS), ...(lanesIdleStopMin() > 0 ? [setInterval(() => parkIdleLanes(), CHECK_MS)] : [])];
	timers.forEach((timer, i) => {
		timer.unref();
		trackTimer(i ? "lane idle stop" : "lane wait on main", timer);
	});
	return () => timers.forEach(clearInterval);
}
