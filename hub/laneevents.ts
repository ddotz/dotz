import { type Lane, portOf, pendingFile, setStatus, ownerNotes, persist, hooks } from "./lanestate.ts";
import { type AgentProcess } from "./runtime/types.ts";
import { emitEventActivity } from "./activity.ts";
import { noteEvent, compactDue, requestCompact, flushCompact } from "./context.ts";
import { rmSync } from "node:fs";
import { handleError, settleRevert, settleChain } from "./lanefailover.ts";
import { scheduleReport, REPORT_DEBOUNCE_MS } from "./lanereport.ts";
import { lanesCompactAt, log } from "./config.ts";
import { recover } from "./lanerun.ts";
import { prompt } from "./laneprompt.ts";
import { msg } from "./i18n.ts";
import { revertWhy } from "./fallback.ts";
import { runtimeFor } from "./runtime/index.ts";

// A lane started with a fallback chain: after a failed request the runtime may move to the next model by itself and redo
// the turn, so the failure is acted on (pause, retry, error report) only when no such switch follows within a short grace.
const FALLBACK_GRACE_MS = 3000;

export async function readEvents(lane: Lane, proc: AgentProcess): Promise<void> {
	const source = `lane:${lane.name}`;
	// Whether the turn was running when the current frame's first event arrived (before any of its events took effect).
	let wasWorking = false;
	for await (const ev of proc.events) {
		emitEventActivity(source, ev);
		noteEvent(lane.ctx, ev, portOf(lane));
		switch (ev.type) {
			case "alive":
				lane.lastFrameAt = Date.now();
				wasWorking = lane.status === "working";
				break;
			case "turn_start":
				clearTimeout(lane.watchdog);
				clearTimeout(lane.timer);
				clearTimeout(lane.transientTimer);
				clearTimeout(lane.errorHold);
				lane.failing = false;
				lane.transientTimer = undefined;
				rmSync(pendingFile(lane), { force: true });
				setStatus(lane, "working");
				lane.progressAt = Date.now();
				break;
			case "assistant":
				if (ev.stop !== "error") lane.transientTries = 0;
				if (ev.text) {
					lane.lastText = ev.text;
					lane.unreported = true;
					// A text that ends in a tool call, after an owner message, is the lane's short answer to it (the footer asks for one).
					if (ev.stop !== "error") ownerNotes.text(lane.name, ev.text, ev.stop !== "other");
				}
				// A compaction error is recovered by recover() below (restart on the same session), not retried here.
				else if (ev.stop === "error" && !ev.error.compaction) {
					const failed = ev.error;
					lane.failing = true;
					if (lane.chained) {
						clearTimeout(lane.errorHold);
						lane.errorHold = setTimeout(() => handleError(lane, failed), FALLBACK_GRACE_MS);
					} else handleError(lane, failed);
				}
				break;
			case "turn_end":
				scheduleReport(lane);
				settleRevert(lane, true);
				setTimeout(() => settleChain(lane), REPORT_DEBOUNCE_MS + 150);
				if (lane.status === "idle" && (lane.pauseReported || lane.held?.length)) {
					lane.pauseReported = false;
					lane.held = undefined;
					persist(lane);
				}
				if (lane.status === "idle") {
					lane.proc?.refreshUsage();
					// OmO lanes do not read lanes.compact_at (only the omp overlay does), so the hub compacts an idle lane at it.
					if (compactDue(lane.ctx, lanesCompactAt())) requestCompact(lane.ctx, portOf(lane));
					else flushCompact(lane.ctx, portOf(lane));
				}
				if (lane.status === "idle") setTimeout(() => lane.status === "idle" && hooks.idle(lane.name), REPORT_DEBOUNCE_MS + 100);
				break;
			case "session":
				lane.sessionFile = ev.ref;
				persist(lane);
				break;
			case "spend": {
				const reached = lane.chain?.spend(ev.tokens, ev.usd);
				if (reached?.capped) lane.capped = reached;
				break;
			}
			case "compaction":
				if (ev.state === "error") recover(lane, "컨텍스트 압축이 실패했어요", wasWorking);
				else {
					lane.retainNext = true;
					if (lane.status === "idle" && lane.held?.length) {
						const during = lane.held.splice(0);
						lane.held = undefined;
						persist(lane);
						log(`lane ${lane.name} compaction over; delivering ${during.length} message(s) that arrived during it`);
						for (const t of during) prompt(lane, t);
					}
				}
				break;
			case "fallback": {
				log(`lane ${lane.name} model fallback${ev.worker ? " (task worker)" : ""}: ${ev.from} -> ${ev.to}${ev.reason ? ` (${ev.reason.replace(/\s+/g, " ").slice(0, 200)})` : ""}`);
				let line = msg().modelFallback(ev.from, ev.to, ev.reason, ev.worker);
				if (ev.worker) lane.activeWorkerModel = ev.to;
				else {
					clearTimeout(lane.errorHold);
					lane.failing = false;
					lane.activeModel = ev.to;
					// Undone later only when the hub is not driving a chain itself and the runtime can switch models.
					if (!lane.chain) {
						if (proc.setModel) lane.reverter?.note(lane.startedModel ?? lane.model, revertWhy(ev.reason ?? "", runtimeFor("lane").classifyError(ev.reason ?? "")), ev.from, ev.reason ?? "");
						else line += ` ${msg().modelNoRevert}`;
					}
				}
				hooks.notice(lane, line);
				break;
			}
		}
	}
}
