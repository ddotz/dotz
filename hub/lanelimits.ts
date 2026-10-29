// How many lanes may work at once and how many task workers one lane may run (hub/limits.ts follows this machine's free
// memory and cores at the moment of asking; lanes.max_active / lanes.max_workers, when set, only cap them). Moved out of lanes.ts.
import { runningSubagents } from "./activity.ts";
import { lanesMaxActive, lanesMaxWorkers } from "./config.ts";
import { type Lane, lanes } from "./lanestate.ts";
import { limitsNow, type Running, waitText } from "./limits.ts";

export const waitingLanes = () => [...lanes.values()].filter(l => l.waiting).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
// Only a lane with a live process holds a slot: one whose start failed, or that no process runs for, uses no memory.
const isActive = (l: Lane) => !l.waiting && !!l.proc && (l.status === "working" || l.status === "starting");
export const activeCount = () => [...lanes.values()].filter(isActive).length;
// A process started in the last minute has not reached its ~1 GB yet, so each counts as taken.
const RAMP_MS = 60_000;
// `except`: the lane being spawned, which the answer is for and which must not count against itself.
const runningNow = (except?: Lane): Running => ({
	lanes: [...lanes.values()].filter(l => l !== except && isActive(l)).length,
	workers: [...lanes.values()].reduce((n, l) => n + runningSubagents(`lane:${l.name}`), 0),
	ramping: [...lanes.values()].filter(l => l !== except && l.proc && Date.now() - (l.spawnedAt ?? 0) < RAMP_MS).length,
});
const caps = () => ({ lanes: lanesMaxActive(), workers: lanesMaxWorkers() });
export const laneLimits = (maxAgeMs = 0, except?: Lane) => limitsNow(runningNow(except), caps(), maxAgeMs);
// Why a lane launched now has to wait (undefined = it may start). Lanes already waiting go first.
export function launchWait(maxAgeMs = 0): string | undefined {
	const l = laneLimits(maxAgeMs);
	return activeCount() < l.lanes ? undefined : waitText(l.reason ?? "memory", caps());
}
export const laneSlotsNow = (): number => laneLimits(5000).lanes;
export const workerSlotsNow = (): number => laneLimits(5000).workers;
/** What /api/state shows: the limits right now and, when launches wait, why. */
export function laneCapacity(): Record<string, unknown> {
	const l = laneLimits(5000);
	return { lanes: l.lanes, workers: l.workers, spare_agents: l.spare, reserve_gb: Math.round(l.reserveGb), active: activeCount(), waiting: waitingLanes().length, wait_reason: waitingLanes()[0]?.waiting ?? launchWait(5000) ?? null, caps: caps() };
}
