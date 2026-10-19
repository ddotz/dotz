import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join, relative } from "node:path";
import { emitFrameActivity, endSubagents, runningSubagents, statusActivity } from "./activity.ts";
import { cfg, lanesCompactAt, lanesKeepRecent, lanesModel, log, now, OMP, parseSelector, paths, selectorOf, splitThinking, workerModel, writeAtomic } from "./config.ts";
import { modeFile, msg, withReplyLine } from "./i18n.ts";
import { abandonCompact, type CompactPort, type Compaction, compactionError, type Ctx, ctxView, flushCompact, newCtx, noteCompactResponse, noteMessageUsage, noteResponse, recentExchanges, requestCompact } from "./context.ts";
import { classifyProviderError, OWNER_RETRY_MS, type ProviderErrorKind, rateLimitDelay, TRANSIENT_RETRIES, transientBackoff } from "./providers.ts";

const REPORT_DEBOUNCE_MS = Number(process.env.DOTZ_REPORT_DEBOUNCE_MS ?? 0);
const PROGRESS_EVERY_MS = Number(process.env.DOTZ_PROGRESS_MS ?? 15 * 60_000);
const WATCHDOG_MS = 120_000;
// A turn in flight with no rpc frame for this long (a hung omp or provider call) is aborted and resumed; a lane
// recovers at most RECOVERY_MAX times per RECOVERY_WINDOW_MS, then it is left alone and the owner told once.
const STALL_MS = Number(process.env.DOTZ_STALL_MS ?? 20 * 60_000);
const RECOVERY_MAX = 3;
const RECOVERY_WINDOW_MS = 60 * 60_000;
const MAX_ACTIVE = cfg.lanes?.max_active ?? 4;
const BRIEF_MAX = 8000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DONE_RE = /(done[- ]?when|done\s*=|acceptance|완료\s*조건)/i;

export type LaneStatus = "starting" | "working" | "idle" | "rate-limited" | "exited";
// A lane in a git repo works in its own worktree (repo = the owner's checkout, base = the branch it lands on).
type Worktree = { path: string; repo: string; branch: string; base: string };
type Record_ = { name: string; cwd: string; model: string; workerModel?: string; fableOk?: boolean; status: LaneStatus; startedAt: string; sessionFile?: string; reports: number; held?: string[]; worktree?: Worktree };
export type Lane = Record_ & {
	ctx: Ctx;
	lastText: string;
	proc?: Subprocess<"pipe", "pipe", "pipe">;
	seq: number;
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
};

export const lanes = new Map<string, Lane>();
type ReportFn = (lane: Lane, text: string) => void;
let onReport: ReportFn = () => {};
let onProgress: ReportFn = () => {};
export function setReportHandler(fn: ReportFn): void {
	onReport = fn;
}
export function setProgressHandler(fn: ReportFn): void {
	onProgress = fn;
}

const dir = (name: string) => join(paths.lanes, name);
function persist(lane: Lane): void {
	const { name, cwd, model, workerModel, fableOk, status, startedAt, sessionFile, reports, held, worktree } = lane;
	mkdirSync(dir(name), { recursive: true });
	writeAtomic(join(dir(name), "lane.json"), `${JSON.stringify({ name, cwd, model, workerModel, ...(fableOk ? { fableOk } : {}), status, startedAt, sessionFile, reports, ...(held?.length ? { held } : {}), ...(worktree ? { worktree } : {}) }, null, 2)}\n`);
}
function setStatus(lane: Lane, status: LaneStatus): void {
	if (lane.status === status) return;
	lane.status = status;
	if (status === "working") lane.workingSince = Date.now();
	persist(lane);
}

function write(lane: Lane, frame: Record<string, unknown>): void {
	if (!lane.proc) return;
	lane.proc.stdin.write(`${JSON.stringify({ id: `h${++lane.seq}`, ...frame })}\n`);
	lane.proc.stdin.flush();
}

// Compaction needs an idle process: omp aborts a running turn to compact, so a busy lane queues it until agent_end.
const portOf = (lane: Lane): CompactPort => ({ idle: () => lane.status === "idle", send: frame => write(lane, frame) });

// A paused lane (rate limit) keeps owner messages on disk instead of starting turns that fail at once; they go in with
// the resume note.
function prompt(lane: Lane, text: string): void {
	lane.silent = undefined;
	if (lane.status === "rate-limited") {
		(lane.held ??= []).push(text);
		persist(lane);
		return;
	}
	write(lane, { type: lane.status === "working" ? "steer" : "prompt", message: text });
	if (lane.status === "working") return;
	clearTimeout(lane.watchdog);
	lane.watchdog = setTimeout(() => {
		log(`lane ${lane.name} did not start a turn after a prompt; restarting it`);
		lane.revive = { text: msg().laneStopped };
		lane.proc?.kill(9);
	}, WATCHDOG_MS);
}

function textOf(message: any): string {
	return (Array.isArray(message?.content) ? message.content : []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim();
}

// A finished turn's report goes out at agent_end, as 오모냥 replied the moment its turn ended (DOTZ_REPORT_DEBOUNCE_MS
// can add a wait). It is kept on disk until sent, so a gateway restart in between sends it on the next start.
const pendingFile = (lane: Lane) => join(dir(lane.name), "pending-report.md");

function report(lane: Lane, text: string): void {
	rmSync(pendingFile(lane), { force: true });
	lane.reports++;
	persist(lane);
	writeFileSync(join(dir(lane.name), "report.md"), `${text}\n`);
	onReport(lane, text);
}

// The omp budget gate opens only for a /budget-ok typed into the lane session, but the owner approves in Discord.
// When the lane's last report asked for /budget-ok and the owner answers with a short yes, the command goes in first.
const BUDGET_ASK_RE = /\/budget-ok/;
const APPROVE_RE = /^\s*(ㄱ+|ㄱㄱ|고+|ㅇㅋ|ㅇㅇ|오케이|ok(ay)?|go|yes|1번?|1\s*ㄱ+|진행(해|하자|해줘)?|해|해줘|바로)\s*[.!]*\s*$/i;
export function approvesBudget(name: string, text: string): boolean {
	const file = join(dir(name), "report.md");
	if (!APPROVE_RE.test(text) || !existsSync(file)) return false;
	return BUDGET_ASK_RE.test(readFileSync(file, "utf8"));
}

function scheduleReport(lane: Lane): void {
	if (lane.status !== "rate-limited") setStatus(lane, "idle");
	// A transient provider error is being retried: the failed turn is not a report.
	if (lane.transientTimer) return;
	if (lane.silent && !lane.lastText.startsWith("[lane error]")) {
		lane.lastText = lane.silent.lastText;
		lane.silent = undefined;
		rmSync(pendingFile(lane), { force: true });
		return;
	}
	lane.silent = undefined;
	if (lane.lastText) writeAtomic(pendingFile(lane), lane.lastText);
	clearTimeout(lane.timer);
	lane.timer = setTimeout(() => {
		if (lane.status !== "idle" || !lane.lastText) return;
		report(lane, lane.lastText);
	}, REPORT_DEBOUNCE_MS);
}

// The owner messages held during the pause ride along with the resume note and stay on disk until a turn succeeds.
function withHeld(lane: Lane, text: string): string {
	if (!lane.held?.length) return text;
	return msg().heldMessages(text, lane.held);
}

// A usage limit ("rate") waits for the window reset. A billing/auth error ("owner") waits for the owner to fix it, which
// nothing signals, so it is probed every OWNER_RETRY_MS; either way the owner gets one report and messages are held.
async function pauseForRateLimit(lane: Lane, err: string, kind: ProviderErrorKind): Promise<void> {
	if (lane.resumeTimer || lane.pausing) return;
	lane.pausing = true;
	setStatus(lane, "rate-limited");
	const owner = kind === "owner";
	const { ms: wait, reset } = owner ? { ms: OWNER_RETRY_MS, reset: false } : await rateLimitDelay(err, lane.model);
	lane.pausing = false;
	if (lane.status !== "rate-limited") return;
	const at = new Date(Date.now() + wait).toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
	if (!lane.pauseReported || lane.pauseKind !== kind) {
		report(lane, owner
			? `모델 제공자 결제/인증 문제로 멈췄어요 (${err.replace(/\s+/g, " ").slice(0, 160)}). 크레딧 충전이나 로그인 확인이 필요해요. 그동안 온 메시지는 모아뒀다가 해결되면 이어서 처리하고, ${Math.round(wait / 60_000)}분마다 다시 시도해요.`
			: `사용량 한도에 걸려서 멈췄어요. ${reset ? `한도가 리셋되는 ${at} 직후에` : `${at}쯤부터`} 다시 시도하고, 그동안 온 메시지는 모아뒀다가 이어서 처리해요.`);
	}
	lane.pauseReported = true;
	lane.pauseKind = kind;
	lane.resumeTimer = setTimeout(() => {
		lane.resumeTimer = undefined;
		setStatus(lane, "idle");
		prompt(lane, withHeld(lane, owner ? msg().laneProvider : msg().laneRate));
	}, wait);
}

// Overloaded/5xx/network errors: retry the failed turn with backoff, bounded. Returns false once the retries are spent,
// so the caller reports the error to the owner as a lane error. Owner messages are not held; a new turn cancels the
// pending retry and serves as the retry itself.
function retryTransient(lane: Lane, err: string): boolean {
	if (lane.transientTimer) return true;
	const tries = lane.transientTries ?? 0;
	if (tries >= TRANSIENT_RETRIES) {
		lane.transientTries = 0;
		return false;
	}
	lane.transientTries = tries + 1;
	const wait = transientBackoff(tries);
	log(`lane ${lane.name} provider error (${err.slice(0, 120)}); retry ${tries + 1}/${TRANSIENT_RETRIES} in ${Math.round(wait / 1000)}s`);
	lane.transientTimer = setTimeout(() => {
		lane.transientTimer = undefined;
		if (lane.status !== "idle") return;
		prompt(lane, msg().laneTransient);
	}, wait);
	return true;
}

async function readFrames(lane: Lane, proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of proc.stdout) {
		buffer += decoder.decode(chunk);
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			let f: any;
			try {
				f = JSON.parse(line);
			} catch {
				continue;
			}
			lane.lastFrameAt = Date.now();
			emitFrameActivity(`lane:${lane.name}`, f);
			noteResponse(lane.ctx, f);
			noteCompactResponse(lane.ctx, f, portOf(lane));
			const wasWorking = lane.status === "working";
			if (f.type === "agent_start") {
				clearTimeout(lane.watchdog);
				clearTimeout(lane.timer);
				clearTimeout(lane.transientTimer);
				lane.transientTimer = undefined;
				rmSync(pendingFile(lane), { force: true });
				setStatus(lane, "working");
				lane.progressAt = Date.now();
			} else if (f.type === "message_end" && f.message?.role === "assistant") {
				noteMessageUsage(lane.ctx, f.message);
				const text = textOf(f.message);
				const err = String(f.message.errorMessage ?? "");
				if (f.message.stopReason !== "error") lane.transientTries = 0;
				if (text) lane.lastText = text;
				// A compaction error is recovered by recover() below (restart on the same session), not retried here.
				else if (f.message.stopReason === "error" && !/compaction/i.test(err)) {
					const kind = classifyProviderError(err);
					if (kind === "rate" || kind === "owner") void pauseForRateLimit(lane, err, kind);
					else if (kind !== "transient" || !retryTransient(lane, err)) {
						lane.lastText = `[lane error] ${(err || "model request failed").slice(0, 300)}`;
						scheduleReport(lane);
					}
				}
			} else if (f.type === "agent_end") {
				scheduleReport(lane);
				if (lane.status === "idle" && (lane.pauseReported || lane.held?.length)) {
					lane.pauseReported = false;
					lane.held = undefined;
					persist(lane);
				}
				if (lane.status === "idle") {
					write(lane, { type: "get_session_stats" });
					flushCompact(lane.ctx, portOf(lane));
				}
			} else if (f.type === "response" && f.command === "get_state" && f.data?.sessionFile) {
				lane.sessionFile = f.data.sessionFile;
				persist(lane);
			}
			const failure = compactionError(f);
			if (failure) recover(lane, `컨텍스트 압축이 실패했어요 (${failure.slice(0, 120)})`, wasWorking);
		}
	}
}

// Per-run omp config overlay (--config): points the `task` role at the lane's worker model, so the lane plans and
// reviews on its own model while task workers (implementation, tests, renders, grind) run on the cheaper one, and
// sets omp's auto-compaction for both models to lanes.compact_at tokens (keeping the last lanes.keep_recent). Written at
// every spawn so changed lanes.* settings apply the next time the lane starts or resumes.
export const laneWorkerModel = (lane: Pick<Lane, "workerModel">) => lane.workerModel ?? workerModel();
function writeOverlay(lane: Lane): string {
	const file = join(dir(lane.name), "omp-overlay.yml");
	mkdirSync(dir(lane.name), { recursive: true });
	const thresholds = [...new Set([parseSelector(lane.model).model, parseSelector(laneWorkerModel(lane)).model])].map(m => `    ${JSON.stringify(m)}: ${JSON.stringify(`f${lanesCompactAt()}`)}\n`).join("");
	writeFileSync(file, `# Written by the dotz gateway each time lane ${lane.name} starts; passed to omp as --config.\nmodelRoles:\n  task: ${JSON.stringify(laneWorkerModel(lane))}\ntask:\n  agentModelOverrides:\n    task: "@task"\n    scout: "@task"\ncompaction:\n  modelThresholds:\n${thresholds}  keepRecentTokens: ${lanesKeepRecent()}\n`);
	return file;
}

function spawn(lane: Lane, resume: boolean): void {
	const proc = Bun.spawn([OMP, "--mode", "rpc", "--model", lane.model, `--config=${writeOverlay(lane)}`, ...(resume && lane.sessionFile ? ["--resume", lane.sessionFile] : [])], {
		cwd: lane.cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		// The omp-side orchestrator-guard blocks Fable / max-effort worker spawns unless the owner asked for them.
		env: { ...process.env, DOTZ_LANE: lane.name, ...(lane.fableOk ? { DOTZ_OWNER_ASKED_FABLE: "1" } : {}) },
	});
	lane.proc = proc;
	lane.quiet = false;
	lane.revive = undefined;
	lane.lastFrameAt = Date.now();
	setStatus(lane, "starting");
	statusActivity(`lane:${lane.name}`, `lane process ${resume ? "resumed" : "started"} (${lane.model})`);
	void readFrames(lane, proc);
	void proc.exited.then(code => {
		if (lane.proc !== proc) return;
		lane.proc = undefined;
		abandonCompact(lane.ctx, "the lane process exited");
		clearTimeout(lane.watchdog);
		clearTimeout(lane.resumeTimer);
		lane.resumeTimer = undefined;
		clearTimeout(lane.transientTimer);
		lane.transientTimer = undefined;
		endSubagents(`lane:${lane.name}`);
		statusActivity(`lane:${lane.name}`, `lane process exited (code ${code})`);
		if (lane.quiet) return log(`lane ${lane.name} stopped for a gateway restart`);
		setStatus(lane, "exited");
		log(`lane ${lane.name} exited (${code})`);
		if (lane.revive && lane.sessionFile) {
			const { text } = lane.revive;
			if (text) resumeLane(lane, text);
			else {
				spawn(lane, true);
				setStatus(lane, "idle");
			}
			return;
		}
		if (code !== 0 && code !== 143) report(lane, `[lane exited] 프로세스가 종료됐습니다 (code ${code}). 마지막 상태: ${lane.lastText.slice(0, 300) || "없음"}`);
	});
	write(lane, { type: "set_subagent_subscription", level: "progress" });
	setTimeout(() => write(lane, { type: "get_state" }), 3000);
}

function resumeLane(lane: Lane, text: string): void {
	clearTimeout(lane.resumeTimer);
	lane.resumeTimer = undefined;
	spawn(lane, true);
	prompt(lane, withHeld(lane, text));
	log(`lane ${lane.name} resumed ${lane.sessionFile}`);
}

// Aborts a lane that cannot go on (a turn with no frames for STALL_MS, or a failed compaction) by killing its process,
// then resumes the same session: a turn that was running is told to continue, an idle lane just comes back idle.
function recover(lane: Lane, why: string, wasWorking: boolean): void {
	if (!lane.proc || !lane.sessionFile || lane.revive) return;
	const t = Date.now();
	lane.recoveries = (lane.recoveries ?? []).filter(at => t - at < RECOVERY_WINDOW_MS);
	if (lane.recoveries.length >= RECOVERY_MAX) {
		lane.lastFrameAt = t;
		if (lane.recoveryCapped) return;
		lane.recoveryCapped = true;
		log(`lane ${lane.name} needs recovery (${why}) but already recovered ${RECOVERY_MAX} times in the last hour`);
		onReport(lane, `[lane stuck] ${why}. 한 시간 안에 ${RECOVERY_MAX}번 자동 복구했는데 또 멈춰서 더는 건드리지 않아요. 직접 확인해 주세요.`);
		return;
	}
	lane.recoveryCapped = false;
	lane.recoveries.push(t);
	clearTimeout(lane.timer);
	rmSync(pendingFile(lane), { force: true });
	if (lane.lastText.startsWith("[lane error]")) lane.lastText = "";
	log(`lane ${lane.name} recovering: ${why}`);
	onReport(lane, `[lane recovery] ${why}. 진행 중이던 요청을 중단하고 같은 세션으로 다시 이어서 시작해요 (${lane.recoveries.length}/${RECOVERY_MAX}).`);
	lane.revive = { text: wasWorking ? msg().laneStopped : undefined };
	lane.proc.kill(9);
}

const activeCount = () => [...lanes.values()].filter(l => l.status === "working" || l.status === "starting").length;
// Concurrent task workers a lane may run, from this machine's cores and memory (an omp worker is a process of a few
// hundred MB, mostly waiting on the model), capped by omp's task.maxConcurrency default of 8.
const WORKER_SLOTS = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2), Math.floor(totalmem() / 2 ** 32)));

function footer(lane: Lane): string {
	return withReplyLine(msg().footer({ lane: lane.name, mode: modeFile(), workerModel: laneWorkerModel(lane), slots: WORKER_SLOTS, worktree: worktreeNote(lane.worktree) }));
}

function worktreeNote(w: Worktree | undefined): string {
	return w ? msg().worktree(w) : msg().noGit;
}

const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

// For a cwd inside a git repo with commits: the lane's worktree (created, or reused when the lane is relaunched) on
// branch lane/<name> from the current HEAD, and the matching cwd inside it. Anything else runs in place.
function laneWorktree(name: string, cwd: string): { cwd: string; worktree?: Worktree } {
	const repo = git(cwd, "rev-parse", "--show-toplevel");
	const base = git(cwd, "symbolic-ref", "--short", "HEAD");
	if (!repo.ok || !base.ok || !git(cwd, "rev-parse", "--verify", "--quiet", "HEAD").ok) return { cwd };
	const w: Worktree = { path: join(dir(name), "worktree"), repo: repo.out, branch: `lane/${name}`, base: base.out };
	if (!existsSync(w.path)) {
		const exists = git(w.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`).ok;
		const add = git(w.repo, "worktree", "add", ...(exists ? [w.path, w.branch] : ["-b", w.branch, w.path, "HEAD"]));
		if (!add.ok) throw new Error(`could not create the lane worktree: ${add.err}`);
	}
	return { cwd: join(w.path, relative(w.repo, realpathSync(cwd))), worktree: w };
}

// Removes a closed lane's worktree and branch once its work is in the base branch and nothing is left uncommitted;
// otherwise keeps both and says why.
function dropWorktree(lane: Lane): string {
	const w = lane.worktree;
	if (!w || !existsSync(w.path)) return "";
	if (git(w.path, "status", "--porcelain").out) return `worktree kept: uncommitted changes in ${w.path}`;
	if (!git(w.repo, "merge-base", "--is-ancestor", w.branch, w.base).ok) return `worktree kept: ${w.branch} is not merged into ${w.base}`;
	const rm = git(w.repo, "worktree", "remove", w.path);
	if (!rm.ok) return `worktree kept: ${rm.err}`;
	git(w.repo, "branch", "-d", w.branch);
	lane.cwd = join(w.repo, relative(w.path, lane.cwd));
	lane.worktree = undefined;
	persist(lane);
	return `worktree removed (${w.branch} merged into ${w.base})`;
}

export function checkBrief(brief: string): string | undefined {
	if (!brief.trim()) return "brief is empty";
	if (brief.length > BRIEF_MAX) return `brief is ${brief.length} chars (max ${BRIEF_MAX}): pass paths, not pasted contents`;
	if (!DONE_RE.test(brief)) return "brief needs an observable done-condition line (\"Done when: ...\")";
	return undefined;
}

// Fable, or any model at xhigh/max effort, is spent only when the owner asked for it.
export const isExpensive = (selector: string) => /fable/i.test(selector) || /^(max|xhigh)$/i.test(splitThinking(selector).thinking ?? "");

// Budget gate (owner rule 2026-10-18): a job is assumed to use `est` % of the 5h window (default 15) and 10% must stay.
// The 7d window never gates; its remaining % is only shown in the message.
const DEFAULT_EST = 15;
// `est` (launch arg) wins over an "Estimate: N%" line in the brief; absent or invalid -> DEFAULT_EST.
export function estimateOf(est: unknown, brief = ""): number {
	const n = Number(est ?? /^\s*Estimate:\s*(\d+(?:\.\d+)?)\s*%?/im.exec(brief)?.[1]);
	return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_EST;
}
export function budgetVerdict(five: number | undefined, week: number | undefined, est: number): string | undefined {
	if (typeof five !== "number" || five - est >= 10) return undefined;
	return `5h window ${five}% left; this job is assumed to use ~${est}%, leaving under 10%${typeof week === "number" ? `; 7d window ${week}% left (info only)` : ""}`;
}

export function launch(name: string, cwd: string, brief: string, model?: string, worker?: string, fableOk?: boolean): Lane {
	if (!NAME_RE.test(name)) throw new Error("lane name must match [a-z0-9][a-z0-9-]{0,31}");
	if (!cwd.startsWith("/") || !existsSync(cwd)) throw new Error(`cwd must be an existing absolute path: ${cwd}`);
	const prior = lanes.get(name);
	if (prior?.proc) throw new Error(`lane ${name} is already running; use send`);
	const problem = checkBrief(brief);
	if (problem) throw new Error(problem);
	if (activeCount() >= MAX_ACTIVE) throw new Error(`${activeCount()} lanes are already working (max ${MAX_ACTIVE}); queue this one or send it to an idle lane`);
	const selector = model ?? selectorOf(lanesModel());
	mkdirSync(dir(name), { recursive: true });
	const place = laneWorktree(name, cwd);
	const lane: Lane = { name, cwd: place.cwd, worktree: place.worktree, model: selector, workerModel: worker || undefined, fableOk: fableOk || undefined, status: "starting", startedAt: now(), lastText: "", reports: 0, seq: 0, ctx: newCtx() };
	lanes.set(name, lane);
	persist(lane);
	writeFileSync(join(dir(name), "brief.md"), `${brief}\n`);
	spawn(lane, false);
	prompt(lane, brief + footer(lane));
	log(`lane ${name} launched in ${lane.cwd} (${selector}, workers ${laneWorkerModel(lane)})`);
	return lane;
}

export function sendToLane(name: string, text: string): void {
	const lane = lanes.get(name);
	if (!lane) throw new Error(`lane ${name} does not exist`);
	if (lane.proc) return prompt(lane, text);
	if (!lane.sessionFile || !existsSync(lane.sessionFile)) throw new Error(`lane ${name} is not running and has no session to resume`);
	resumeLane(lane, text);
}

function known(name: string): Lane {
	const lane = lanes.get(name);
	if (!lane) throw new Error(`no lane ${name}`);
	return lane;
}

// Stops the lane's process; a closed lane whose branch is merged and clean also loses its worktree and branch.
export function stopLane(name: string): void {
	const lane = known(name);
	const proc = lane.proc;
	proc?.kill();
	void (proc?.exited ?? Promise.resolve()).then(() => {
		const note = dropWorktree(lane);
		if (note) log(`lane ${name}: ${note}`);
	});
}

export function abortLane(name: string): void {
	const lane = known(name);
	if (!lane.proc) throw new Error(`lane ${name} is not running`);
	write(lane, { type: "abort" });
}

// Resumes a stopped lane (or, with text, steers a running one) from its saved session.
export function resumeByName(name: string, text?: string): void {
	const lane = known(name);
	if (lane.proc) {
		if (!text) throw new Error(`lane ${name} is already running`);
		return prompt(lane, text);
	}
	if (!lane.sessionFile || !existsSync(lane.sessionFile)) throw new Error(`lane ${name} has no session to resume`);
	resumeLane(lane, text || msg().laneOwnerResumed);
}

// Restarts the omp process of a lane, resuming its session (a turn that was running is cut off, so it is told to continue,
// with `note` when the caller knows why).
export async function restartLane(name: string, note = msg().laneOwnerRestarted): Promise<void> {
	const lane = known(name);
	if (!lane.proc) return resumeByName(name);
	if (!lane.sessionFile || !existsSync(lane.sessionFile)) throw new Error(`lane ${name} has no session yet; try again in a few seconds`);
	const wasWorking = lane.status === "working" || lane.status === "starting";
	const old = lane.proc;
	lane.quiet = true;
	old.kill();
	await old.exited;
	if (wasWorking) resumeLane(lane, note);
	else {
		spawn(lane, true);
		setStatus(lane, "idle");
	}
}

// Persists a new model selector on the lane record and, when it is running, restarts it on that model.
export async function setLaneModel(name: string, selector: string): Promise<"restarted" | "next-start"> {
	const lane = known(name);
	lane.model = selector;
	persist(lane);
	if (!lane.proc) return "next-start";
	await restartLane(name);
	return "restarted";
}

// Compacts a running lane's context: now when idle, after the running turn otherwise. Rewrites the prompt cache once.
export function compactLane(name: string): Compaction {
	const lane = known(name);
	if (!lane.proc) throw new Error(`lane ${name} is not running (resume it first)`);
	return requestCompact(lane.ctx, portOf(lane));
}

// Asks a running lane's omp for its current context numbers (answered by a get_session_stats response).
export function refreshLaneStats(name: string): void {
	const lane = known(name);
	if (lane.proc) write(lane, { type: "get_session_stats" });
}

// Moves an idle lane to a fresh session with a handover (the same pattern as the orchestrator's rotation): the lane
// keeps its model, folder, brief and goal, and reads its brief and last report to continue. The reload turn is silent
// (no report); an owner message that arrives meanwhile makes the next turn a normal one.
export async function rotateLane(name: string, why: string): Promise<void> {
	const lane = known(name);
	if (!lane.proc || lane.status !== "idle") throw new Error(`lane ${name} is not idle`);
	const previous = lane.sessionFile;
	const old = lane.proc;
	lane.quiet = true;
	old.kill();
	await old.exited;
	lane.ctx = newCtx();
	spawn(lane, false);
	const tail = previous && existsSync(previous) ? recentExchanges(previous) : undefined;
	const brief = join(dir(name), "brief.md");
	const lastReport = join(dir(name), "report.md");
	prompt(lane, withReplyLine(`${msg().laneRotated(why, lane.cwd, brief, lastReport)}${previous ? `\n\n${msg().laneHandover(previous, tail)}` : ""}`));
	lane.silent = { lastText: lane.lastText };
}

// Brings back every lane that was alive when the gateway stopped: working ones resume their turn, idle ones (waiting on
// the owner) are respawned idle so they keep answering in their channel. Lanes already stopped stay stopped.
// Returns the lanes that were resumed mid-work.
export function restoreLanes(): string[] {
	const resumed: string[] = [];
	if (!existsSync(paths.lanes)) return resumed;
	for (const name of readdirSync(paths.lanes)) {
		const file = join(dir(name), "lane.json");
		if (!existsSync(file) || lanes.has(name)) continue;
		const rec = JSON.parse(readFileSync(file, "utf8")) as Record_;
		const lane: Lane = { ...rec, lastText: "", seq: 0, ctx: newCtx() };
		lanes.set(name, lane);
		if (existsSync(pendingFile(lane))) {
			lane.lastText = readFileSync(pendingFile(lane), "utf8");
			report(lane, lane.lastText);
		}
		const session = Boolean(rec.sessionFile && existsSync(rec.sessionFile));
		if (session && (rec.status === "working" || rec.status === "starting" || rec.status === "rate-limited")) {
			resumeLane(lane, msg().laneGatewayRestarted);
			resumed.push(name);
		} else if (session && rec.status === "idle") {
			spawn(lane, true);
			setStatus(lane, "idle");
			log(`lane ${name} respawned idle ${rec.sessionFile}`);
		} else if (rec.status !== "exited") setStatus(lane, "exited");
	}
	return resumed;
}

// A lane is busy while its turn runs or any of its task workers still runs (a turn often ends while workers go on).
export const laneBusy = (lane: Lane): boolean => lane.status === "working" || lane.status === "starting" || runningSubagents(`lane:${lane.name}`) > 0;

export function shutdownLanes(): void {
	for (const lane of lanes.values()) {
		if (!lane.proc) continue;
		// An idle lane whose workers are cut off here is saved as working, so restoreLanes resumes it with the note that
		// its workers stopped instead of respawning it idle.
		if (lane.status === "idle" && laneBusy(lane)) {
			lane.status = "working";
			persist(lane);
		}
		lane.quiet = true;
		lane.proc.kill();
	}
}

setInterval(() => {
	for (const lane of lanes.values()) {
		if (lane.status !== "working" || !lane.lastText || lane.lastText === lane.progressText) continue;
		if (Date.now() - (lane.progressAt ?? Date.now()) < PROGRESS_EVERY_MS) continue;
		lane.progressAt = Date.now();
		lane.progressText = lane.lastText;
		onProgress(lane, lane.lastText);
	}
}, 60_000);

setInterval(() => {
	for (const lane of lanes.values()) {
		// Running task workers emit their own progress frames, but a long silent worker step is not a hung lane: skip those.
		if (lane.status === "working" && lane.proc && !runningSubagents(`lane:${lane.name}`) && Date.now() - (lane.lastFrameAt ?? Date.now()) >= STALL_MS) recover(lane, `${Math.round(STALL_MS / 60_000)}분 넘게 아무 응답이 없어요`, true);
	}
}, Math.min(60_000, Math.max(250, STALL_MS / 2)));

export const laneModels = () => [...lanes.values()].map(l => ({ name: l.name, ...parseSelector(l.model), status: l.status, running: Boolean(l.proc), worker_model: laneWorkerModel(l), worker_model_override: l.workerModel }));

export function laneSummary(): Array<Record<string, unknown>> {
	return [...lanes.values()].map(l => ({
		name: l.name,
		cwd: l.cwd,
		model: l.model,
		worker_model: laneWorkerModel(l),
		status: l.status,
		startedAt: l.startedAt,
		reports: l.reports,
		sessionFile: l.sessionFile,
		resumable: !l.proc && Boolean(l.sessionFile),
		lastText: l.lastText.slice(0, 600),
		context: ctxView(l.ctx),
	}));
}
