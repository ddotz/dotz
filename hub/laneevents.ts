import { type Lane, portOf, pendingFile, setStatus, ownerNotes, persist, hooks } from "./lanestate.ts";
import { type AgentProcess } from "./runtime/types.ts";
import { emitEventActivity } from "./activity.ts";
import { noteEvent, compactDue, requestCompact, flushCompact, requeueRefused } from "./context.ts";
import { rmSync } from "node:fs";
import { handleError, laneRanOn, laneRecovered, settleRevert, settleChain } from "./lanefailover.ts";
import { nextLastText, scheduleReport, REPORT_DEBOUNCE_MS, report } from "./lanereport.ts";
import { compactAtFor, lanesCompactAt, log, now } from "./config.ts";
import { laneStuck, recover } from "./lanerun.ts";
import { prompt } from "./laneprompt.ts";
import { msg } from "./i18n.ts";
import { revertWhy } from "./fallback.ts";
import { noteModelChange } from "./model-guard.ts";
import { runtimeFor } from "./runtime/index.ts";

// A lane started with a fallback chain: after a failed request the runtime may move to the next model by itself and redo
// the turn, so the failure is acted on (pause, retry, error report) only when no such switch follows within a short grace.
const FALLBACK_GRACE_MS = 3000;
const STUCK_RECOVER_DELAY_MS = 250;

// OmO refuses a new turn while its own turn or compaction still runs ("Concurrent ... turn admission"): the provider call
// failed, nothing answered the text and the lane went idle on a lane error (ecount-relearn 2026-11-06 02:10). It is sent again
// a little later (held when a compaction runs by then); refused every time, the orchestrator gets it back. The text is already
// in the session (the provider call comes after it), so a later answer has read it and cancels the retry, and a turn running at
// the retry waits for its own end: a second copy would have the lane do the work twice.
const REFUSED_RE = /concurrent .*turn admission/i;
export const REFUSED_RETRY_MS = 10_000;
const REFUSED_TRIES = 3;
function refusedTurn(lane: Lane, sent: string): void {
	const before = lane.refused;
	// A second message refused while the first waits goes with it: one retry timer, nothing dropped.
	const text = before && before.text !== sent ? `${before.text}\n\n${sent}` : sent;
	const tries = before?.text === sent ? before.tries + 1 : 1;
	clearTimeout(lane.refusedTimer);
	if (tries > REFUSED_TRIES) {
		lane.refused = undefined;
		persist(lane);
		report(lane, `[fail] 세션이 다른 턴이나 압축을 돌리는 중이라 보낸 메시지를 ${REFUSED_TRIES}번 다시 보내도 받지 않았어요. 전하지 못한 메시지를 다시 보내세요:\n${text.slice(0, 1000)}`, true);
		return;
	}
	lane.refused = { text, tries };
	persist(lane);
	log(`lane ${lane.name} busy session refused a message (${tries}/${REFUSED_TRIES}); sending it again in ${REFUSED_RETRY_MS / 1000}s`);
	lane.refusedTimer = setTimeout(() => retryRefused(lane, text), REFUSED_RETRY_MS);
}
function retryRefused(lane: Lane, text: string): void {
	lane.refusedTimer = undefined;
	if (lane.quiet && !lane.proc) return; // a gateway restart stopped it: lane.json keeps the text, restoreLanes sends it
	if (!lane.proc) {
		lane.refused = undefined;
		persist(lane);
		report(lane, `[fail] 세션이 바빠서 받지 않은 메시지를 다시 보내기 전에 프로세스가 끝났어요. 전하지 못한 메시지를 다시 보내세요:\n${text.slice(0, 1000)}`, true);
	} else if (lane.status === "working") lane.refusedTimer = setTimeout(() => retryRefused(lane, text), REFUSED_RETRY_MS);
	else prompt(lane, text);
}
// Lanes whose last compaction failed (any failure requeueRefused does not take), with whether a turn ran at that failure. The first failure
// since the lane's last finished compaction is queued again for the next idle point; only a second one in a row restarts the lane (recover),
// as a single failure often clears on its own (provider timeout, a session that changed under the summary).
const compactFailed = new Map<string, boolean>();

function refusedAnswered(lane: Lane): void {
	if (!lane.refused) return;
	clearTimeout(lane.refusedTimer);
	lane.refusedTimer = lane.refused = undefined;
	persist(lane);
}

export async function readEvents(lane: Lane, proc: AgentProcess): Promise<void> {
	const source = `lane:${lane.name}`;
	// Whether the turn was running when the current frame's first event arrived (before any of its events took effect).
	let wasWorking = false;
	for await (const ev of proc.events) {
		laneStuck(lane).progress(ev.type, ev);
		emitEventActivity(source, ev);
		noteEvent(lane.ctx, ev, portOf(lane));
		switch (ev.type) {
			case "alive":
				lane.lastFrameAt = Date.now();
				wasWorking = lane.status === "working";
				break;
			case "turn_start":
				lane.resuming = false;
				clearTimeout(lane.watchdog);
				clearTimeout(lane.timer);
				clearTimeout(lane.transientTimer);
				clearTimeout(lane.errorHold);
				lane.failing = false;
				lane.transientTimer = undefined;
				lane.reportedThisTurn = undefined;
				lane.startingOn = undefined;
				if (lane.contractQueued) {
					// The extension's next-turn message went into this turn: nothing left for the gateway to send.
					lane.contractQueued = lane.contractDue = undefined;
					persist(lane);
				}
				rmSync(pendingFile(lane), { force: true });
				setStatus(lane, "working");
				lane.progressAt = Date.now();
				lane.steered = undefined;
				laneStuck(lane).begin();
				break;
			case "assistant":
				if (ev.stop === "error" && lane.prompted !== undefined && REFUSED_RE.test(ev.error.text)) {
					refusedTurn(lane, lane.prompted);
					lane.prompted = undefined;
					break;
				}
				lane.prompted = undefined;
				if (ev.stop !== "error") {
					refusedAnswered(lane);
					lane.transientTries = 0;
					if (lane.interrupted) {
						lane.interrupted = undefined;
						persist(lane);
					}
					laneRanOn(lane);
					laneRecovered(lane);
				}
				if (ev.text) {
					lane.lastText = nextLastText(lane, ev.text);
					lane.unreported = true;
					// A text that ends in a tool call, after an owner message, is the lane's short answer to it (the footer asks for one).
					if (ev.stop !== "error") ownerNotes.text(lane.name, ev.text, ev.stop !== "other");
				}
				// A compaction error is handled at the compaction event below (retried once, then recover()), not retried here.
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
				lane.resuming = false;
				clearTimeout(lane.abortTimer);
				lane.abortTimer = undefined;
				// Our stuck abort ended the turn: the lane is recovered right now on its session; the cut-off turn reports nothing.
				if (laneStuck(lane).end()) {
					// A beat for the abort's last frames to land before the process is replaced.
					setTimeout(() => lane.proc === proc && recover(lane, "턴이 멈춰 있어서 끊었어요", true, true), STUCK_RECOVER_DELAY_MS);
					break;
				}
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
					// OmO lanes do not read lanes.compact_at (only the omp overlay does), so the hub compacts an idle lane at it, or at
					// the running model's own point (config context.models, the 컨텍스트 screen), re-read here at every turn end.
					if (compactDue(lane.ctx, compactAtFor(lane.activeModel || lane.model, lanesCompactAt()))) requestCompact(lane.ctx, portOf(lane));
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
				if (ev.state === "error" && requeueRefused(lane.ctx, ev.error)) {
					log(`lane ${lane.name} compaction refused (${ev.error.slice(0, 120)}); retrying at the next idle point`);
					flushCompact(lane.ctx, portOf(lane));
				} else if (ev.state === "error" && !compactFailed.has(lane.name)) {
					compactFailed.set(lane.name, wasWorking);
					lane.ctx.compaction = { state: "queued", at: now() };
					log(`lane ${lane.name} compaction failed (${ev.error.slice(0, 120)}); retrying once at the next idle point`);
					flushCompact(lane.ctx, portOf(lane));
				} else if (ev.state === "error") {
					const firstWorking = compactFailed.get(lane.name) ?? false;
					compactFailed.delete(lane.name);
					recover(lane, "컨텍스트 압축이 실패했어요", wasWorking || firstWorking);
				} else {
					compactFailed.delete(lane.name);
					lane.retainNext = true;
					// On disk: a restart or a respawn loses the extension's queued re-read, and the next gateway prompt then carries the footer.
					lane.contractDue = true;
					lane.contractQueued = Boolean(runtimeFor("lane").caps.extension);
					persist(lane);
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
				if (!ev.worker) noteModelChange(`lane:${lane.name}`, ev.from, ev.to, "fallback");
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
