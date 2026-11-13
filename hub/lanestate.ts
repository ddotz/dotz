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
type Claim = { state: "reported" | "verified"; at: string; evidence?: string; problems?: string[]; /** The owner wrote after it: it no longer closes the lane (laneunfinished.ts). */ reopened?: boolean };
// A lane's own [ask] report stays a question for the owner until the owner answers (sendToLane) or the lane reports again.
// The full text also sits in pending-ask.md (dir(name)) while pending, because report.md is overwritten by gateway notices.
type Ask = { text: string; at: string };
// Continuation turns a gateway restart gave a lane on one unchanged plan (laneops.ts restoreLanes); on disk, since restarts are what it counts.
type RestartWakes = { plan: string; count: number; nextAt?: number };
// `runtime`: the runtime that wrote sessionFile (omo, omp, claude); a session is only ever resumed by that runtime.
export type Record_ = { name: string; title?: string; cwd: string; model: string; workerModel?: string; /** workerModel was recorded by the lane itself (lane-cli), not picked by the owner (lanerun.ts ownerAsked). */ workerByLane?: boolean; fableOk?: boolean; status: LaneStatus; startedAt: string; endedAt?: string; sessionFile?: string; runtime?: string; reports: number; lastReportAt?: string; parked?: boolean; held?: string[]; /** Sent again after a busy session refused it (laneevents.ts refusedTurn); on disk, so a restart sends it too. */ refused?: { text: string; tries: number }; /** A compaction finished and the lane has not yet been shown its footer again (identity and rules): cleared at the next turn start when the process holds the extension's re-read, else the next gateway prompt carries the footer (laneprompt.ts). */ contractDue?: boolean; /** Its last report was an [ask] with no choice block, refused and kept as a plain note (lanereport.ts): still a question. */ bareAsk?: boolean; /** The owner stopped this lane or its turn: it is not brought back until someone writes to it. */ ownerStopped?: boolean; /** Its process ended by itself with work unfinished (lanerun.ts); the resume sweep brings it back. */ died?: { at: string; code: number }; /** A network failure stopped its work (lanereconnect.ts); on disk, so a restart keeps it. resumed: this outage's one resume went out. */ interrupted?: { resumed?: boolean }; worktree?: Worktree; claim?: Claim; pendingAsk?: Ask; restartWakes?: RestartWakes; waiting?: string; home?: string; homeName?: string; channel?: string; web?: boolean; /** Session key of the conversation that launched it (none = main): its reports go back to that session (lanerelay.ts). */ from?: string; /** Started for another computer (hub/fleet-launch.ts): that computer's name and the conversation there that asked; its reports go back to it. */ peer?: { name: string; conv: string } };
export type Lane = Record_ & {
	ctx: Ctx;
	// The orchestrator sent work (launch, dotz_lane send) that no relayed report answered yet; an owner-only exchange in
	// the lane channel leaves it false, so that reply is not relayed (lanerelay.ts); unknown (a restored lane) relays.
	orchAsked?: boolean;
	// The turn now running began from main's answer to this lane's own request (dotz_main, lane-handback.ts): it may not hand main work again.
	handedBack?: true;
	lastText: string;
	// [done] reports the gateway's Done-when check sent back in a row (lanereport.ts); past DONE_BOUNCES the orchestrator gets it.
	doneBounces?: number;
	// lastText was written by a turn and no report has carried it yet: a turn that ends without new text (aborted, empty)
	// must not report the previous answer again (mail-reply-drafts 2026-10-23 00:45:11, the same answer twice).
	unreported?: boolean;
	// The text the lane last reported since its last turn_start: the same text again before a new turn starts is one event
	// delivered twice (two error frames of one failed request, tailnet-monitoring 2026-10-23 02:58 and 03:03), not a new report.
	reportedThisTurn?: string;
	/** Unfinished and on its way back (laneresume.ts): what the run line says instead of 쉬는 중; set by the sweep, so /api/state reads no transcript. */
	resumeDue?: { state: "due" | "capacity" | "stuck"; detail?: string };
	proc?: AgentProcess;
	timer?: ReturnType<typeof setTimeout>;
	watchdog?: ReturnType<typeof setTimeout>;
	resumeTimer?: ReturnType<typeof setTimeout>;
	quiet?: boolean;
	// Set to restart the process on the same session once it exits: text is the resume prompt (none = back to idle).
	revive?: { text?: string };
	lastFrameAt?: number;
	/** Owner messages steered into the running turn since its turn_start: a stuck-turn recovery sends them again (lanerun.ts recover). */
	steered?: string[];
	/** An owner abort the process may ignore: killed and resumed idle when the turn is still running at its end (laneops.ts abortLane). */
	abortTimer?: Timer;
	recoveries?: number[];
	recoveryCapped?: boolean;
	workingSince?: number;
	pauseReported?: boolean;
	pausing?: boolean;
	pauseKind?: ProviderErrorKind;
	/** Paused on the subscription's usage limit (not a billing/auth block, not a spend cap): the usage check may lift it early. */
	limitPause?: boolean;
	/** The limit lifted and the held work went back in; no turn has started on it yet (the web line says so). */
	resuming?: boolean;
	transientTries?: number;
	transientTimer?: Timer;
	progressAt?: number;
	progressText?: string;
	// Set while the handover turn of a rotated session runs: that turn only reloads context, so its reply is not a report.
	silent?: { lastText: string };
	// A bare [ask] (no choice block) went back to the lane; the next one is a plain note. An owner message or a real card resets it.
	askRefused?: boolean;
	// A report with a bare "unverified" line went back to the lane once; the next report goes through and clears it (hub/lanereport.ts).
	unverifiedRefused?: boolean;
	// A report with a word of the owner's list (hub/word-ban.ts) went back to the lane once; the next clean report clears it.
	bannedRefused?: boolean;
	// A [wait] naming main with no for-line went back to the lane once; the next report goes through and clears it (hub/lanereport.ts).
	waitMainRefused?: boolean;
	// Set when a compaction finished: the next prompt sent to the process carries the retain nudge once (no extra turn).
	retainNext?: boolean;
	// This process holds the extension's re-read of the contract as a next-turn message (set with contractDue when its runtime loads the extension; reset at every spawn).
	contractQueued?: boolean;
	// Set when the owner changed the workers' model of a running idle lane: its next prompt tells it once (no extra turn).
	workerNext?: string;
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
	/** Why the last start failed (lanerun.ts startFailed). */
	startError?: string;
	/** The orchestrator was told this queued lane waits too long (laneops.ts startQueuedLanes). */
	queueTold?: boolean;
	// The last text sent as a new turn (not a steer) until the model answers (laneevents.ts refusedTurn).
	prompted?: string;
	/** The process a prompt went to whose turn has not started yet: the owner's next message joins that turn. */
	startingOn?: unknown;
	refusedTimer?: Timer;
};

export const lanes = new Map<string, Lane>();
type ReportFn = (lane: Lane, text: string, answeringOwner?: boolean, pause?: boolean) => void;
export const hooks: { report: ReportFn; progress: ReportFn; notice: ReportFn; idle: (name: string) => void; verified: (name: string, text: string) => void; openCard: (name: string) => boolean } = { report: () => {}, progress: () => {}, notice: () => {}, idle: () => {}, verified: () => {}, openCard: () => false };
// Owner messages sent to a lane and not answered yet (lanerelay.ts createOwnerNotes): the lane's short answer note at its next
// tool boundary reaches the owner at once, and the delivery state of each message follows (hub/events.ts emitDelivery).
export type OwnerNoteHandlers = { note: (lane: string, text: string, refs: string[]) => void; answered: (lane: string, refs: string[]) => void; refused?: (lane: string, refs: string[]) => void; lost: (lane: string, refs: string[]) => void };
const noopOwnerHandlers = (): OwnerNoteHandlers => ({ note: () => {}, answered: () => {}, lost: () => {} });
let ownerHandlers: OwnerNoteHandlers = noopOwnerHandlers();
export function setOwnerNoteHandlers(h: OwnerNoteHandlers): void {
	ownerHandlers = h;
}
const newOwnerNotes = () => createOwnerNotes({ note: (l, t, r) => ownerHandlers.note(l, t, r), answered: (l, r) => ownerHandlers.answered(l, r), refused: (l, r) => ownerHandlers.refused?.(l, r), lost: (l, r) => ownerHandlers.lost(l, r) });
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
// Called when the gateway itself verified a lane's [done] (every Done-when check passed): the worklog entry turns verified.
export function setVerifiedHandler(fn: (name: string, text: string) => void): void {
	hooks.verified = fn;
}
// Whether a decision card of this lane still waits on the owner (hub/notices.ts): a "still waiting" [ask] then makes no new item.
export function setOpenCardCheck(fn: (name: string) => boolean): void {
	hooks.openCard = fn;
}

// Tests: bring every piece of module state back to its import-time value (a lane or handler left by one test file must not leak into the next).
export function resetLaneStateForTest(): void {
	lanes.clear();
	hooks.report = () => {};
	hooks.progress = () => {};
	hooks.notice = () => {};
	hooks.idle = () => {};
	hooks.verified = () => {};
	hooks.openCard = () => false;
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
// `web`: started from the web with no Discord place (threads.ts lanePlace); nothing of it goes to Discord.
export function laneSpot(name: string): { channel?: string; home?: string; title?: string; web?: boolean } | undefined {
	const l = lanes.get(name);
	if (l) return { channel: l.channel, home: l.home, title: l.title, web: l.web };
	try {
		return JSON.parse(readFileSync(join(dir(name), "lane.json"), "utf8")) as { channel?: string; home?: string; title?: string; web?: boolean };
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
	const { name, title, cwd, model, workerModel, workerByLane, fableOk, status, startedAt, endedAt, sessionFile, runtime, reports, lastReportAt, parked, held, refused, contractDue, bareAsk, ownerStopped, died, interrupted, worktree, claim, pendingAsk, restartWakes, waiting, home, homeName, channel, web, from, peer } = lane;
	mkdirSync(dir(name), { recursive: true });
	writeAtomic(join(dir(name), "lane.json"), `${JSON.stringify({ name, ...(title ? { title } : {}), cwd, model, workerModel, ...(workerByLane ? { workerByLane } : {}), ...(fableOk ? { fableOk } : {}), status, startedAt, ...(endedAt ? { endedAt } : {}), sessionFile, ...(runtime ? { runtime } : {}), reports, ...(lastReportAt ? { lastReportAt } : {}), ...(parked ? { parked } : {}), ...(held?.length ? { held } : {}), ...(refused ? { refused } : {}), ...(contractDue ? { contractDue } : {}), ...(bareAsk ? { bareAsk } : {}), ...(ownerStopped ? { ownerStopped } : {}), ...(died ? { died } : {}), ...(interrupted ? { interrupted } : {}), ...(worktree ? { worktree } : {}), ...(claim ? { claim } : {}), ...(pendingAsk ? { pendingAsk } : {}), ...(restartWakes ? { restartWakes } : {}), ...(waiting ? { waiting } : {}), ...(home ? { home, ...(homeName ? { homeName } : {}) } : {}), ...(channel ? { channel } : {}), ...(web ? { web } : {}), ...(from ? { from } : {}), ...(peer ? { peer } : {}) }, null, 2)}\n`);
}
export function setStatus(lane: Lane, status: LaneStatus): void {
	if (lane.status === status) return;
	const wasLive = laneLive(lane);
	lane.status = status;
	if (status === "working") lane.workingSince = Date.now();
	// The end moment: what came before it stays read once the lane runs again (hub/conversations.ts unreadOf).
	if (status === "exited") lane.endedAt = new Date().toISOString();
	persist(lane);
	// Every lane list in the web app re-reads the state on this frame, so an ended lane leaves them at once.
	broadcast({ kind: "lanes", lane: lane.name, status, live: laneLive(lane), was_live: wasLive });
}

// Compaction needs an idle process: a runtime may abort a running turn to compact, so a busy lane queues it until turn_end.
export const portOf = (lane: Lane): CompactPort => ({ idle: () => lane.status === "idle", compact: () => lane.proc?.compact(), refreshUsage: () => lane.proc?.refreshUsage() });

// A finished turn's report goes out at turn_end, as the earlier secretary replied the moment its turn ended (DOTZ_REPORT_DEBOUNCE_MS
// can add a wait). It is kept on disk until sent, so a gateway restart in between sends it on the next start.
export const pendingFile = (lane: Lane) => join(dir(lane.name), "pending-report.md");

export const laneWorkerModel = (lane: Pick<Lane, "workerModel">) => lane.workerModel ?? workerModel();

// Throwaway projects (lanes run in a temp folder, e.g. gateway tests) are never shown as live lanes.
export const isTempLane = (l: Pick<Lane, "cwd" | "worktree">): boolean => TEMP_PATH.test(l.worktree?.repo ?? l.cwd) || TEMP_PATH.test(l.cwd);
// The one definition of a live lane every list uses (home, lane tab, target chips, sidebar, pickers, palette): not exited,
// its process up (or being restarted in place), and not a temp test project. Ended lanes keep all their data.
export const laneRunning = (l: Lane): boolean => l.status !== "exited" && (Boolean(l.proc) || Boolean(l.quiet) || l.status === "starting");
export const laneLive = (l: Lane): boolean => laneRunning(l) && !isTempLane(l);
