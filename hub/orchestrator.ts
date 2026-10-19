// The gateway-hosted dotz orchestrator: one headless agent session (cwd = data dir) that receives every
// owner message and lane report. Also does the omonyang session-doctor duties for it: resume after a rate limit at
// retry-after, restart after a crash (max 3 per 10 min), and rotate to a fresh session with a handover past 50MB.
// The agent itself runs behind a runtime adapter (hub/runtime): this module is policy and talks to it only through
// an AgentProcess and its events.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { emitEventActivity, statusActivity } from "./activity.ts";
import { cfg, DATA_DIR, IDENTITY_FILE, log, NAME, now, orchestratorModel, paths, selectorOf, writeAtomic } from "./config.ts";
import { isNote, modeFile, msg, withReplyLine } from "./i18n.ts";
import { featurePrompt } from "./featuredirs.ts";
import { abandonCompact, type CompactPort, type Compaction, flushCompact, newCtx, noteEvent, requestCompact } from "./context.ts";
import { OWNER_RETRY_MS, type ProviderErrorKind, rateLimitDelay, TRANSIENT_RETRIES, transientBackoff } from "./providers.ts";
import { runtimeFor } from "./runtime/index.ts";
import type { AgentProcess, RuntimeAdapter } from "./runtime/types.ts";
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
let proc: AgentProcess | undefined;
// The runtime of the running process, chosen at each start().
let adapter: RuntimeAdapter | undefined;
export const orchestratorPid = (): number | undefined => proc?.pid;
let stopping = false;
let rotating = false;
let restarting = false;
let pendingRestart = false;
let turnsSinceStart = 0;
let lastTurnEnd = Date.now();
let keepalives = 0;
let inKeepalive = false;
const held: string[] = [];
// Set when a compaction finished: the next owner message sent to the process carries the retain nudge once (no extra turn).
let retainNext = false;
function sendOwner(text: string): void {
	const nudge = retainNext ? `\n\n${msg().retainNudge}` : "";
	retainNext = false;
	proc?.send(text + nudge, "followUp");
}
let onAlert: (text: string) => void = () => {};
export function setAlertHandler(fn: (text: string) => void): void {
	onAlert = fn;
}

// Called when a turn ended and the orchestrator is idle again; main.ts sends the web messages queued for it.
let onIdle: () => void = () => {};
export function setIdleHandler(fn: () => void): void {
	onIdle = fn;
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

const saved = (): Saved => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
let currentModel = "";
const save = (s: Saved) => writeAtomic(STATE, `${JSON.stringify(s, null, 2)}\n`);
// Compaction needs an idle process: a runtime may abort a running turn to compact, so a busy orchestrator queues it until turn_end.
const port: CompactPort = { idle: () => orch.status === "idle", compact: () => proc?.compact(), refreshUsage: () => proc?.refreshUsage() };

function recall(): string {
	const mode = readFileSync(modeFile(), "utf8");
	const state = existsSync(join(DATA_DIR, "state.json")) ? readFileSync(join(DATA_DIR, "state.json"), "utf8").slice(0, 4000) : "{}";
	const id = cfg.identity;
	const identity = existsSync(IDENTITY_FILE) ? readFileSync(IDENTITY_FILE, "utf8").slice(0, 3000) : msg().identityFallback(id?.character ?? "", id?.tone ?? "");
	// A cut file says so: RULES.md outgrew the old 6000-character cap and silently lost its last lines (blocked commands).
	const file = (p: string, max: number) => {
		const t = existsSync(p) ? readFileSync(p, "utf8") : "";
		return t.length > max ? `${t.slice(0, max)}\n[... cut at ${max} characters; read ${p} for the rest]` : t;
	};
	const features = featurePrompt(DATA_DIR, "orchestrator", log);
	return withReplyLine(msg().recall({ mode, identity, rules: file(paths.rules, 12000) + (features ? `\n\n${features}` : ""), lessons: file(paths.lessons, 3000), setups: setupsSummary(), state }));
}

function handover(runtime: RuntimeAdapter, previous: string): string {
	const tail = runtime.recentExchanges(previous);
	if (tail === undefined) return "";
	return msg().handover(previous, tail);
}

async function readEvents(p: AgentProcess): Promise<void> {
	for await (const ev of p.events) {
		emitEventActivity("orchestrator", ev);
		noteEvent(orch.ctx, ev, port);
		switch (ev.type) {
			case "turn_start":
				orch.status = "working";
				clearTimeout(watchdog);
				clearTimeout(transientTimer);
				transientTimer = undefined;
				break;
			case "turn_end":
				orch.status = orch.status === "rate-limited" ? "rate-limited" : "idle";
				lastTurnEnd = Date.now();
				if (inKeepalive) inKeepalive = false;
				else if (orch.status === "idle") keepalives = 0;
				if (orch.status === "idle" && pauseAlerted) {
					pauseAlerted = false;
					for (const text of held.splice(0)) sendOwner(text);
				} else if (orch.status === "idle") {
					if (++turnsSinceStart > 1 && orch.ctx.tokens > ROTATE_TOKENS) rotate();
					else if (pendingRestart) {
						pendingRestart = false;
						restart();
					} else {
						proc?.refreshUsage();
						flushCompact(orch.ctx, port);
					}
				}
				if (orch.status === "idle") setTimeout(() => orch.status === "idle" && onIdle(), 200);
				break;
			case "user":
				if (!isResumeNote(ev.text)) onPrompt(ev.text);
				break;
			case "assistant":
				if (ev.text) orch.lastText = ev.text;
				if (ev.text && (ev.stop === "stop" || ev.stop === "length")) onAnswer(ev.text);
				if (ev.stop !== "error") transientTries = 0;
				else if (ev.error.kind === "rate" || ev.error.kind === "owner") void scheduleResume(ev.error.text, ev.error.kind);
				else if (ev.error.kind === "transient") retryTransient(ev.error.text);
				break;
			case "session":
				orch.sessionFile = ev.ref;
				save({ sessionFile: orch.sessionFile, model: currentModel });
				if (orch.status === "starting") {
					orch.status = "idle";
					flushCompact(orch.ctx, port);
				}
				break;
			case "compaction":
				if (ev.state === "done") retainNext = true;
				break;
		}
	}
}

// The runtime can stop reading prompts after a failed turn; if no turn starts soon after a delivery, restart it (the session is resumed).
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
			if (proc === hung) hung?.kill(true);
		}, 10_000);
	}, WATCHDOG_MS);
}

// While paused by a rate limit (5h or a spent week), prompts are held instead of each starting a turn that fails at once;
// right after the spent window resets (from the provider's usage report; retry-after otherwise) they all go in, oldest
// first, after the resume note. A retry that hits the limit again re-arms quietly. A billing/auth error ("owner") pauses
// the same way, but nothing says when the owner fixes it, so it is probed every OWNER_RETRY_MS; the owner is told once.
const isResumeNote = (t: string) => isNote(t, "rateLead") || isNote(t, "providerLead") || isNote(t, "transientLead");
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
		const m = msg();
		proc?.send(owner ? m.orchProvider(held.length) : m.orchRate(held.length), "followUp");
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
		proc?.send(msg().orchTransient, "followUp");
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
	const runtime = runtimeFor("orchestrator");
	adapter = runtime;
	proc = runtime.start({ role: "orchestrator", cwd: DATA_DIR, model, resume: resume ? prior : undefined, env: { DOTZ_ORCHESTRATOR: "1" } });
	orch.status = "starting";
	orch.startedAt = now();
	void readEvents(proc);
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
	if (!resume) {
		retainNext = false; // a fresh session's start prompt (and handover) already carries it
		proc.send(recall() + (rotate ? handover(runtime, prior!) : ""), "prompt");
	}
	proc.watchSubagents();
	for (const text of held.splice(0)) sendOwner(text);
	setTimeout(() => proc?.refreshSession(), 4000);
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
	if (!proc || !adapter?.caps.promptCacheKeepalive || rotating || orch.status !== "idle" || keepalives >= KEEPALIVE_MAX) return;
	if (idle < KEEPALIVE_FROM_MS || idle > KEEPALIVE_TO_MS) return;
	keepalives++;
	inKeepalive = true;
	log(`keepalive ${keepalives}/${KEEPALIVE_MAX} after ${Math.round(idle / 60_000)} min idle`);
	proc.send(msg().keepalive, "prompt");
	armWatchdog();
}, Math.min(60_000, Math.max(5_000, (KEEPALIVE_TO_MS - KEEPALIVE_FROM_MS) / 2)));

export function deliver(text: string): void {
	if (rotating || restarting || orch.status === "rate-limited") {
		held.push(text);
		return;
	}
	if (!proc) start();
	sendOwner(text);
	armWatchdog();
}

// Injects a note into the running turn (no effect when idle: the next prompt starts a turn anyway).
export function steer(text: string): void {
	if (orch.status === "working") proc?.send(text, "steer");
}

export function stop(): void {
	stopping = true;
	proc?.kill();
}

// Restart the agent process; the session is resumed unless the configured model or thinking level changed since it was
// saved (start() then begins a fresh session with a handover, the model-change rule above). Prompts arriving
// meanwhile are held and delivered by the new process.
export function restart(): void {
	if (!proc) return start();
	restarting = true;
	clearTimeout(watchdog);
	const old = proc;
	old.kill();
	setTimeout(() => {
		if (proc === old) old.kill(true);
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
	proc.abort();
}

// Compacts the orchestrator's context: now when idle, after the running turn otherwise. Rewrites the prompt cache once.
export function compact(): Compaction {
	if (!proc) throw new Error("the orchestrator is not running");
	return requestCompact(orch.ctx, port);
}
