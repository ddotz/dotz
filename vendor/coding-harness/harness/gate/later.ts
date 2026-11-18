import { handlerDeadline } from "./deadline.ts";
import { CLOSING } from "./decision.ts";
import type { Problem } from "./decision.ts";
import { notify } from "./host.ts";
import type { Ctx, GateMessage } from "./host.ts";
import { readPassed, writePassed } from "./log.ts";
import { failureText } from "./runs.ts";
import { checkKey } from "./session.ts";
import type { ActiveRun, State } from "./session.ts";
import { fingerprint, takeSnapshot } from "./snapshot.ts";
import { message } from "./util.ts";

/** How a check's result that arrives after a stop reaches the session: a message shown to the user and put before the agent, which starts a turn. */
export type Deliver = (message: GateMessage) => void;

// why(platform): omp@18.22.2 loads each extension as its own module instance, so module-level state here is not the one session-restart reads.
const shared = globalThis as { [key: symbol]: { leaving: Set<State>; running: Set<State>; judging: Set<State> } | undefined };
const KEY = Symbol.for("omp-harness.gate.pending");
const pending = (shared[KEY] ??= { leaving: new Set<State>(), running: new Set<State>(), judging: new Set<State>() });
const leaving = pending.leaving;

/** Marks that a run of the session started; it counts as pending gate work until it ends (`state.active` turns false). */
export function noteRun(state: State): void {
	pending.running.add(state);
}

/** Runs `judge`, a stop judgment of the session, counted as pending gate work while it lasts. */
export async function judging<T>(state: State, judge: () => Promise<T>): Promise<T> {
	pending.judging.add(state);
	try {
		return await judge();
	} finally {
		pending.judging.delete(state);
	}
}

/** What restarting this process now would cut short, over every session of it: runs whose stop is not judged yet, stop judgments in progress, and checks left to end after a run whose result is not reported yet. */
export function pendingLater(): number {
	let count = pending.judging.size;
	for (const state of pending.running) if (state.active) count += 1;
	else pending.running.delete(state);
	for (const state of leaving) {
		if (state.later.size === 0) leaving.delete(state);
		count += state.later.size;
	}
	return count;
}

/**
 * Leaves the checks `running` names, the checks a stop is about to let an interactive session finish with, to end after the run:
 * each one's process moves from `state.checks`, which `endRun` cancels, to `state.later`, the user is told it is still running,
 * and a watcher, the only owner of the run from then on, reports how it ends. A pass for the tree the check started on is
 * remembered and told to the user; a pass for a tree edited since is told as such, and the next stop runs the check again. A
 * failure, a timeout or a kill is put before the agent through `deliver`, once. A run already left by an earlier stop keeps its
 * watcher. A stop that replaces the run for an edited tree (`dropLater`) and a session that is left (`cancelLater`) silence it.
 */
export function defer(state: State, running: readonly Problem[], ctx: Ctx, deliver: Deliver): void {
	for (const problem of running) {
		const key = checkKey(problem.repo, problem.name);
		const active = state.checks.get(key);
		if (active !== undefined) {
			state.checks.delete(key);
			state.later.set(key, active);
			leaving.add(state);
			void watch(state, key, active, ctx, deliver);
		}
		if (state.later.has(key)) notify(ctx, `done-gate: check "${problem.name}" is still running in ${problem.repo}; its result will follow.`, "info");
	}
}

/** Stops the run left under `key` without a word from its watcher: a stop runs the check again for a tree edited since. */
export function dropLater(state: State, key: string): void {
	const active = state.later.get(key);
	state.later.delete(key);
	active?.run.cancel();
}

/** Stops every check left to end after a run, with nothing delivered for them: the session that left them is gone. */
export function cancelLater(state: State): void {
	const left = [...state.later.values()];
	state.later.clear();
	for (const { run } of left) run.cancel();
}

/** Reports every check left to end after a run that ended while a run of the session was going: a stop let the session finish without collecting it. */
export function reportSettled(state: State, ctx: Ctx, deliver: Deliver): void {
	for (const [key, active] of state.later) if (active.run.settled !== undefined) void conclude(state, key, active, ctx, deliver);
}

async function watch(state: State, key: string, active: ActiveRun, ctx: Ctx, deliver: Deliver): Promise<void> {
	await active.run.promise;
	if (!state.active) await conclude(state, key, active, ctx, deliver);
}

async function conclude(state: State, key: string, active: ActiveRun, ctx: Ctx, deliver: Deliver): Promise<void> {
	const { repo, check } = active;
	try {
		const done = await active.run.promise;
		const now = await takeSnapshot(repo, handlerDeadline());
		if (state.later.get(key) !== active) return;
		state.later.delete(key);
		const failed = done.timedOut || done.code !== 0;
		if (done.spawnError !== undefined) {
			notify(ctx, `done-gate: check "${check.name}" could not be started in ${repo}: ${done.spawnError}; it was not judged.`, "warning");
		} else if (fingerprint(now.tree, now.dirty, check.paths) !== active.print) {
			notify(ctx, `done-gate: check "${check.name}" ${failed ? "failed" : "passed"} in ${repo} for an earlier tree; the next stop runs it again.`, "info");
		} else if (failed) {
			deliver({ customType: "done-gate", display: true, content: `${failureText(repo, check, done)}\n\n${CLOSING}` });
		} else {
			writePassed(repo, { ...readPassed(repo), [check.name]: { fingerprint: active.print, command: check.command } });
			notify(ctx, `done-gate: check "${check.name}" passed in ${repo}.`, "info");
		}
	} catch (error) {
		if (state.later.get(key) === active) state.later.delete(key);
		notify(ctx, `done-gate: check "${check.name}" ended in ${repo}, but its result could not be handled (${message(error)}); the next stop judges it.`, "warning");
	}
}
