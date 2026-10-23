import { workerModel, paths, writeAtomic } from "./config.ts";
import { type Ctx, type CompactPort } from "./context.ts";
import { type AgentProcess } from "./runtime/types.ts";
import { type ProviderErrorKind } from "./providers.ts";
import type { Chain, Move, Reverter } from "./fallback.ts";
import { createOwnerNotes } from "./lanerelay.ts";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { broadcast } from "./events.ts";
import { TEMP_PATH } from "./live-guard.ts";

export type LaneStatus = "starting" | "working" | "idle" | "rate-limited" | "exited";
// A lane in a git repo works in its own worktree (repo = the owner's checkout, base = the branch it lands on).
export type Worktree = { path: string; repo: string; branch: string; base: string };
type Claim = { state: "reported" | "verified"; at: string; evidence?: string; problems?: string[] };
// A lane's own [ask] report stays a question for the owner until the owner answers (sendToLane) or the lane reports again.
// The full text also sits in pending-ask.md (dir(name)) while pending, because report.md is overwritten by gateway notices.
type Ask = { text: string; at: string };
// `runtime`: the runtime that wrote sessionFile (omo, omp, claude); a session is only ever resumed by that runtime.
export type Record_ = { name: string; title?: string; cwd: string; model: string; workerModel?: string; fableOk?: boolean; status: LaneStatus; startedAt: string; sessionFile?: string; runtime?: string; reports: number; lastReportAt?: string; parked?: boolean; held?: string[]; worktree?: Worktree; claim?: Claim; pendingAsk?: Ask; waiting?: string; home?: string; homeName?: string; channel?: string };
export type Lane = Record_ & {
	ctx: Ctx;
	// The orchestrator sent work (launch, dotz_lane send) that no relayed report answered yet; an owner-only exchange in
	// the lane channel leaves it false, so that reply is not relayed (lanerelay.ts); unknown (a restored lane) relays.
	orchAsked?: boolean;
	lastText: string;
	// lastText was written by a turn and no report has carried it yet: a turn that ends without new text (aborted, empty)
	// must not report the previous answer again (mail-reply-drafts 2026-10-23 00:45:11, the same answer twice).
	unreported?: boolean;
	proc?: AgentProcess;
	timer?: ReturnType<typeof setTimeout>;
	watchdog?: ReturnType<typeof setTimeout>;
	resumeTimer?: ReturnType<typeof setTimeout>;
	quiet?: boolean;
	// Set to restart the process on the same session once it exits: text is the resume prompt (none = back to idle).
	revive?: { text?: string };
	lastFrameAt?: number;
	recoveries?: number[];
	recoveryCapped?: boolean;
	workingSince?: number;
	pauseReported?: boolean;
	pausing?: boolean;
	pauseKind?: ProviderErrorKind;
	transientTries?: number;
	transientTimer?: Timer;
	progressAt?: number;
	progressText?: string;
	// Set while the handover turn of a rotated session runs: that turn only reloads context, so its reply is not a report.
	silent?: { lastText: string };
	// Set when a compaction finished: the next prompt sent to the process carries the retain nudge once (no extra turn).
	retainNext?: boolean;
	// The models the running process answers on now (its own, and its task workers'): the configured ones, or the fallbacks omp moved to. Reset at every spawn.
	activeModel?: string;
	activeWorkerModel?: string;
	chained?: boolean;
	errorHold?: Timer;
	// A request failed and is still being resolved (grace for the runtime's own fallback, or the hub's failover): no report yet.
	failing?: boolean;
	// The chain the hub drives itself (conditional entries, spend caps; hub/fallback.ts) and a spend-cap decision waiting for an idle moment.
	chain?: Chain;
	capped?: { move?: Move };
	// Going back to the configured model after the runtime moved the process to a fallback by itself (not when the hub drives a chain).
	reverter?: Reverter;
	startedModel?: string;
	// The owner message a cross-runtime resume refused; it goes along with the handover once the owner accepts it.
	pendingHandover?: string;
	// dotz's Claude account or the lanes' fallback chain changed while this process ran: it is restarted on its session at the
	// next idle moment.
	accountStale?: boolean;
	// Task workers this lane's process was started with (hub/limits.ts, computed at spawn) and when it started.
	workerSlots?: number;
	spawnedAt?: number;
};

export const lanes = new Map<string, Lane>();
type ReportFn = (lane: Lane, text: string, answeringOwner?: boolean) => void;
export const hooks: { report: ReportFn; progress: ReportFn; notice: ReportFn; idle: (name: string) => void } = { report: () => {}, progress: () => {}, notice: () => {}, idle: () => {} };
// Owner messages sent to a lane and not answered yet (lanerelay.ts createOwnerNotes): the lane's short answer note at its next
// tool boundary reaches the owner at once, and the delivery state of each message follows (hub/events.ts emitDelivery).
export type OwnerNoteHandlers = { note: (lane: string, text: string, refs: string[]) => void; answered: (lane: string, refs: string[]) => void; lost: (lane: string, refs: string[]) => void };
const noopOwnerHandlers = (): OwnerNoteHandlers => ({ note: () => {}, answered: () => {}, lost: () => {} });
let ownerHandlers: OwnerNoteHandlers = noopOwnerHandlers();
export function setOwnerNoteHandlers(h: OwnerNoteHandlers): void {
	ownerHandlers = h;
}
const newOwnerNotes = () => createOwnerNotes({ note: (l, t, r) => ownerHandlers.note(l, t, r), answered: (l, r) => ownerHandlers.answered(l, r), lost: (l, r) => ownerHandlers.lost(l, r) });
// `let` only so resetLaneStateForTest can swap in an empty relay (its open-message map is private); importers see the live binding.
export let ownerNotes = newOwnerNotes();
export function setReportHandler(fn: ReportFn): void {
	hooks.report = fn;
}
export function setProgressHandler(fn: ReportFn): void {
	hooks.progress = fn;
}
// One line for the lane's channel when the runtime moves it, or one of its task workers, to the next model of a fallback
// chain. Not a report: it does not wake the orchestrator.
export function setNoticeHandler(fn: ReportFn): void {
	hooks.notice = fn;
}
// Called when a lane's turn has ended and it is idle again (after its report had its chance to go out); main.ts sends
// the web messages queued for that lane.
export function setIdleHandler(fn: (name: string) => void): void {
	hooks.idle = fn;
}

// Tests: bring every piece of module state back to its import-time value (a lane or handler left by one test file must not leak into the next).
export function resetLaneStateForTest(): void {
	lanes.clear();
	hooks.report = () => {};
	hooks.progress = () => {};
	hooks.notice = () => {};
	hooks.idle = () => {};
	ownerHandlers = noopOwnerHandlers();
	ownerNotes = newOwnerNotes();
}

// Before a stop releases the lane's thread (which drops the channel map's parent), copy the parent onto the lane record.
export function keepHome(lane: Lane | undefined, parent: { home: string; homeName?: string } | undefined): void {
	if (!lane || !parent || lane.home) return;
	lane.home = parent.home;
	if (parent.homeName) lane.homeName = parent.homeName;
	persist(lane);
}

export const dir = (name: string) => join(paths.lanes, name);
// Where the lane lives in Discord (its own channel, or the thread under `home`), read for lane:<name> when the channel map has no entry.
export function laneSpot(name: string): { channel?: string; home?: string; title?: string } | undefined {
	const l = lanes.get(name);
	if (l) return { channel: l.channel, home: l.home, title: l.title };
	try {
		return JSON.parse(readFileSync(join(dir(name), "lane.json"), "utf8")) as { channel?: string; home?: string; title?: string };
	} catch {
		return undefined;
	}
}
// A thread lane's `home` is its parent channel; a lane with its own channel has none.
export function rememberSpot(name: string, channel: string | undefined, home?: string): void {
	const l = lanes.get(name);
	if (!l || l.channel === channel) return;
	if (channel) l.channel = channel;
	else delete l.channel;
	if (channel && home && !l.home) l.home = home;
	persist(l);
}
export function persist(lane: Lane): void {
	// The parent project set on disk (an older gateway or a manual backfill) is never dropped by a record that lacks it.
	if (!lane.home) {
		try {
			const disk = JSON.parse(readFileSync(join(dir(lane.name), "lane.json"), "utf8")) as { home?: string; homeName?: string };
			if (disk.home) Object.assign(lane, { home: disk.home }, disk.homeName ? { homeName: disk.homeName } : {});
		} catch {
			// no record yet
		}
	}
	const { name, title, cwd, model, workerModel, fableOk, status, startedAt, sessionFile, runtime, reports, lastReportAt, parked, held, worktree, claim, pendingAsk, waiting, home, homeName, channel } = lane;
	mkdirSync(dir(name), { recursive: true });
	writeAtomic(join(dir(name), "lane.json"), `${JSON.stringify({ name, ...(title ? { title } : {}), cwd, model, workerModel, ...(fableOk ? { fableOk } : {}), status, startedAt, sessionFile, ...(runtime ? { runtime } : {}), reports, ...(lastReportAt ? { lastReportAt } : {}), ...(parked ? { parked } : {}), ...(held?.length ? { held } : {}), ...(worktree ? { worktree } : {}), ...(claim ? { claim } : {}), ...(pendingAsk ? { pendingAsk } : {}), ...(waiting ? { waiting } : {}), ...(home ? { home, ...(homeName ? { homeName } : {}) } : {}), ...(channel ? { channel } : {}) }, null, 2)}\n`);
}
export function setStatus(lane: Lane, status: LaneStatus): void {
	if (lane.status === status) return;
	const wasLive = laneLive(lane);
	lane.status = status;
	if (status === "working") lane.workingSince = Date.now();
	persist(lane);
	// Every lane list in the web app re-reads the state on this frame, so an ended lane leaves them at once.
	broadcast({ kind: "lanes", lane: lane.name, status, live: laneLive(lane), was_live: wasLive });
}

// Compaction needs an idle process: a runtime may abort a running turn to compact, so a busy lane queues it until turn_end.
export const portOf = (lane: Lane): CompactPort => ({ idle: () => lane.status === "idle", compact: () => lane.proc?.compact(), refreshUsage: () => lane.proc?.refreshUsage() });

// A finished turn's report goes out at turn_end, as 오모냥 replied the moment its turn ended (DOTZ_REPORT_DEBOUNCE_MS
// can add a wait). It is kept on disk until sent, so a gateway restart in between sends it on the next start.
export const pendingFile = (lane: Lane) => join(dir(lane.name), "pending-report.md");

export const laneWorkerModel = (lane: Pick<Lane, "workerModel">) => lane.workerModel ?? workerModel();

// Throwaway projects (lanes run in a temp folder, e.g. gateway tests) are never shown as live lanes.
export const isTempLane = (l: Pick<Lane, "cwd" | "worktree">): boolean => TEMP_PATH.test(l.worktree?.repo ?? l.cwd) || TEMP_PATH.test(l.cwd);
// The one definition of a live lane every list uses (home, lane tab, target chips, sidebar, pickers, palette): not exited,
// its process up (or being restarted in place), and not a temp test project. Ended lanes keep all their data.
export const laneRunning = (l: Lane): boolean => l.status !== "exited" && (Boolean(l.proc) || Boolean(l.quiet) || l.status === "starting");
export const laneLive = (l: Lane): boolean => laneRunning(l) && !isTempLane(l);
