import { type Lane, setStatus, dir, laneWorkerModel, ownerNotes, hooks, pendingFile } from "./lanestate.ts";
import { HARNESS_NAMES, runtimeFor } from "./runtime/index.ts";
import { msg } from "./i18n.ts";
import { log, chainAfter, fallbackChain, parseSelector, lanesCompactAt, lanesKeepRecent } from "./config.ts";
import { hubChain, Chain, keyedWorker, Reverter, workerKeyEnv } from "./fallback.ts";
import { pauseExhausted } from "./lanefailover.ts";
import { statusActivity, endSubagents } from "./activity.ts";
import { readEvents } from "./laneevents.ts";
import { abandonCompact } from "./context.ts";
import { report, withHeld } from "./lanereport.ts";
import { withWorktree } from "./lanetree.ts";
import { prompt } from "./laneprompt.ts";
import { rmSync } from "node:fs";
import { laneLimits } from "./lanelimits.ts";

export const RECOVERY_MAX = 3;
export const RECOVERY_WINDOW_MS = 60 * 60_000;

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
	const env: Record<string, string> = { DOTZ_LANE: lane.name, ...(lane.fableOk ? { DOTZ_OWNER_ASKED_FABLE: "1" } : {}) };
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
	lane.workerSlots = laneLimits(0, lane).workers;
	const proc = runtimeFor("lane").start({
		role: "lane",
		cwd: lane.cwd,
		model: spawnModel,
		// A plain list cannot bill through a key: those entries are left out (on Claude Code one would repeat the main model).
		fallback: lane.chain ? [] : entries.filter(e => !e.key_file).map(e => e.model),
		hubSwitches: Boolean(lane.chain),
		resume: resume ? lane.sessionFile : undefined,
		// The omp-side orchestrator-guard blocks Fable / max-effort worker spawns unless the owner asked for them.
		env,
		// Rewritten at every spawn so changed lanes.* settings apply the next time the lane starts or resumes.
		lane: { name: lane.name, dir: dir(lane.name), workerModel, workerFallback: keyedWorkers ? [] : chainAfter(laneWorkerModel(lane), fallbackChain("workers")).filter(e => !e.key_file).map(e => e.model), compactAt: lanesCompactAt(), keepRecent: lanesKeepRecent(), workerSlots: lane.workerSlots },
	});
	lane.activeModel = spawnModel;
	lane.startedModel = spawnModel;
	lane.reverter = new Reverter();
	lane.chained = !lane.chain && entries.length > 0;
	lane.activeWorkerModel = workerModel;
	lane.proc = proc;
	lane.quiet = false;
	lane.spawnedAt = Date.now();
	lane.parked = undefined;
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
		clearTimeout(lane.resumeTimer);
		lane.resumeTimer = undefined;
		clearTimeout(lane.transientTimer);
		clearTimeout(lane.errorHold);
		lane.transientTimer = undefined;
		endSubagents(`lane:${lane.name}`);
		statusActivity(`lane:${lane.name}`, `lane process exited (code ${code})`);
		if (lane.quiet) return log(`lane ${lane.name} stopped for a gateway restart`);
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
	text = withWorktree(lane, text);
	spawn(lane, true);
	prompt(lane, withHeld(lane, text));
	log(`lane ${lane.name} resumed ${lane.sessionFile}`);
}

// Aborts a lane that cannot go on (a turn with no frames for STALL_MS, or a failed compaction) by killing its process,
// then resumes the same session: a turn that was running is told to continue, an idle lane just comes back idle.
export function recover(lane: Lane, why: string, wasWorking: boolean): void {
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
	hooks.report(lane, `[lane recovery] ${why}. 진행 중이던 요청을 중단하고 같은 대화 기록으로 다시 이어서 시작해요 (${lane.recoveries.length}/${RECOVERY_MAX}).`);
	lane.revive = { text: wasWorking ? msg().laneStopped : undefined };
	lane.proc.kill(true);
}
