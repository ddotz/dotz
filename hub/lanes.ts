import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitFrameActivity, statusActivity } from "./activity.ts";
import { cfg, IDENTITY_FILE, lanesModel, log, NAME, now, OMP, parseSelector, paths, selectorOf, workerModel } from "./config.ts";
import { abandonCompact, type CompactPort, type Compaction, type Ctx, ctxView, flushCompact, newCtx, noteCompactResponse, noteMessageUsage, noteResponse, requestCompact } from "./context.ts";

const REPORT_DEBOUNCE_MS = Number(process.env.DOTZ_REPORT_DEBOUNCE_MS ?? 0);
const PROGRESS_EVERY_MS = Number(process.env.DOTZ_PROGRESS_MS ?? 15 * 60_000);
const WATCHDOG_MS = 120_000;
const MAX_ACTIVE = cfg.lanes?.max_active ?? 4;
const BRIEF_MAX = 8000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DONE_RE = /(done[- ]?when|done\s*=|acceptance|완료\s*조건)/i;
const RATE_RE = /429|rate_limit|usage limit/i;

export type LaneStatus = "starting" | "working" | "idle" | "rate-limited" | "exited";
type Record_ = { name: string; cwd: string; model: string; workerModel?: string; status: LaneStatus; startedAt: string; sessionFile?: string; reports: number };
export type Lane = Record_ & {
	ctx: Ctx;
	lastText: string;
	proc?: Subprocess<"pipe", "pipe", "pipe">;
	seq: number;
	timer?: ReturnType<typeof setTimeout>;
	watchdog?: ReturnType<typeof setTimeout>;
	resumeTimer?: ReturnType<typeof setTimeout>;
	quiet?: boolean;
	revive?: boolean;
	workingSince?: number;
	progressAt?: number;
	progressText?: string;
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
	const { name, cwd, model, workerModel, status, startedAt, sessionFile, reports } = lane;
	mkdirSync(dir(name), { recursive: true });
	writeFileSync(join(dir(name), "lane.json"), `${JSON.stringify({ name, cwd, model, workerModel, status, startedAt, sessionFile, reports }, null, 2)}\n`);
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

function prompt(lane: Lane, text: string): void {
	write(lane, { type: lane.status === "working" ? "steer" : "prompt", message: text });
	if (lane.status === "working") return;
	clearTimeout(lane.watchdog);
	lane.watchdog = setTimeout(() => {
		log(`lane ${lane.name} did not start a turn after a prompt; restarting it`);
		lane.revive = true;
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
	if (lane.lastText) writeFileSync(pendingFile(lane), lane.lastText);
	clearTimeout(lane.timer);
	lane.timer = setTimeout(() => {
		if (lane.status !== "idle" || !lane.lastText) return;
		report(lane, lane.lastText);
	}, REPORT_DEBOUNCE_MS);
}

function pauseForRateLimit(lane: Lane, err: string): void {
	if (lane.resumeTimer) return;
	const wait = Math.min(Number(err.match(/retry-after-ms:\s*(\d+)/)?.[1] ?? 10 * 60_000), 6 * 3600_000) + 60_000;
	setStatus(lane, "rate-limited");
	const at = new Date(Date.now() + wait).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
	report(lane, `[lane paused] 사용량 한도(429). ${at}쯤 자동으로 이어갑니다.`);
	lane.resumeTimer = setTimeout(() => {
		lane.resumeTimer = undefined;
		setStatus(lane, "idle");
		prompt(lane, "[dotz gateway] The rate limit has passed. Continue the work you were doing when it stopped.");
	}, wait);
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
			emitFrameActivity(`lane:${lane.name}`, f);
			noteResponse(lane.ctx, f);
			noteCompactResponse(lane.ctx, f, portOf(lane));
			if (f.type === "agent_start") {
				clearTimeout(lane.watchdog);
				clearTimeout(lane.timer);
				rmSync(pendingFile(lane), { force: true });
				setStatus(lane, "working");
				lane.progressAt = Date.now();
			} else if (f.type === "message_end" && f.message?.role === "assistant") {
				noteMessageUsage(lane.ctx, f.message);
				const text = textOf(f.message);
				const err = String(f.message.errorMessage ?? "");
				if (text) lane.lastText = text;
				else if (f.message.stopReason === "error" && RATE_RE.test(err)) pauseForRateLimit(lane, err);
				else if (f.message.stopReason === "error") {
					lane.lastText = `[lane error] ${(err || "model request failed").slice(0, 300)}`;
					scheduleReport(lane);
				}
			} else if (f.type === "agent_end") {
				scheduleReport(lane);
				if (lane.status === "idle") {
					write(lane, { type: "get_session_stats" });
					flushCompact(lane.ctx, portOf(lane));
				}
			} else if (f.type === "response" && f.command === "get_state" && f.data?.sessionFile) {
				lane.sessionFile = f.data.sessionFile;
				persist(lane);
			}
		}
	}
}

// Per-run omp config overlay (--config) that points the `task` role at the lane's worker model, so the lane plans and
// reviews on its own model while task workers (implementation, tests, renders, grind) run on the cheaper one. Written at
// every spawn so a changed lanes.worker_model applies the next time the lane starts or resumes.
export const laneWorkerModel = (lane: Pick<Lane, "workerModel">) => lane.workerModel ?? workerModel();
function writeOverlay(lane: Lane): string {
	const file = join(dir(lane.name), "omp-overlay.yml");
	mkdirSync(dir(lane.name), { recursive: true });
	writeFileSync(file, `# Written by the dotz gateway each time lane ${lane.name} starts; passed to omp as --config.\nmodelRoles:\n  task: ${JSON.stringify(laneWorkerModel(lane))}\ntask:\n  agentModelOverrides:\n    task: "@task"\n    scout: "@task"\n`);
	return file;
}

function spawn(lane: Lane, resume: boolean): void {
	const proc = Bun.spawn([OMP, "--mode", "rpc", "--model", lane.model, `--config=${writeOverlay(lane)}`, ...(resume && lane.sessionFile ? ["--resume", lane.sessionFile] : [])], {
		cwd: lane.cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, DOTZ_LANE: lane.name },
	});
	lane.proc = proc;
	lane.quiet = false;
	lane.revive = false;
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
		statusActivity(`lane:${lane.name}`, `lane process exited (code ${code})`);
		if (lane.quiet) return log(`lane ${lane.name} stopped for a gateway restart`);
		setStatus(lane, "exited");
		log(`lane ${lane.name} exited (${code})`);
		if (lane.revive && lane.sessionFile) {
			resumeLane(lane, "[dotz gateway] Your process was restarted after it stopped responding. Continue the last request.");
			return;
		}
		if (code !== 0 && code !== 143) report(lane, `[lane exited] 프로세스가 종료됐습니다 (code ${code}). 마지막 상태: ${lane.lastText.slice(0, 300) || "없음"}`);
	});
	write(lane, { type: "set_subagent_subscription", level: "progress" });
	setTimeout(() => write(lane, { type: "get_state" }), 3000);
}

function resumeLane(lane: Lane, text: string): void {
	spawn(lane, true);
	prompt(lane, text);
	log(`lane ${lane.name} resumed ${lane.sessionFile}`);
}

const activeCount = () => [...lanes.values()].filter(l => l.status === "working" || l.status === "starting").length;

function footer(lane: Lane): string {
	const mode = join(import.meta.dir, "..", "MODE.md");
	return `\n\n---\n[dotz lane ${lane.name}] You are a lane of ${NAME}: a full omp orchestrator for this folder with one goal. The final message of each turn is your report: ${NAME} relays it and the owner reads it in the lane channel. Keep it to ~800 characters: outcome, changed paths, verification against the Done-when line (run the check yourself), blockers or questions for the owner. The owner may write to you directly. Do not message Discord or other people yourself, and never put secrets in a report. Before you start, read and follow ${mode} (sections Lanes and workers, Reporting, Browser and testing), ${IDENTITY_FILE} (voice) and the owner's standing rules in ${paths.rules} (they override your defaults). Plan and review yourself; run implementation and grind work as task workers (worker model ${laneWorkerModel(lane)} via modelRoles.task), and review a worker's diff yourself before applying or merging it.`;
}

export function checkBrief(brief: string): string | undefined {
	if (!brief.trim()) return "brief is empty";
	if (brief.length > BRIEF_MAX) return `brief is ${brief.length} chars (max ${BRIEF_MAX}): pass paths, not pasted contents`;
	if (!DONE_RE.test(brief)) return "brief needs an observable done-condition line (\"Done when: ...\")";
	return undefined;
}

export function launch(name: string, cwd: string, brief: string, model?: string, worker?: string): Lane {
	if (!NAME_RE.test(name)) throw new Error("lane name must match [a-z0-9][a-z0-9-]{0,31}");
	if (!cwd.startsWith("/") || !existsSync(cwd)) throw new Error(`cwd must be an existing absolute path: ${cwd}`);
	const prior = lanes.get(name);
	if (prior?.proc) throw new Error(`lane ${name} is already running; use send`);
	const problem = checkBrief(brief);
	if (problem) throw new Error(problem);
	if (activeCount() >= MAX_ACTIVE) throw new Error(`${activeCount()} lanes are already working (max ${MAX_ACTIVE}); queue this one or send it to an idle lane`);
	const selector = model ?? selectorOf(lanesModel());
	const lane: Lane = { name, cwd, model: selector, workerModel: worker || undefined, status: "starting", startedAt: now(), lastText: "", reports: 0, seq: 0, ctx: newCtx() };
	lanes.set(name, lane);
	mkdirSync(dir(name), { recursive: true });
	writeFileSync(join(dir(name), "brief.md"), `${brief}\n`);
	spawn(lane, false);
	prompt(lane, brief + footer(lane));
	log(`lane ${name} launched in ${cwd} (${selector}, workers ${laneWorkerModel(lane)})`);
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

export function stopLane(name: string): void {
	known(name).proc?.kill();
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
	resumeLane(lane, text || "[dotz gateway] The owner resumed you. Continue the work you were doing.");
}

// Restarts the omp process of a lane, resuming its session (a turn that was running is cut off, so it is told to continue).
export async function restartLane(name: string): Promise<void> {
	const lane = known(name);
	if (!lane.proc) return resumeByName(name);
	if (!lane.sessionFile || !existsSync(lane.sessionFile)) throw new Error(`lane ${name} has no session yet; try again in a few seconds`);
	const wasWorking = lane.status === "working" || lane.status === "starting";
	const old = lane.proc;
	lane.quiet = true;
	old.kill();
	await old.exited;
	if (wasWorking) resumeLane(lane, "[dotz gateway] Your process was restarted by the owner (settings changed). Continue the work you were doing.");
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

// Returns the lanes that were resumed because the gateway stopped while they worked.
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
		const wasRunning = rec.status === "working" || rec.status === "starting" || rec.status === "rate-limited";
		if (wasRunning && rec.sessionFile && existsSync(rec.sessionFile)) {
			resumeLane(lane, "[dotz gateway] The gateway restarted while you were working. Continue the work you were doing; if an owner message was cut off mid-turn, handle it too.");
			resumed.push(name);
		} else if (rec.status !== "exited") setStatus(lane, "exited");
	}
	return resumed;
}

export function shutdownLanes(): void {
	for (const lane of lanes.values()) {
		if (!lane.proc) continue;
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
