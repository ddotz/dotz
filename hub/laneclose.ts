import { log } from "./config.ts";
import type { AgentProcess } from "./runtime/types.ts";
import type { Lane } from "./lanestate.ts";

/** A process still alive this long after it was asked to stop is killed outright, so what waits for its exit cannot wait for ever. */
export const CLOSE_FORCE_MS = 15_000;

type Ended = "stop" | "shutdown" | undefined;

/** The lane's process is going away (the gateway stopped it, or it is marked to be killed and revived on its session) though `lane.proc` still names it: text written to it is lost. */
export const laneClosing = (lane: Lane): boolean => lane.proc !== undefined && (lane.closing?.proc === lane.proc || lane.revive !== undefined);

/** Why `proc` was stopped for good (an owner stop, a gateway shutdown), if it was: a restart or rotation waiting on its exit must not bring such a lane back. */
export const endedFor = (lane: Lane, proc: AgentProcess): Ended => (lane.closing?.proc === proc ? lane.closing.why : undefined);

/** Asks the lane's process to stop and marks it as closing until it exits; a stop that ends the lane for good is kept when a restart asks again. */
export function stopProcess(lane: Lane, why?: NonNullable<Ended>): void {
	const proc = lane.proc;
	if (!proc) return;
	lane.closing = { proc, why: why ?? endedFor(lane, proc) };
	proc.kill();
}

/** Runs one restart, rotation or paused restart per lane at a time: a second request while it waits for the old process to exit shares it, so one session never gets two processes. */
export function exclusive(lane: Lane, run: () => Promise<void>): Promise<void> {
	if (lane.restarting) return lane.restarting;
	const turn: Promise<void> = run().finally(() => {
		if (lane.restarting === turn) lane.restarting = undefined;
	});
	lane.restarting = turn;
	return turn;
}

/** Runs `go` once `proc`, the process that was closing, has exited and whatever takes over from it (a restart, a rotation, a recovery) has started its own. A process that ignores the stop is killed after CLOSE_FORCE_MS. */
export function whenClosed(lane: Lane, proc: AgentProcess, go: () => void): void {
	const force = setTimeout(() => lane.proc === proc && proc.kill(true), CLOSE_FORCE_MS);
	force.unref();
	void proc.exited
		.then(() => Promise.allSettled([lane.restarting]))
		.then(() => {
			clearTimeout(force);
			go();
		})
		.catch(e => log(`lane ${lane.name}: work waiting for its stopping process failed: ${(e as Error).message}`));
}
