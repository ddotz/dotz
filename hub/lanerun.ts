import { type Lane, setStatus, dir, laneWorkerModel, ownerNotes, hooks, pendingFile } from "./lanestate.ts";
import { HARNESS_NAMES, runtimeFor } from "./runtime/index.ts";
import { msg } from "./i18n.ts";
import { HUB_TOKEN, log, chainAfter, compactAtFor, fallbackChain, parseSelector, lanesCompactAt, lanesKeepRecent } from "./config.ts";
import { isExpensive } from "./lanegates.ts";
import { markSteers, steerContract, steerToken } from "./steer-mark.ts";
import { hubChain, Chain, keyedWorker, Reverter, workerKeyEnv } from "./fallback.ts";
import { pauseExhausted } from "./lanefailover.ts";
import { statusActivity, endSubagents, runningSubagents } from "./activity.ts";
import { createStuckWatch, stuckLine, takeSnapshot } from "./stuck.ts";
import { readEvents } from "./laneevents.ts";
import { abandonCompact } from "./context.ts";
import { report, withHeld } from "./lanereport.ts";
import { withWorktree } from "./lanetree.ts";
import { prompt } from "./laneprompt.ts";
import { writeContract } from "./lanefooter.ts";
import { existsSync, rmSync } from "node:fs";
import { laneLimits } from "./lanelimits.ts";
import { unfinishedWork } from "./laneunfinished.ts";

export const RECOVERY_MAX = 3;
export const RECOVERY_WINDOW_MS = 60 * 60_000;

// One stuck-turn watch per lane (hub/stuck.ts): fed by the lane's events (laneevents.ts), it aborts a turn that shows no progress for
// stuckTurnMs() and recovers the lane on the same session when the abort does not end the turn. Waiting on a subagent, a compaction or
// an owner question is not a stall. The line goes to the lane's own channel only; past the hourly cap the orchestrator is told once.
const watches = new WeakMap<Lane, ReturnType<typeof createStuckWatch>>();
export function laneStuck(lane: Lane): ReturnType<typeof createStuckWatch> {
	let w = watches.get(lane);
	if (!w) {
		w = createStuckWatch({
			key: `lane:${lane.name}`,
			pid: () => lane.proc?.pid,
			sessionFile: () => lane.sessionFile,
			exempt: () => lane.status !== "working" || !lane.proc || runningSubagents(`lane:${lane.name}`) > 0 || lane.ctx.compaction.state === "queued" || lane.ctx.compaction.state === "compacting" || Boolean(lane.pendingAsk),
			abort: () => lane.proc?.abort(),
			restart: why => recover(lane, `${why} (턴이 끝나지 않았어요)`, true, true),
			stuck: minutes => hooks.notice(lane, `작업이 ${minutes}분 동안 멈춰 있어서 끊고 다시 이어가요.`),
			capped: minutes => hooks.report(lane, `[lane stuck] 턴이 ${minutes}분 동안 멈춰 있어요. 한 시간 안에 ${RECOVERY_MAX}번 자동 복구했는데 또 멈춰서 더는 건드리지 않아요. 직접 확인해 주세요.`),
		});
		watches.set(lane, w);
	}
	return w;
}

// The runtime whose session file a lane holds: recorded at spawn, else (a lane saved before it was recorded) read from the
// session's place: omp keeps sessions under ~/.omp, OmO under ~/.omo (or its agent dir), Claude Code names a bare id.
export function sessionRuntime(l: Pick<Lane, "runtime" | "sessionFile">): string | undefined {
	if (l.runtime) return l.runtime;
	const f = l.sessionFile;
	if (!f) return undefined;
	if (/\/\.omp\//.test(f)) return "omp";
	const omoDir = process.env.OMO_CODING_AGENT_DIR;
	if (/\/\.omo\//.test(f) || (omoDir && f.startsWith(`${omoDir}/`))) return "omo";
	return f.includes("/") ? undefined : "claude";
}
export const harnessName = (id: string) => HARNESS_NAMES[id] ?? id;

// A session is never resumed by another runtime than the one that wrote it: an omp session handed to OmO killed the lane
// at once (gateway-ui, 2026-10-20 17:16), and a resumed foreign session would also lose its prompt cache. The owner is
// offered a handover instead (handoverLane): the same lane in a fresh session on the current runtime.
export class LaneRuntimeMismatch extends Error {
	constructor(readonly lane: string, readonly from: string, readonly to: string) {
		super(msg().laneRuntimeRefused(lane, harnessName(from), harnessName(to)));
	}
}
export function runtimeMismatch(lane: Pick<Lane, "name" | "runtime" | "sessionFile">): LaneRuntimeMismatch | undefined {
	const from = sessionRuntime(lane);
	const to = runtimeFor("lane").id;
	return from && from !== to ? new LaneRuntimeMismatch(lane.name, from, to) : undefined;
}

// Starts the lane's process; false when a resume is refused because the session belongs to another runtime (the lane is
// then left exited, untouched).
// A process that could not start leaves the lane ended, never "starting" with no process holding a slot (acme-allowance-review on the
// Mac mini, 2026-10-29, kept the next lane waiting for memory). A start nobody is waiting on (a resume) is reported to the
// orchestrator as a failure to fix; a launch returns the error to its caller (laneops begin).
function startFailed(lane: Lane, why: string, resume: boolean): void {
	lane.proc = undefined;
	lane.died = undefined;
	lane.startError = why;
	setStatus(lane, "exited");
	log(`lane ${lane.name} could not start: ${why}`);
	if (resume) report(lane, `[fail] 세션 프로세스를 다시 띄우지 못했어요: ${why}. 원인(작업 폴더, 하네스, 모델)을 고쳐 다시 띄우세요.`, true);
}

// The lane's guard counts Fable as owner-asked when the lane was launched with owner_asked_for_fable, or when the lane or its task
// workers run a Fable model the owner picked (a model picker, /model, or the lanes/workers defaults). A launch that names Fable is
// refused without the ask (hub/routes-lanes.ts), and a worker switch the lane recorded itself (workerByLane) is not the owner's pick.
export const ownerAsked = (lane: Pick<Lane, "fableOk" | "model" | "workerModel" | "workerByLane">): boolean =>
	Boolean(lane.fableOk) || isExpensive(parseSelector(lane.model).model) || (!lane.workerByLane && isExpensive(parseSelector(laneWorkerModel(lane)).model));

export function spawn(lane: Lane, resume: boolean): boolean {
	if (resume) {
		const wrong = runtimeMismatch(lane);
		if (wrong) {
			log(`lane ${lane.name} not resumed: its session was written by ${wrong.from}, lanes run on ${wrong.to}`);
			setStatus(lane, "exited");
			return false;
		}
	}
	lane.runtime = runtimeFor("lane").id;
	const entries = chainAfter(lane.model, fallbackChain("lanes"));
	// The hub switches the chain itself on OmO, and on omp when an entry is conditional (fallback.ts hubChain); otherwise the
	// runtime gets the models as its own plain fallback list.
	const driven = hubChain(runtimeFor("lane").id, entries);
	lane.chain = driven ? new Chain(lane.model, driven, parseSelector(lane.model).thinking) : undefined;
	lane.capped = undefined;
	let spawnModel = lane.model;
	const env: Record<string, string> = { DOTZ_LANE: lane.name, ...(ownerAsked(lane) ? { DOTZ_OWNER_ASKED_FABLE: "1" } : {}) };
	if (lane.chain) {
		const until = lane.chain.exhaustedUntil();
		if (until !== undefined) {
			pauseExhausted(lane, lane.chain, until);
			return true;
		}
		lane.chain.active = lane.chain.initial();
		spawnModel = lane.chain.selector(lane.chain.active);
		Object.assign(env, lane.chain.env(lane.chain.active, laneWorkerModel(lane)));
	}
	// The workers' own chain may stand on an API-key entry; a process already on a key follows that entry's `workers` switch instead.
	if (!env.DOTZ_KEY_PROVIDER) Object.assign(env, workerKeyEnv(laneWorkerModel(lane), fallbackChain("workers")));
	// On a keyed entry that lets workers use the key, the lane's task workers run on the key provider's copy of the worker model.
	const keyedWorkers = keyedWorker(env);
	const workerModel = keyedWorkers ?? laneWorkerModel(lane);
	lane.workerSlots = laneLimits(lane).workers;
	let proc: ReturnType<ReturnType<typeof runtimeFor>["start"]>;
	try {
	// posix_spawn with a missing cwd reports ENOENT for the binary (`omo`), which hides the real cause.
	if (!existsSync(lane.cwd)) throw new Error(`working directory does not exist: ${lane.cwd}`);
	// Rewritten at every spawn, with the rest of the lane's settings: the extension re-reads it after a compaction.
	env.DOTZ_LANE_CONTRACT = writeContract(lane);
	const steer = steerToken(HUB_TOKEN, `lane:${lane.name}`);
	proc = markSteers(runtimeFor("lane").start({
		role: "lane",
		systemNote: steerContract(steer),
		cwd: lane.cwd,
		model: spawnModel,
		// A plain list cannot bill through a key: those entries are left out (on Claude Code one would repeat the main model).
		fallback: lane.chain ? [] : entries.filter(e => !e.key_file).map(e => e.model),
		hubSwitches: Boolean(lane.chain),
		resume: resume ? lane.sessionFile : undefined,
		// The omp-side orchestrator-guard blocks Fable / max-effort worker spawns unless the owner asked for them.
		env,
		// Rewritten at every spawn so changed lanes.* settings apply the next time the lane starts or resumes.
		lane: { name: lane.name, dir: dir(lane.name), workerModel, workerFallback: keyedWorkers ? [] : chainAfter(laneWorkerModel(lane), fallbackChain("workers")).filter(e => !e.key_file).map(e => e.model), compactAt: compactAtFor(spawnModel, lanesCompactAt()), keepRecent: lanesKeepRecent(), workerSlots: lane.workerSlots },
	}), steer);
	} catch (e) {
		startFailed(lane, (e as Error).message, resume);
		return false;
	}
	lane.activeModel = spawnModel;
	lane.contractQueued = undefined; // a new process holds no queued re-read
	lane.startedModel = spawnModel;
	lane.reverter = new Reverter();
	lane.chained = !lane.chain && entries.length > 0;
	lane.activeWorkerModel = workerModel;
	lane.proc = proc;
	lane.quiet = false;
	lane.spawnedAt = Date.now();
	lane.parked = undefined;
	lane.died = undefined;
	lane.resumeDue = undefined;
	lane.revive = undefined;
	lane.lastFrameAt = Date.now();
	setStatus(lane, "starting");
	statusActivity(`lane:${lane.name}`, `lane process ${resume ? "resumed" : "started"} (${lane.model})`);
	void readEvents(lane, proc);
	void proc.exited.then(code => {
		if (lane.proc !== proc) return;
		lane.proc = undefined;
		abandonCompact(lane.ctx, "the lane process exited");
		clearTimeout(lane.watchdog);
		clearTimeout(lane.abortTimer);
		lane.abortTimer = undefined;
		laneStuck(lane).reset();
		clearTimeout(lane.resumeTimer);
		lane.resumeTimer = undefined;
		clearTimeout(lane.transientTimer);
		clearTimeout(lane.errorHold);
		lane.transientTimer = undefined;
		endSubagents(`lane:${lane.name}`);
		statusActivity(`lane:${lane.name}`, `lane process exited (code ${code})`);
		if (lane.quiet) return log(`lane ${lane.name} stopped for a gateway restart`);
		// Read before the exit notice below replaces report.md. Nobody asked for this exit, and a turn it cut off is work whatever came before.
		if (!lane.revive && !lane.ownerStopped && (lane.status === "working" || lane.status === "starting" || unfinishedWork(lane))) {
			lane.died = { at: new Date().toISOString(), code };
			lane.resumeDue = { state: "due" };
		}
		setStatus(lane, "exited");
		log(`lane ${lane.name} exited (${code})`);
		if (!lane.revive) ownerNotes.lost(lane.name);
		if (lane.revive && lane.sessionFile) {
			const { text } = lane.revive;
			if (text) resumeLane(lane, text);
			else if (spawn(lane, true)) setStatus(lane, "idle");
			return;
		}
		if (code !== 0 && code !== 143) report(lane, `[lane exited] 프로세스가 종료됐어요 (code ${code}). 마지막 상태: ${lane.lastText.slice(0, 300) || "없음"}`, true);
	});
	proc.watchSubagents();
	setTimeout(() => lane.proc?.refreshSession(), 3000);
	return true;
}

// A lane stopped after its merge lost its worktree (dropWorktree moved cwd back to the owner's checkout); resuming it
// would edit that checkout directly, so it gets a fresh worktree from the current HEAD and is told the new path.
export function resumeLane(lane: Lane, text: string): void {
	clearTimeout(lane.resumeTimer);
	lane.resumeTimer = undefined;
	if (runtimeMismatch(lane)) {
		spawn(lane, true);
		return;
	}
	if (lane.interrupted) lane.interrupted.resumed = true;
	text = withWorktree(lane, text);
	spawn(lane, true);
	prompt(lane, withHeld(lane, text));
	log(`lane ${lane.name} resumed ${lane.sessionFile}`);
}

// The reason laneevents.ts recovers a failed compaction with: its revive text names the compaction, not a process that stopped responding.
export const COMPACTION_FAILED = "컨텍스트 압축이 실패했어요";

// Recovers a lane that cannot go on (a stuck turn that ignored its abort, or a failed compaction) by killing its process,
// then resumes the same session: a turn that was running is told to continue, an idle lane just comes back idle.
export function recover(lane: Lane, why: string, wasWorking: boolean, stuck = false): void {
	if (!lane.proc || !lane.sessionFile || lane.revive) return;
	const t = Date.now();
	lane.recoveries = (lane.recoveries ?? []).filter(at => t - at < RECOVERY_WINDOW_MS);
	if (lane.recoveries.length >= RECOVERY_MAX) {
		lane.lastFrameAt = t;
		if (lane.recoveryCapped) return;
		lane.recoveryCapped = true;
		log(`lane ${lane.name} needs recovery (${why}) but already recovered ${RECOVERY_MAX} times in the last hour`);
		hooks.report(lane, `[lane stuck] ${why}. 한 시간 안에 ${RECOVERY_MAX}번 자동 복구했는데 또 멈춰서 더는 건드리지 않아요. 직접 확인해 주세요.`);
		return;
	}
	lane.recoveryCapped = false;
	lane.recoveries.push(t);
	clearTimeout(lane.timer);
	rmSync(pendingFile(lane), { force: true });
	if (lane.lastText.startsWith("[lane error]")) lane.lastText = "";
	log(`lane ${lane.name} recovering: ${why}`);
	// Bookkeeping: not a chat message and not an orchestrator turn. Only the final "[lane stuck]" above is reported.
	log(`lane ${lane.name} recovery ${lane.recoveries.length}/${RECOVERY_MAX}: restarting on the same session`);
	// Owner messages steered into the cut-off turn may not have been read: they go along with the continue text.
	const steered = wasWorking ? (lane.steered ?? []) : [];
	// A stuck recovery opens the revive text with the shape of the call the turn froze in, so it is not repeated.
	const info = stuck ? laneStuck(lane).info() : undefined;
	const lead = info ? `${stuckLine(info)}\n\n` : "";
	const stopped = !stuck && why === COMPACTION_FAILED ? msg().laneCompactFailed : msg().laneStopped;
	lane.revive = { text: wasWorking ? lead + stopped + (steered.length ? `\n\n${msg().laneSteered(steered)}` : "") : undefined };
	const p = lane.proc;
	// A stuck process leaves a diagnostic file first (hub/stuck.ts, a few seconds at most); the kill follows whatever happens to it.
	if (stuck) void takeSnapshot(`lane:${lane.name}`, p.pid, lane.sessionFile).then(() => lane.proc === p && p.kill(true));
	else p.kill(true);
}
