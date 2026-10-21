import { restartStaleLanes } from "./laneops.ts";
import { lanes, hooks } from "./lanestate.ts";
import { settleChain, settleRevert } from "./lanefailover.ts";
import { runningSubagents } from "./activity.ts";
import { recover } from "./lanerun.ts";

export { lanes, setOwnerNoteHandlers, ownerNotes, setReportHandler, setProgressHandler, setNoticeHandler, setIdleHandler, laneWorkerModel, isTempLane, laneRunning, laneLive } from "./lanestate.ts";
export type { LaneStatus, Lane, OwnerNoteHandlers } from "./lanestate.ts";
export { LANE_MIN_HOURS, laneJustification, checkBrief, isExpensive, DEFAULT_EST, BUDGET_MARGIN, BUDGET_WINDOW_HOURS, estimateOf, budgetVerdict, budgetLine, titleProblem } from "./lanegates.ts";
export type { BudgetOutcome } from "./lanegates.ts";
export { approvesBudget } from "./lanereport.ts";
export { RECOVERY_MAX, RECOVERY_WINDOW_MS, sessionRuntime, LaneRuntimeMismatch, runtimeMismatch } from "./lanerun.ts";
export { launch, startQueuedLanes, startLaneQueue, parkLane, sendToLane, verifyLane, claimPrefix, stopLane, abortLane, resumeByName, restartLane, setLaneModel, compactLane, refreshLaneStats, rotateLane, handoverLane, restoreLanes, laneBusy, shutdownLanes, applyChainChange } from "./laneops.ts";
export type { LaneDelivery } from "./laneops.ts";
export { laneSlotsNow, workerSlotsNow, laneCapacity } from "./lanelimits.ts";
export { liveLanes, laneModels, laneSummary, laneList, turnHeader } from "./laneviews.ts";

const PROGRESS_EVERY_MS = Number(process.env.DOTZ_PROGRESS_MS ?? 5 * 60_000);
// A turn in flight with no rpc frame for this long (a hung omp or provider call) is aborted and resumed; a lane
// recovers at most RECOVERY_MAX times per RECOVERY_WINDOW_MS, then it is left alone and the owner told once.
const STALL_MS = Number(process.env.DOTZ_STALL_MS ?? 20 * 60_000);

setInterval(() => {
	restartStaleLanes();
	for (const lane of lanes.values()) {
		settleChain(lane);
		settleRevert(lane, true);
		if (lane.status !== "working" || !lane.lastText || lane.lastText === lane.progressText) continue;
		if (Date.now() - (lane.progressAt ?? Date.now()) < PROGRESS_EVERY_MS) continue;
		lane.progressAt = Date.now();
		lane.progressText = lane.lastText;
		hooks.progress(lane, lane.lastText);
	}
}, 60_000);

setInterval(() => {
	for (const lane of lanes.values()) {
		// Running task workers emit their own progress frames, but a long silent worker step is not a hung lane: skip those.
		if (lane.status === "working" && lane.proc && !runningSubagents(`lane:${lane.name}`) && Date.now() - (lane.lastFrameAt ?? Date.now()) >= STALL_MS) recover(lane, `${Math.round(STALL_MS / 60_000)}분 넘게 아무 응답이 없어요`, true);
	}
}, Math.min(60_000, Math.max(250, STALL_MS / 2)));
