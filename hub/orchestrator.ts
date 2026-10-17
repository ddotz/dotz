// The gateway-hosted dotz orchestrator: one headless omp RPC session (cwd = data dir) that receives every
// owner message and lane report. Also does the omonyang session-doctor duties for it: resume after a rate limit at
// retry-after, restart after a crash (max 3 per 10 min), and rotate to a fresh session with a handover past 50MB.
import type { Subprocess } from "bun";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitFrameActivity, statusActivity } from "./activity.ts";
import { cfg, DATA_DIR, IDENTITY_FILE, log, NAME, now, OMP, orchestratorModel, paths, selectorOf } from "./config.ts";
import { abandonCompact, type CompactPort, type Compaction, flushCompact, newCtx, noteCompactResponse, noteMessageUsage, noteResponse, recentExchanges, requestCompact } from "./context.ts";
import { classifyProviderError, OWNER_RETRY_MS, type ProviderErrorKind, rateLimitDelay, TRANSIENT_RETRIES, transientBackoff } from "./providers.ts";
import { setupsSummary } from "./workchannels.ts";

const STATE = join(DATA_DIR, "orchestrator.json");
const ROTATE_BYTES = 50e6;
const ROTATE_TOKENS = cfg.orchestrator?.rotate_tokens ?? 150_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
type Saved = { sessionFile?: string; model?: string };

export const orch = {
	status: "stopped" as "stopped" | "starting" | "idle" | "working" | "rate-limited",
	// Why a "rate-limited" pause is on: a usage limit, or a billing/auth problem only the owner can fix.
	pauseKind: "rate" as "rate" | "owner",
	sessionFile: "",
	startedAt: "",
	lastText: "",
	rateLimitedUntil: "",
	restarts: [] as number[],
	ctx: newCtx(),
};
let proc: Subprocess<"pipe", "pipe", "pipe"> | undefined;
export const orchestratorPid = (): number | undefined => proc?.pid;
let seq = 0;
let stopping = false;
let rotating = false;
let restarting = false;
let pendingRestart = false;
let turnsSinceStart = 0;
let lastTurnEnd = Date.now();
let keepalives = 0;
let inKeepalive = false;
const held: string[] = [];
let onAlert: (text: string) => void = () => {};
export function setAlertHandler(fn: (text: string) => void): void {
	onAlert = fn;
}
// Messages that arrive while a turn runs are queued into the same agent run, so one run can answer several prompts.
// Each user prompt and each final answer is reported as it happens, letting the gateway route every answer to the
// channel that asked it instead of posting only the run's last text.
let onPrompt: (text: string) => void = () => {};
let onAnswer: (text: string) => void = () => {};
export function setAnswerHandlers(prompt: (text: string) => void, answer: (text: string) => void): void {
	onPrompt = prompt;
	onAnswer = answer;
}
const EXTENSION = join(import.meta.dir, "..", "extension", "index.ts");

const saved = (): Saved => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
let currentModel = "";
const save = (s: Saved) => writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`);
function write(frame: Record<string, unknown>): void {
	if (!proc) return;
	proc.stdin.write(`${JSON.stringify({ id: `o${++seq}`, ...frame })}\n`);
	proc.stdin.flush();
}
const textOf = (m: any) => (Array.isArray(m?.content) ? m.content : []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim();
// Compaction needs an idle process: omp aborts a running turn to compact, so a busy orchestrator queues it until agent_end.
const port: CompactPort = { idle: () => orch.status === "idle", send: write };

function recall(): string {
	const mode = readFileSync(existsSync(join(DATA_DIR, "MODE.md")) ? join(DATA_DIR, "MODE.md") : join(import.meta.dir, "..", "MODE.md"), "utf8");
	const state = existsSync(join(DATA_DIR, "state.json")) ? readFileSync(join(DATA_DIR, "state.json"), "utf8").slice(0, 4000) : "{}";
	const id = cfg.identity;
	const identity = existsSync(IDENTITY_FILE) ? readFileSync(IDENTITY_FILE, "utf8").slice(0, 3000) : `Name: ${NAME}\nCharacter: ${id?.character ?? ""}\nTone: ${id?.tone ?? ""}\nSpeak in this character and tone in every reply.`;
	const file = (p: string, max: number) => (existsSync(p) ? readFileSync(p, "utf8").slice(0, max) : "");
	return `[dotz gateway] You are ${NAME}, the dotz orchestrator hosted headless by the gateway.\n\nIdentity (who you are and how you talk):\n${identity}\n\nContract:\n\n${mode}\n\nOwner rules (${paths.rules}; they override the contract):\n${file(paths.rules, 6000)}\n\nLessons (${paths.lessons}):\n${file(paths.lessons, 3000)}\n\nWork channel setups (dotz_channel list for login health):\n${setupsSummary()}\n\nCurrent state.json:\n${state}`;
}

function handover(previous: string): string {
	const tail = recentExchanges(previous);
	if (tail === undefined) return "";
	return `\n\n[handover] The previous session (${previous}) was rotated to keep the context small. Its most recent exchanges, oldest first; continue any open thread from here:\n${tail}`;
}

async function readFrames(p: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of p.stdout) {
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
			emitFrameActivity("orchestrator", f);
			noteResponse(orch.ctx, f);
			noteCompactResponse(orch.ctx, f, port);
			if (f.type === "agent_start") {
				orch.status = "working";
				clearTimeout(watchdog);
				clearTimeout(transientTimer);
				transientTimer = undefined;
			}
			else if (f.type === "agent_end") {
				orch.status = orch.status === "rate-limited" ? "rate-limited" : "idle";
				lastTurnEnd = Date.now();
				if (inKeepalive) inKeepalive = false;
				else if (orch.status === "idle") keepalives = 0;
				if (orch.status === "idle" && pauseAlerted) {
					pauseAlerted = false;
					for (const text of held.splice(0)) write({ type: "prompt", message: text, streamingBehavior: "followUp" });
				} else if (orch.status === "idle") {
					if (++turnsSinceStart > 1 && orch.ctx.tokens > ROTATE_TOKENS) rotate();
					else if (pendingRestart) {
						pendingRestart = false;
						restart();
					} else {
						write({ type: "get_session_stats" });
						flushCompact(orch.ctx, port);
					}
				}
			}
			else if (f.type === "message_end" && f.message?.role === "user") {
				const t = textOf(f.message) || (typeof f.message.content === "string" ? f.message.content.trim() : "");
				if (!RESUME_NOTES.some(n => t.startsWith(n))) onPrompt(t);
			}
			else if (f.type === "message_end" && f.message?.role === "assistant") {
				const t = textOf(f.message);
				if (t) orch.lastText = t;
				if (t && (f.message.stopReason === "stop" || f.message.stopReason === "length")) onAnswer(t);
				noteMessageUsage(orch.ctx, f.message);
				const err = String(f.message.errorMessage ?? "");
				if (f.message.stopReason !== "error") transientTries = 0;
				else {
					const kind = classifyProviderError(err);
					if (kind === "rate" || kind === "owner") void scheduleResume(err, kind);
					else if (kind === "transient") retryTransient(err);
				}
			} else if (f.type === "response" && f.command === "get_state" && f.data?.sessionFile) {
				orch.sessionFile = f.data.sessionFile;
				save({ sessionFile: orch.sessionFile, model: currentModel });
				if (orch.status === "starting") {
					orch.status = "idle";
					flushCompact(orch.ctx, port);
				}
			}
		}
	}
}

// omp can stop reading prompts after a failed turn; if no turn starts soon after a delivery, restart it (the session is resumed).
const WATCHDOG_MS = 120_000;
let watchdog: ReturnType<typeof setTimeout> | undefined;
function armWatchdog(): void {
	clearTimeout(watchdog);
	if (orch.status === "working" || orch.status === "rate-limited") return;
	watchdog = setTimeout(() => {
		log("orchestrator did not start a turn after a delivery; restarting it");
		const hung = proc;
		hung?.kill();
		setTimeout(() => {
			if (proc === hung) hung?.kill(9);
		}, 10_000);
	}, WATCHDOG_MS);
}

// While paused by a rate limit (5h or a spent week), prompts are held instead of each starting a turn that fails at once;
// right after the spent window resets (from the provider's usage report; retry-after otherwise) they all go in, oldest
// first, after the resume note. A retry that hits the limit again re-arms quietly. A billing/auth error ("owner") pauses
// the same way, but nothing says when the owner fixes it, so it is probed every OWNER_RETRY_MS; the owner is told once.
const RESUME_NOTES = ["[dotz gateway] The rate limit has passed", "[dotz gateway] The provider problem", "[dotz gateway] The provider had a temporary error"];
let resumeTimer: Timer | undefined;
let pausing = false;
let pauseAlerted = false;
async function scheduleResume(err: string, kind: ProviderErrorKind): Promise<void> {
	if (resumeTimer || pausing) return;
	pausing = true;
	orch.status = "rate-limited";
	orch.rateLimitedUntil = "";
	const owner = kind === "owner";
	const { ms: retry, reset } = owner ? { ms: OWNER_RETRY_MS, reset: false } : await rateLimitDelay(err, currentModel);
	pausing = false;
	if (orch.status !== "rate-limited") return;
	const until = new Date(Date.now() + retry);
	orch.rateLimitedUntil = until.toISOString();
	const at = until.toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
	const changed = orch.pauseKind !== (owner ? "owner" : "rate");
	orch.pauseKind = owner ? "owner" : "rate";
	if (!pauseAlerted || changed) {
		if (owner) onAlert(`${NAME}: 모델 제공자 결제/인증 문제로 멈춤 (${err.replace(/\s+/g, " ").slice(0, 160)}). 크레딧 충전이나 로그인 확인이 필요합니다. 그동안 온 메시지는 모아뒀다가 해결되면 순서대로 처리하고, ${Math.round(retry / 60_000)}분마다 다시 시도합니다.`);
		else onAlert(`${NAME}: 사용량 한도(429)로 멈춤. ${reset ? `한도 리셋 직후인 ${at}` : `${at}쯤`}부터 다시 시도하고, 그동안 온 메시지는 모아뒀다가 순서대로 처리합니다.`);
	}
	pauseAlerted = true;
	resumeTimer = setTimeout(() => {
		resumeTimer = undefined;
		orch.status = "idle";
		// The held prompts go in one by one (each keeps its own answer channel) only after this turn succeeds, so a
		// retry that hits the limit again loses nothing.
		const why = owner ? "The provider problem (billing/auth) may have been fixed." : "The rate limit has passed.";
		write({ type: "prompt", message: `[dotz gateway] ${why} Continue the request you were handling when it stopped.${held.length ? ` ${held.length} message(s) that arrived while you were paused come next, oldest first.` : ""}`, streamingBehavior: "followUp" });
		armWatchdog();
	}, retry);
}

// Overloaded/5xx/network errors: after a failed turn, retry with backoff (bounded). Messages arriving meanwhile are not
// held: a new turn cancels the pending retry and itself serves as the retry. Past the limit the owner is told once.
let transientTries = 0;
let transientTimer: Timer | undefined;
function retryTransient(err: string): void {
	if (transientTimer) return;
	if (transientTries >= TRANSIENT_RETRIES) {
		transientTries = 0;
		onAlert(`${NAME}: 모델 제공자 오류(${err.replace(/\s+/g, " ").slice(0, 160)})가 ${TRANSIENT_RETRIES}번 재시도해도 계속돼서 멈췄습니다. 다음 메시지부터 다시 시도합니다.`);
		return;
	}
	const wait = transientBackoff(transientTries++);
	log(`orchestrator provider error (${err.slice(0, 120)}); retry ${transientTries}/${TRANSIENT_RETRIES} in ${Math.round(wait / 1000)}s`);
	transientTimer = setTimeout(() => {
		transientTimer = undefined;
		if (orch.status !== "idle") return;
		write({ type: "prompt", message: "[dotz gateway] The provider had a temporary error (overloaded or network) and your last turn failed. Continue the request you were handling when it stopped.", streamingBehavior: "followUp" });
		armWatchdog();
	}, wait);
}

// Past ROTATE_TOKENS of context the orchestrator moves to a fresh session with a handover at an idle point, so each
// message does not re-read a huge prefix (the global compaction threshold is sized for coding sessions, not a secretary).
function rotate(): void {
	if (!proc || rotating) return;
	log(`orchestrator context ${orch.ctx.tokens} tokens > ${ROTATE_TOKENS}; rotating to a fresh session`);
	rotating = true;
	proc.kill();
}

export function start(): void {
	if (proc) return;
	stopping = false;
	const { sessionFile: prior, model: priorModel } = saved();
	const model = selectorOf(orchestratorModel());
	// Resuming a session on another model or thinking level re-writes the whole context to cache, so a model change
	// starts a fresh session with a handover instead (omonyang rule "model change = fresh session").
	const rotate = prior && existsSync(prior) && (rotating || statSync(prior).size > ROTATE_BYTES || (priorModel !== undefined && priorModel !== model));
	rotating = false;
	orch.ctx = newCtx();
	turnsSinceStart = 0;
	const resume = prior && existsSync(prior) && !rotate;
	currentModel = model;
	const args = [OMP, "--mode", "rpc", "--model", model, "--extension", EXTENSION, ...(resume ? ["--resume", prior!] : [])];
	proc = Bun.spawn(args, { cwd: DATA_DIR, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, DOTZ_ORCHESTRATOR: "1" } });
	orch.status = "starting";
	orch.startedAt = now();
	void readFrames(proc);
	const self = proc;
	void proc.exited.then(code => {
		if (proc !== self) return;
		proc = undefined;
		orch.status = "stopped";
		abandonCompact(orch.ctx, "the orchestrator process exited");
		log(`orchestrator exited (${code})`);
		statusActivity("orchestrator", `orchestrator exited (code ${code})`);
		if (stopping) return;
		if (restarting) {
			restarting = false;
			return start();
		}
		if (rotating) return start();
		orch.restarts = orch.restarts.filter(t => Date.now() - t < RESTART_WINDOW_MS);
		if (orch.restarts.length >= MAX_RESTARTS) return onAlert(`${NAME}: 오케스트레이터가 10분 안에 ${MAX_RESTARTS}번 죽어서 재시작을 멈췄습니다. hub.log 확인이 필요합니다.`);
		orch.restarts.push(Date.now());
		setTimeout(start, 10_000);
	});
	if (!resume) write({ type: "prompt", message: recall() + (rotate ? handover(prior!) : "") });
	write({ type: "set_subagent_subscription", level: "progress" });
	for (const text of held.splice(0)) write({ type: "prompt", message: text, streamingBehavior: "followUp" });
	setTimeout(() => write({ type: "get_state" }), 4000);
	log(`orchestrator ${resume ? `resumed ${prior}` : rotate ? "rotated to a fresh session" : "started"} (${model})`);
	statusActivity("orchestrator", `orchestrator ${resume ? "resumed its session" : rotate ? "started a fresh session with a handover" : "started"} (${model})`);
}

// Keepalive (as on the macmini 오모냥): the 1h prompt cache would expire after an idle hour and the next message would
// re-write the whole prefix at 2x. A ping at 50-58 min idle costs a 0.1x read, so pinging wins for any gap shorter than
// ~18 pings; after KEEPALIVE_MAX consecutive pings (a night or longer away) the cache is allowed to expire.
const KEEPALIVE_FROM_MS = Number(process.env.DOTZ_KEEPALIVE_FROM_MS ?? 50 * 60_000);
const KEEPALIVE_TO_MS = Number(process.env.DOTZ_KEEPALIVE_TO_MS ?? 58 * 60_000);
const KEEPALIVE_MAX = 12;
setInterval(() => {
	const idle = Date.now() - lastTurnEnd;
	if (!proc || rotating || orch.status !== "idle" || keepalives >= KEEPALIVE_MAX) return;
	if (idle < KEEPALIVE_FROM_MS || idle > KEEPALIVE_TO_MS) return;
	keepalives++;
	inKeepalive = true;
	log(`keepalive ${keepalives}/${KEEPALIVE_MAX} after ${Math.round(idle / 60_000)} min idle`);
	write({ type: "prompt", message: "[keepalive] Cache keepalive from the gateway. Reply only: ok. No tools, no sends, no state edits." });
	armWatchdog();
}, Math.min(60_000, Math.max(5_000, (KEEPALIVE_TO_MS - KEEPALIVE_FROM_MS) / 2)));

export function deliver(text: string): void {
	if (rotating || restarting || orch.status === "rate-limited") {
		held.push(text);
		return;
	}
	if (!proc) start();
	write({ type: "prompt", message: text, streamingBehavior: "followUp" });
	armWatchdog();
}

// Injects a note into the running turn (no effect when idle: the next prompt starts a turn anyway).
export function steer(text: string): void {
	if (orch.status === "working") write({ type: "steer", message: text });
}

export function stop(): void {
	stopping = true;
	proc?.kill();
}

// Restart the omp process; the session is resumed unless the configured model or thinking level changed since it was
// saved (start() then begins a fresh session with a handover, the model-change rule above). Prompts arriving
// meanwhile are held and delivered by the new process.
export function restart(): void {
	if (!proc) return start();
	restarting = true;
	clearTimeout(watchdog);
	const old = proc;
	old.kill();
	setTimeout(() => {
		if (proc === old) old.kill(9);
	}, 10_000);
}

// The model/thinking in config just changed: restart now when idle, after the running turn otherwise (a restart
// would cut it off), or simply on the next start when no process is running.
export function applyModelChange(): "restarted" | "next-start" {
	if (!proc) return "next-start";
	if (orch.status === "working") {
		pendingRestart = true;
		return "next-start";
	}
	restart();
	return "restarted";
}

export function abort(): void {
	if (!proc) throw new Error("the orchestrator is not running");
	write({ type: "abort" });
}

// Compacts the orchestrator's context: now when idle, after the running turn otherwise. Rewrites the prompt cache once.
export function compact(): Compaction {
	if (!proc) throw new Error("the orchestrator is not running");
	return requestCompact(orch.ctx, port);
}
