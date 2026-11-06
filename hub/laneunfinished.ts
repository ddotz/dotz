// One answer to "does this lane still owe work?", read from durable data only, so the idle stop, a restart, a crash, a killed worker and
// the resume sweep (laneresume.ts) cannot disagree. reply-voice (2026-11-05): a turn ended at 22:50 KST waiting on its worker; the idle
// stop killed both at 23:25, and every later restart logged "stays parked" because "no process, status idle" read as nothing to do. It
// sat 15 hours with work open until the owner wrote. A lane waiting on the owner is the opposite failure (ddotz/dotz#44: woken three
// times after an [ask], re-asking each time for tokens), so the closing checks come first and say "leave it alone".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deadOmoWork } from "./bgwork.ts";
import { log } from "./config.ts";
import { msg } from "./i18n.ts";
import { dir, hooks, type Lane, persist } from "./lanestate.ts";
import { openTodos, promisesWork, waitsForOwner } from "./runstate.ts";
import { readTodo, workCutOff } from "./todo.ts";
import { parseTone } from "./tone.ts";

const lastReport = (lane: Lane): string => {
	const file = join(dir(lane.name), "report.md");
	return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const toneOf = (text: string) => parseTone(text).tone;
const CLOSING = new Set(["done", "ask", "fail"]);

// Finished, failed, stopped by the owner, or waiting on him: nothing brings such a lane back by itself. A refused bare [ask]
// (lanereport.ts) leaves no pendingAsk and an unmarked report.md, and it is still a question. A verified claim the owner has since
// written past is no longer the last word.
export function laneClosed(lane: Lane): boolean {
	if (lane.ownerStopped || lane.pendingAsk || lane.bareAsk || (lane.claim && !lane.claim.reopened)) return true;
	const said = lastReport(lane);
	return CLOSING.has(toneOf(said) ?? "") || (waitsForOwner(said) && !promisesWork(said));
}

export type Unfinished = { plan: string; open: number; current?: string; workers: string[] };

// Tail reads only (hub/todo.ts); called from a once-a-minute sweep and at a stop, never from /api/state, which reads lane.resumeDue.
// A process that died owes its work whatever its last words were (a [done] from an earlier turn); an owner message it holds is owed too.
export function unfinishedWork(lane: Lane): Unfinished | undefined {
	const owed = Boolean(lane.held?.length || lane.refused || lane.died) && !lane.ownerStopped;
	if (!owed && laneClosed(lane)) return undefined;
	const todo = openTodos(readTodo(lane.sessionFile));
	const workers = deadOmoWork(lane.sessionFile).map(w => w.description);
	if (!owed && !todo.open && !workers.length && !workCutOff(lane.sessionFile) && toneOf(lastReport(lane)) !== "run") return undefined;
	return { plan: `${todo.open}:${todo.current ?? ""}`, open: todo.open, ...(todo.current ? { current: todo.current } : {}), workers };
}

// Wakes one unchanged plan gets before the owner is told instead, and the wait after each: 5, 10, 20 minutes.
export const RESTART_WAKE_MAX = 3;
export const RESUME_BACKOFF_MS = 5 * 60_000;

export function wakeStep(lane: Lane, work: Unfinished, now: number): "wake" | "backoff" | "spent" {
	const w = lane.restartWakes;
	if (w?.plan !== work.plan) return "wake";
	if (w.count > RESTART_WAKE_MAX) return "spent";
	return now < (w.nextAt ?? 0) ? "backoff" : "wake";
}

/** Takes one wake of this episode; false: the bound is hit, and the owner gets his one message now. */
export function claimWake(lane: Lane, work: Unfinished, now = Date.now()): boolean {
	const count = lane.restartWakes?.plan === work.plan ? lane.restartWakes.count : 0;
	if (count === RESTART_WAKE_MAX) {
		log(`lane ${lane.name} left alone: ${count} automatic resumes changed nothing in its plan`);
		hooks.report(lane, msg().laneRestartStuck(count));
	}
	lane.restartWakes = { plan: work.plan, count: Math.min(count + 1, RESTART_WAKE_MAX + 1), nextAt: now + RESUME_BACKOFF_MS * 2 ** count };
	persist(lane);
	return count < RESTART_WAKE_MAX;
}

export const withWorkers = (note: string, workers: string[]): string => (workers.length ? `${note} ${msg().laneWorkersCut(workers)}` : note);
