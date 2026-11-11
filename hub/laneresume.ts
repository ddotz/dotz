// The sweep that brings back a lane with unfinished work (laneunfinished.ts), whichever path left it there: idle stop, restart, crash,
// a worker killed under a live lane. No model call unless a lane is really woken; capacity, the budget gate and the wake bound decide
// when. A lane that must wait keeps its place: it is looked at again on the next tick and never dropped. A resume also waits while a
// gateway restart drains, since the restart brings it back anyway and a new turn would only hold the restart up.
import { existsSync } from "node:fs";
import { deadOmoWork } from "./bgwork.ts";
import { log } from "./config.ts";
import { msg } from "./i18n.ts";
import { launchWait, waitingLanes } from "./lanelimits.ts";
import { laneBusy, lanes, sendToLane } from "./lanes.ts";
import { runtimeMismatch } from "./lanerun.ts";
import type { Lane } from "./lanestate.ts";
import { claimWake, unfinishedWork, wakeStep, withWorkers } from "./laneunfinished.ts";
import { trackTimer } from "./shutdown.ts";

export const RESUME_SWEEP_MS = 60_000;
// With no reset time from the usage report, the budget is asked again after this long (one usage call and one hub.log line per ask).
const BUDGET_HOLD_MS = 5 * 60_000;

export type ResumeDeps = {
	budget?: (name: string) => Promise<{ text: string; resetAt?: number } | undefined>;
	restarting?: () => boolean;
	/** The pass over the orchestrator and conversation sessions (hub/sessionresume.ts), on this sweep's clock and budget hold. */
	sessions?: (gate: (name: string) => Promise<boolean>) => Promise<string[]>;
};

let budgetHold = 0;
let stopped = false;
// Dead workers a live lane was already told about: its turn cannot close their records, so one is named once.
const named = new Set<string>();

const nameless = (lane: Lane) => deadOmoWork(lane.sessionFile).filter(w => !named.has(w.id));
function candidate(lane: Lane): boolean {
	if (!lane.sessionFile || lane.waiting || lane.revive || lane.status === "rate-limited" || lane.status === "working" || lane.status === "starting") return false;
	// lanereconnect.ts owns an outage: a resume now would only fail on the same dead network. quiet without parked: a restart in place.
	if ((lane.interrupted && !lane.interrupted.resumed) || (lane.quiet && !lane.parked)) return false;
	if (lane.proc) return lane.status === "idle" && lane.prompted === undefined && !laneBusy(lane, false) && nameless(lane).length > 0;
	if (lane.status === "exited" && !lane.died) return false;
	return existsSync(lane.sessionFile) && !runtimeMismatch(lane);
}

async function budgetBlocks(name: string, deps: ResumeDeps, now: number): Promise<boolean> {
	if (now < budgetHold) return true;
	const blocked = await deps.budget?.(name);
	if (!blocked) return false;
	budgetHold = blocked.resetAt && blocked.resetAt > now ? blocked.resetAt : now + BUDGET_HOLD_MS;
	log(`lane resume held until ${new Date(budgetHold).toISOString()}: ${blocked.text}`);
	return true;
}

function wake(lane: Lane, work: NonNullable<ReturnType<typeof unfinishedWork>>, now: number): boolean {
	if (!claimWake(lane, work, now)) {
		lane.resumeDue = { state: "stuck" };
		return false;
	}
	lane.resumeDue = undefined;
	for (const w of deadOmoWork(lane.sessionFile)) named.add(w.id);
	const note = lane.refused?.text ?? withWorkers(msg().laneResumeContinue(work.open, work.current ?? ""), work.workers);
	// Its retry timer may still be running: a crash does not end it, and the message must go once.
	clearTimeout(lane.refusedTimer);
	lane.refused = lane.refusedTimer = undefined;
	sendToLane(lane.name, note, undefined, true);
	log(`lane ${lane.name} resumed by the sweep (${lane.restartWakes?.count} of this plan)`);
	return true;
}

/** One pass; the names of the lanes it woke. */
export async function resumeUnfinished(deps: ResumeDeps = {}, now = Date.now()): Promise<string[]> {
	const woken: string[] = [];
	if (stopped || deps.restarting?.()) return woken;
	for (const lane of lanes.values()) {
		const able = candidate(lane);
		const work = able ? unfinishedWork(lane) : undefined;
		if (!work) {
			lane.resumeDue = undefined;
			if (able) lane.restartWakes = undefined;
			continue;
		}
		const step = wakeStep(lane, work, now);
		if (step === "spent") {
			lane.resumeDue = { state: "stuck" };
			continue;
		}
		lane.resumeDue = { state: "due" };
		if (step === "backoff") continue;
		const full = lane.proc ? undefined : (launchWait(lane.cwd) ?? waitingLanes()[0]?.waiting);
		if (full) {
			lane.resumeDue = { state: "capacity", detail: full };
			continue;
		}
		if (await budgetBlocks(lane.name, deps, now)) continue;
		// The budget answer took a moment: a message may have reached the lane meanwhile.
		if (stopped || deps.restarting?.() || !candidate(lane)) continue;
		try {
			if (wake(lane, work, now)) woken.push(lane.name);
		} catch (e) {
			log(`lane ${lane.name} resume failed: ${(e as Error).message}`);
		}
	}
	return woken;
}

const goingDown = (deps: ResumeDeps): boolean => stopped || Boolean(deps.restarting?.());
async function pass(deps: ResumeDeps): Promise<void> {
	await resumeUnfinished(deps);
	if (!goingDown(deps)) await deps.sessions?.(async name => (await budgetBlocks(name, deps, Date.now())) || goingDown(deps));
}

export function startLaneResumeSweep(deps: ResumeDeps): void {
	const tick = () => void pass(deps).catch(e => log(`lane resume sweep failed: ${e}`));
	tick();
	const timer = setInterval(tick, RESUME_SWEEP_MS);
	timer.unref();
	trackTimer("lane resume sweep", timer);
}
/** The gateway is going down: shutdownLanes leaves lanes idle with no process, which is not work to bring back. */
export function stopLaneResumeSweep(): void {
	stopped = true;
}
