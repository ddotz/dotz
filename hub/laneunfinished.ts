// One answer to "does this lane still owe work?", read from durable data only, so the idle stop, a restart, a crash, a killed worker and
// the resume sweep (laneresume.ts) cannot disagree. reply-voice (2026-11-05): a turn ended at 22:50 KST waiting on its worker; the idle
// stop killed both at 23:25, and every later restart logged "stays parked" because "no process, status idle" read as nothing to do. It
// sat 15 hours with work open until the owner wrote. A lane waiting on the owner is the opposite failure (ddotz/dotz#44: woken three
// times after an [ask], re-asking each time for tokens), so the closing checks come first and say "leave it alone". Conversation sessions and
// the orchestrator read the same evidence (interruptedWork, hub/sessionresume.ts). A report is never evidence by itself: audit-xhigh's last
// [run] was a finished step, 27 hours old, with nothing open behind it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEAD_WORK_MS, deadOmoWork } from "./bgwork.ts";
import { log } from "./config.ts";
import { msg } from "./i18n.ts";
import { dir, hooks, type Lane, persist } from "./lanestate.ts";
import { openTodos, promisesWork, waitsForOwner } from "./runstate.ts";
import { readTodo, runCutOff, turnCutOff, workCutOff } from "./todo.ts";
import { parseTone, statedTone } from "./tone.ts";

const lastReport = (lane: Lane): string => {
	const file = join(dir(lane.name), "report.md");
	return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const CLOSING = new Set(["done", "ask", "fail"]);
const closes = (tone: string | undefined): boolean => CLOSING.has(tone ?? "");
/** The text ends the work or waits on the owner. A marker settles it; a leading emoji does unless a promise follows it (promisesWork). */
export const saysClosed = (said: string): boolean => closes(parseTone(said).tone) || ((closes(statedTone(said).tone) || waitsForOwner(said)) && !promisesWork(said));

// Finished, failed, stopped by the owner, or waiting on him: nothing brings such a lane back by itself. A refused bare [ask]
// (lanereport.ts) leaves no pendingAsk and an unmarked report.md, and it is still a question. A verified claim the owner has since
// written past is no longer the last word.
export function laneClosed(lane: Lane): boolean {
	if (lane.ownerStopped || lane.pendingAsk || lane.bareAsk || (lane.claim && !lane.claim.reopened)) return true;
	return saysClosed(lastReport(lane));
}

export type Unfinished = { plan: string; open: number; current?: string; workers: string[] };

// Quiet for this long is history, not an interruption: the first sweep after an update must not wake what sat down days ago. Only an owner
// message still held goes past it. reply-voice's 15 hours are well inside; killed workers age out of deadWork at the same mark.
export const STALE_WORK_MS = DEAD_WORK_MS;
export function staleSession(file: string, now = Date.now()): boolean {
	return now - statSync(file).mtimeMs >= STALE_WORK_MS;
}
function workOf(file: string | undefined, workers: string[]): Unfinished {
	const todo = openTodos(readTodo(file));
	return { plan: `${todo.open}:${todo.current ?? ""}`, open: todo.open, ...(todo.current ? { current: todo.current } : {}), workers };
}

// Tail reads only (hub/todo.ts); called from a once-a-minute sweep and at a stop, never from /api/state, which reads lane.resumeDue.
// A process that died owes its work whatever its last words were (a [done] from an earlier turn); an owner message it holds is owed too.
export function unfinishedWork(lane: Lane): Unfinished | undefined {
	const held = Boolean(lane.held?.length || lane.refused) && !lane.ownerStopped;
	const owed = held || (Boolean(lane.died) && !lane.ownerStopped);
	if (!owed && laneClosed(lane)) return undefined;
	const file = lane.sessionFile;
	if (!held && file && existsSync(file) && staleSession(file)) return undefined;
	const work = workOf(file, deadOmoWork(file).map(w => w.description));
	return owed || work.open || work.workers.length || workCutOff(file) ? work : undefined;
}

/**
 * The same evidence for a session that keeps no plan of its own between requests: an open todo alone is no interruption there (the stall
 * sweep nudges a live one, and its last clean answer closed the request), and neither is OmO's `stalled` over one. `live`: its process runs, so waiting on children or shells is
 * only waiting, and just OmO's own word counts. `dead` comes last: it reads the task store.
 */
export function interruptedWork(file: string, live: boolean, dead: () => string[], now = Date.now()): Unfinished | undefined {
	if (!existsSync(file) || staleSession(file, now)) return undefined;
	const workers = dead();
	return workers.length || (live ? runCutOff(file) : turnCutOff(file)) ? workOf(file, workers) : undefined;
}

// Wakes one unchanged plan gets before the owner is told instead, and the wait after each: 5, 10, 20 minutes.
export const RESTART_WAKE_MAX = 3;
export const RESUME_BACKOFF_MS = 5 * 60_000;

export type Wakes = { plan: string; count: number; nextAt?: number };

export function wakeStepOf(w: Wakes | undefined, plan: string, now: number): "wake" | "backoff" | "spent" {
	if (w?.plan !== plan) return "wake";
	if (w.count > RESTART_WAKE_MAX) return "spent";
	return now < (w.nextAt ?? 0) ? "backoff" : "wake";
}
export const wakeStep = (lane: Lane, work: Unfinished, now: number) => wakeStepOf(lane.restartWakes, work.plan, now);
/** The wake about to be taken: the memo after it, and how many this plan had before; RESTART_WAKE_MAX means the owner is told instead. */
export function takeWake(w: Wakes | undefined, plan: string, now: number): { wakes: Wakes; count: number } {
	const count = w?.plan === plan ? w.count : 0;
	return { wakes: { plan, count: Math.min(count + 1, RESTART_WAKE_MAX + 1), nextAt: now + RESUME_BACKOFF_MS * 2 ** count }, count };
}

/** Takes one wake of this episode; false: the bound is hit, and the owner gets his one message now. */
export function claimWake(lane: Lane, work: Unfinished, now = Date.now()): boolean {
	const { wakes, count } = takeWake(lane.restartWakes, work.plan, now);
	if (count === RESTART_WAKE_MAX) {
		log(`lane ${lane.name} left alone: ${count} automatic resumes changed nothing in its plan`);
		hooks.report(lane, msg().laneRestartStuck(count));
	}
	lane.restartWakes = wakes;
	persist(lane);
	return count < RESTART_WAKE_MAX;
}

export const withWorkers = (note: string, workers: string[]): string => (workers.length ? `${note} ${msg().laneWorkersCut(workers)}` : note);
