// Lanes a network failure stopped, resumed once when the model host answers again (orch-error.ts startResumeWatch). A lane is
// interrupted when its transient retries ran out (lanefailover.ts legacyError), or when it is idle on a task worker that hit a
// provider error and will not report: both leave nothing that would ever wake it (2026-11-06: note-merge sat parked after the network
// came back, until a message reached it). The mark is on disk, so a parked lane keeps it through a restart; a turn that gets an
// answer clears it. The resume is the laneTransient turn on the same session, which carries what the lane already sent.
import { quietOmoWork } from "./bgwork.ts";
import { msg } from "./i18n.ts";
import { resumeLane } from "./lanerun.ts";
import { prompt } from "./laneprompt.ts";
import { type Lane, laneBusy, lanes } from "./lanes.ts";
import { persist } from "./lanestate.ts";
import { laneClosed } from "./laneunfinished.ts";
import type { Interrupted } from "./orch-error.ts";
import { classifyProviderError } from "./providers.ts";

// Workers already counted: a lane that was resumed and left its worker alone is not marked again by the same worker.
const counted = new Set<string>();

function markStalled(lane: Lane): void {
	for (const w of quietOmoWork(lane.sessionFile)) {
		if (!w.error || counted.has(w.id) || classifyProviderError(w.error) !== "transient") continue;
		counted.add(w.id);
		lane.interrupted ??= {};
		persist(lane);
	}
}

const due = (lane: Lane): boolean =>
	Boolean(lane.interrupted && !lane.interrupted.resumed) && lane.status === "idle" && !lane.revive && !lane.transientTimer && lane.prompted === undefined && !laneBusy(lane, false);

function resume(lane: Lane): void {
	if (!lane.proc) return resumeLane(lane, msg().laneTransient);
	lane.interrupted!.resumed = true;
	persist(lane);
	prompt(lane, msg().laneTransient);
}

/** The lanes to watch the model host for. An owner-stopped lane has exited, and a usage-limit pause keeps its own resume (not due). */
export function interruptedLanes(): Interrupted[] {
	const out: Interrupted[] = [];
	for (const lane of lanes.values()) {
		if (lane.status === "exited" || !lane.sessionFile) continue;
		if (lane.status === "idle") markStalled(lane);
		if (!lane.interrupted) continue;
		if (lane.status === "idle" && !lane.unreported && laneClosed(lane)) {
			lane.interrupted = undefined;
			persist(lane);
			continue;
		}
		out.push({
			key: `lane ${lane.name}`,
			due: () => due(lane),
			resume: () => resume(lane),
			rearm: () => {
				if (!lane.interrupted?.resumed) return;
				lane.interrupted.resumed = undefined;
				persist(lane);
			},
		});
	}
	return out;
}
