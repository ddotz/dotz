import { log } from "./config.ts";
import { runningSubagents, subagentsOf } from "./activity.ts";
import type { Lane } from "./lanestate.ts";
import { createWorkerHold } from "./worker-hold.ts";

/** What a lane's process runs that dies with it: its omp subagents, or the process's own word that async work can still wake it (`awaitingAsync`). */
export const laneLive = (lane: Lane): number => Math.max(runningSubagents(`lane:${lane.name}`), lane.proc?.awaitingAsync?.() ? 1 : 0);

/** The running omp subagents of a lane by name, for what a restart or a refusal says. */
export const runningNames = (lane: Lane): string[] =>
	lane.runtime === "omp" ? subagentsOf(`lane:${lane.name}`).filter(s => s.status === "running").map(s => s.description ?? s.agent ?? s.name ?? s.id) : [];

const holds = new WeakMap<Lane, ReturnType<typeof createWorkerHold>>();

/**
 * Carries out `act` (a restart of the lane's process) once the lane's omp subagents are done, at most WORKER_HOLD_MS, as the orchestrator
 * does for its own (hub/worker-hold.ts). One hold per lane; it ends when the process changes under it. True when `act` ran right away.
 */
export function restartWhenFree(lane: Lane, why: string, act: () => void): boolean {
	let hold = holds.get(lane);
	if (!hold) {
		hold = createWorkerHold({ process: () => lane.proc, live: () => laneLive(lane), log: line => log(`lane ${lane.name} ${line}`) });
		holds.set(lane, hold);
	}
	let went = false;
	hold.run(why, () => {
		went = true;
		act();
	});
	return went;
}
