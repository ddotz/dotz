import { runningSubagents, subagentsOf, type SubagentFile } from "./activity.ts";
import type { AgentProcess } from "./runtime/types.ts";

/** How long a restart that can wait holds for the background workers of an omp process: past it the restart goes ahead and cuts them. */
export const WORKER_HOLD_MS = 30 * 60_000;
const WORKER_HOLD_STEP_MS = 5_000;

type Hold = { act: () => void; since: number; process: unknown };

/**
 * Holds a restart or a rotation of one session's process while its background workers run: omp kills them with the process.
 * One hold at a time (the first request is the one carried out, later ones while it waits add nothing), re-checked every few
 * seconds, ended by the workers' end, by the bound, or by the process changing under it (a stop, an exit, a restart of its own).
 */
export function createWorkerHold(deps: { process: () => unknown; live: () => number; log: (line: string) => void; boundMs?: number }) {
	const bound = deps.boundMs ?? WORKER_HOLD_MS;
	let hold: Hold | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function check(): void {
		timer = undefined;
		const h = hold;
		if (!h) return;
		if (deps.process() !== h.process) {
			hold = undefined;
			return;
		}
		const waited = Date.now() - h.since;
		if (deps.live() > 0 && waited < bound) {
			timer = setTimeout(check, WORKER_HOLD_STEP_MS);
			return;
		}
		hold = undefined;
		if (deps.live() > 0) deps.log(`background workers still run after ${Math.round(waited / 60_000)} min; going ahead and cutting them`);
		h.act();
	}

	function run(why: string, act: () => void): void {
		if (hold) return;
		if (deps.live() === 0) return act();
		deps.log(`${why}: waiting for ${deps.live()} background worker(s), at most ${Math.round(bound / 60_000)} min`);
		hold = { act, since: Date.now(), process: deps.process() };
		timer = setTimeout(check, WORKER_HOLD_STEP_MS);
	}

	function cancel(): void {
		clearTimeout(timer);
		timer = undefined;
		hold = undefined;
	}

	return { run, cancel, waiting: (): boolean => hold !== undefined };
}

/** What the gateway knows of one session's omp workers: the subagents its frames report and the process's own word that async work can still wake it (`awaitingAsync`). Only omp's process is asked; OmO and claude count nothing here. */
export function createOmpFeed(deps: { source: string; process: () => AgentProcess | undefined; omp: () => boolean; free: () => boolean }) {
	const count = (): number => Math.max(runningSubagents(deps.source), deps.process()?.awaitingAsync?.() ? 1 : 0);
	return {
		count,
		live: (): number => (deps.omp() ? count() : 0),
		list: (): SubagentFile[] => (deps.omp() ? subagentsOf(deps.source) : []),
		/** A note into the running process, steering the turn it is in; false when no process takes it now (none, or it is rotating, restarting or compacting). */
		tell(text: string): boolean {
			const proc = deps.process();
			if (!proc || !deps.free()) return false;
			proc.send(text, "steer");
			return true;
		},
	};
}
