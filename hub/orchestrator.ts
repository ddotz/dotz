// The gateway-hosted dotz orchestrator: one headless agent session (cwd = data dir) that receives every
// owner message and lane report. Also does the omonyang session-doctor duties for it: resume after a rate limit at
// retry-after, restart after a crash (max 3 per 10 min), and rotate to a fresh session with a handover past 50MB.
// The agent itself runs behind a runtime adapter (hub/runtime): this module is policy and talks to it only through
// an AgentProcess and its events.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { emitEventActivity, runningSubagents, statusActivity } from "./activity.ts";
import { pendingAsksBlock } from "./asks.ts";
import { cfg, chainAfter, DATA_DIR, fallbackChain, IDENTITY_FILE, log, NAME, now, orchestratorModel, parseSelector, paths, selectorOf, TZ, writeAtomic } from "./config.ts";
import { isNote, modeFile, msg, withReplyLine } from "./i18n.ts";
import { featurePrompt } from "./featuredirs.ts";
import { abandonCompact, type CompactPort, type Compaction, flushCompact, newCtx, noteEvent, requestCompact } from "./context.ts";
import { OWNER_RETRY_MS, type ProviderErrorKind, rateLimitDelay, TRANSIENT_RETRIES, transientBackoff } from "./providers.ts";
import { runtimeFor } from "./runtime/index.ts";
import { atTime, Chain, ERROR_STREAK_STOP, ErrorStreak, failsOver, failureReason, hubChain, type Move, Reverter, revertWhy } from "./fallback.ts";
import type { AgentError, AgentProcess, RuntimeAdapter } from "./runtime/types.ts";
import { setupsSummary } from "./workchannels.ts";

const STATE = join(DATA_DIR, "orchestrator.json");
const ROTATE_BYTES = 50e6;
const ROTATE_TOKENS = cfg.orchestrator?.rotate_tokens ?? 150_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
type Saved = { sessionFile?: string; model?: string; runtime?: string };

export const orch = {
	status: "stopped" as "stopped" | "starting" | "idle" | "working" | "rate-limited",
	// Why a "rate-limited" pause is on: a usage limit, or a billing/auth problem only the owner can fix.
	pauseKind: "rate" as "rate" | "owner",
	sessionFile: "",
	// The model the running process answers on now: the configured one, or the fallback it switched to (reset at every start).
	activeModel: "",
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
const held: { text: string; header: boolean }[] = [];
// A process started with a fallback chain: after a failed request the runtime may move to the next model by itself and
// redo the turn, so the failure is acted on (pause, retry, alert) only when no such switch follows within a short grace.
const FALLBACK_GRACE_MS = 3000;
let chained = false;
let errorHold: Timer | undefined;
// The chain the hub drives itself (conditional entries, spend caps; hub/fallback.ts), with what is waiting for an idle moment.
let chain: Chain | undefined;
let capped: { move?: Move } | undefined;
let continueAfterSwitch = false;
// Going back to the configured model after the runtime moved the process to a fallback by itself (not when the hub drives a chain).
const reverter = new Reverter();
let startedModel = "";
// Set when a compaction finished: the next owner message sent to the process carries the retain nudge once (no extra turn).
let retainNext = false;
// Set when a session was resumed (gateway or crash restart): the next owner message carries the lane questions still
// waiting for the owner's answer once, as the session may not have heard them in full.
let asksNext = false;
// An owner prompt leads with one line of what runs now (lanes, workers), so the orchestrator need not poll for it; the
// provider is registered by main.ts (lanes.ts would be an import cycle) and the line is empty when nothing runs.
let turnHeader: () => string = () => "";
export function setTurnHeader(fn: () => string): void {
	turnHeader = fn;
}
function sendOwner(text: string, header = false): void {
	settleRevert(false);
	const nudge = retainNext ? `\n\n${msg().retainNudge}` : "";
	const asks = asksNext ? pendingAsksBlock() : "";
	retainNext = false;
	asksNext = false;
	const line = header ? turnHeader() : "";
	proc?.send((line ? `${line}\n` : "") + text + nudge + (asks ? `\n\n${asks}` : ""), "followUp");
}
// Switches the process back to its configured model once that is due: before a prompt starts a turn (a refusal, a provider
// error, or a usage limit that has reset), or at an idle moment for a usage limit that has reset. Never in the middle of a turn.
function settleRevert(idle: boolean): void {
	if (!proc?.setModel || chain || orch.status === "working" || orch.status === "rate-limited" || (idle && orch.status !== "idle")) return;
	const to = reverter.take(idle);
	if (!to) return;
	proc.setModel(to);
	orch.activeModel = to;
	const line = msg().modelReverted(parseSelector(to).model);
	log(`orchestrator ${line}`);
	onAlert(`${NAME}: ${line}`);
}
// One line for the worklog when the runtime moves the orchestrator (or one of its task workers) to the next model of a fallback chain.
let onNotice: (text: string) => void = () => {};
export function setNoticeHandler(fn: (text: string) => void): void {
	onNotice = fn;
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
let onText: (text: string) => void = () => {};
export function setAnswerHandlers(prompt: (text: string) => void, answer: (text: string) => void, text: (text: string) => void = () => {}): void {
	onText = text;
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
	return withReplyLine(msg().recall({ mode, identity, rules: file(paths.rules, 12000) + (features ? `\n\n${features}` : ""), lessons: file(paths.lessons, 3000), memory: `${file(paths.owner, 3000)}\n${file(paths.boundaries, 2000)}`, setups: setupsSummary(), state }));
}

function handover(runtime: RuntimeAdapter, previous: string): string {
	const tail = runtime.recentExchanges(previous);
	if (tail === undefined) return "";
	return msg().handover(previous, tail);
}

// A failed request: a usage limit or a billing/auth problem pauses the orchestrator, a temporary provider error is retried with backoff.
// With a hub-driven chain the next entry takes over first (a temporary error is retried a few times before that).
function handleError(e: AgentError): void {
	if (chain && failsOver(e.kind) && !(e.kind === "transient" && transientTries < TRANSIENT_RETRIES)) void failOver(e).then(moved => !moved && legacyError(e));
	else legacyError(e);
}
function legacyError(e: AgentError): void {
	if (e.kind === "rate" || e.kind === "owner") void scheduleResume(e.text, e.kind);
	else if (e.kind === "transient") retryTransient(e.text);
}
async function failOver(e: AgentError): Promise<boolean> {
	const active = chain;
	if (!active) return false;
	const reason = failureReason({ kind: e.kind, text: e.text });
	const until = reason === "quota" ? Date.now() + (await rateLimitDelay(e.text, active.selector(active.active))).ms : undefined;
	if (chain !== active) return false;
	const move = active.fail(reason, until);
	if (!move) return false;
	return switchTo(move, true);
}
// Restarts on the same session with another entry of the chain (start() picks it from the persisted limit and spend state);
// `again` tells the session to redo the request that just failed. One switch at a time: a revert racing a failover is dropped.
function switchTo(move: Move, again: boolean): boolean {
	if (!chain || restarting) return false;
	const line = msg().fallbackMove(chain.label(move.from), chain.label(move.to), move.why);
	log(`orchestrator ${line}`);
	onNotice(line);
	// A switch away from the configured model after a failure is the owner's to hear, like a runtime's own fallback.
	if (move.why === "quota" || move.why === "error") onAlert(`${NAME}: ${line}`);
	continueAfterSwitch = again;
	restart();
	return true;
}
// At an idle moment: act on a spend cap reached during the turn, or go back to an earlier entry whose limit has reset.
function settleChain(): boolean {
	if (!chain || orch.status !== "idle" || runningSubagents("orchestrator") > 0) return false;
	if (capped) {
		const reached = capped;
		capped = undefined;
		if (reached.move) switchTo(reached.move, false);
		else pauseExhausted(chain, chain.exhaustedUntil() ?? chain.down(chain.active)?.until ?? Date.now() + 3_600_000);
		return true;
	}
	const back = chain.revertTarget();
	if (!back) return false;
	switchTo(back, false);
	return true;
}
// Every entry is spent: hold messages until the earliest cap period ends, then start again.
function pauseExhausted(c: Chain, until: number): void {
	orch.status = "rate-limited";
	orch.pauseKind = "rate";
	orch.rateLimitedUntil = new Date(until).toISOString();
	const at = new Date(until).toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
	const line = msg().fallbackExhausted(c.label(c.active), at);
	log(`orchestrator ${line}`);
	onNotice(line);
	onAlert(`${NAME}: ${line}`);
	pauseAlerted = true;
	clearTimeout(resumeTimer);
	atTime(until, t => (resumeTimer = t), () => {
		resumeTimer = undefined;
		pauseAlerted = false;
		orch.status = "idle";
		restart();
	});
}

async function readEvents(p: AgentProcess): Promise<void> {
	for await (const ev of p.events) {
		emitEventActivity("orchestrator", ev);
		noteEvent(orch.ctx, ev, port);
		switch (ev.type) {
			case "turn_start":
				clearTimeout(errorHold);
				orch.status = "working";
				clearTimeout(watchdog);
				clearTimeout(transientTimer);
				transientTimer = undefined;
				break;
			case "turn_end":
				orch.status = orch.status === "rate-limited" ? "rate-limited" : "idle";
				settleRevert(true);
				if (orch.status === "idle" && settleChain()) break;
				lastTurnEnd = Date.now();
				if (inKeepalive) inKeepalive = false;
				else if (orch.status === "idle") keepalives = 0;
				if (orch.status === "idle" && pauseAlerted) {
					pauseAlerted = false;
					for (const h of held.splice(0)) sendOwner(h.text, h.header);
				} else if (orch.status === "idle") {
					if (rotateWhenIdle || (++turnsSinceStart > 1 && orch.ctx.tokens > ROTATE_TOKENS && !compacting())) limitContext();
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
				if (ev.text) {
					orch.lastText = ev.text;
					onText(ev.text);
				}
				if (ev.text && (ev.stop === "stop" || ev.stop === "length")) onAnswer(ev.text);
				if (ev.stop !== "error") {
					transientTries = 0;
					errorStreak.ok();
					streakAlerted = false;
				} else if (inKeepalive && keepaliveErrorDropped(ev.error.kind)) {
					log(`keepalive failed (${ev.error.text.replace(/\s+/g, " ").slice(0, 120)}); not retried, the next message is the next try`);
				} else if (ev.error.kind !== "rate" && ev.error.kind !== "owner" && errorStreak.fail() !== "go") {
					// A run of failed turns: no more automatic retries, failovers or keepalives until a turn succeeds (the owner's
					// next message is the next try); the owner hears it once.
					if (errorStreak.stopped && !streakAlerted) {
						streakAlerted = true;
						log(`orchestrator ${ERROR_STREAK_STOP} failed turns in a row; automatic retries stop until a turn succeeds`);
						onAlert(`${NAME}: 모델 오류가 ${ERROR_STREAK_STOP}턴 연속이라 자동 재시도·전환을 멈췄습니다(${ev.error.text.replace(/\s+/g, " ").slice(0, 160)}). 다음 메시지부터 다시 시도합니다.`);
					}
				} else if (chained) {
					const failed = ev.error;
					clearTimeout(errorHold);
					errorHold = setTimeout(() => handleError(failed), FALLBACK_GRACE_MS);
				} else handleError(ev.error);
				break;
			case "session":
				orch.sessionFile = ev.ref;
				save({ sessionFile: orch.sessionFile, model: currentModel, runtime: adapter?.id });
				if (orch.status === "starting") {
					orch.status = "idle";
					flushCompact(orch.ctx, port);
				}
				break;
			case "spend": {
				const reached = chain?.spend(ev.tokens, ev.usd);
				if (reached?.capped) capped = reached;
				break;
			}
			case "compaction":
				if (ev.state === "done") {
					compactRetried = false;
					// The compacted session keeps going: the next owner message reminds it to retain, and carries the lane
					// questions still waiting for the owner (the summary may have cut them); the dotz extension re-reads the
					// contract and state.json (open_tasks) into it.
					retainNext = true;
					asksNext = true;
				} else if (adapter?.caps.contextLimit === "compact" && orch.ctx.tokens > ROTATE_TOKENS && /retry compaction/i.test(ev.error) && !compactRetried) {
					// OmO refuses a summary when the session changed while it was made; the next idle point tries once more.
					compactRetried = true;
					log(`orchestrator compaction raced a session write (${ev.error.slice(0, 120)}); retrying at the next idle point`);
					orch.ctx.compaction = { state: "queued", at: now() };
					if (orch.status === "idle") flushCompact(orch.ctx, port);
				} else if (adapter?.caps.contextLimit === "compact" && orch.ctx.tokens > ROTATE_TOKENS) {
					log(`orchestrator compaction failed (${ev.error.slice(0, 160)}); moving to a fresh session with a handover`);
					if (orch.status === "idle") rotate();
					else rotateWhenIdle = true;
				}
				break;
			case "fallback": {
				log(`orchestrator model fallback${ev.worker ? " (task worker)" : ""}: ${ev.from} -> ${ev.to}${ev.reason ? ` (${ev.reason.replace(/\s+/g, " ").slice(0, 200)})` : ""}`);
				const line = msg().modelFallback(ev.from, ev.to, ev.reason, ev.worker);
				if (!ev.worker) {
					clearTimeout(errorHold);
					orch.activeModel = ev.to;
				}
				if (ev.worker || chain) onNotice(line);
				else {
					// A silent switch to a weaker model went unnoticed for 50 minutes: the owner hears about it where alerts go.
					if (p.setModel) reverter.note(startedModel, revertWhy(ev.reason ?? "", adapter?.classifyError(ev.reason ?? "")), ev.from, ev.reason ?? "");
					onAlert(`${NAME}: ${line}${p.setModel ? "" : ` ${msg().modelNoRevert}`}`);
				}
				break;
			}
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
	const at = until.toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
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
		settleRevert(false);
		proc?.send(owner ? m.orchProvider(held.length) : m.orchRate(held.length), "followUp");
		armWatchdog();
	}, retry);
}

// Overloaded/5xx/network errors: after a failed turn, retry with backoff (bounded). Messages arriving meanwhile are not
// held: a new turn cancels the pending retry and itself serves as the retry. Past the limit the owner is told once.
let transientTries = 0;
const errorStreak = new ErrorStreak();
let streakAlerted = false;
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
		settleRevert(false);
		proc?.send(msg().orchTransient, "followUp");
		armWatchdog();
	}, wait);
}

// Past ROTATE_TOKENS of context, at an idle point, the context is made small so each message does not re-read a huge
// prefix (the runtime's own threshold is sized for coding sessions, not a secretary). A runtime that compacts in place
// (OmO) keeps its session and with it what it was doing; a fresh session with a handover of recent exchanges forgot the
// progress, so that is only the fallback when compaction fails (and the omp/Claude Code behaviour).
let rotateWhenIdle = false;
let compactRetried = false;
const compacting = () => orch.ctx.compaction.state === "queued" || orch.ctx.compaction.state === "compacting";
function limitContext(): void {
	if (!rotateWhenIdle && adapter?.caps.contextLimit === "compact") {
		log(`orchestrator context ${orch.ctx.tokens} tokens > ${ROTATE_TOKENS}; compacting in place`);
		requestCompact(orch.ctx, port);
	} else rotate();
}

// The nightly handover (hygiene.ts): an idle orchestrator whose session file grew past `limitBytes` starts a fresh
// session with a handover. Returns what it did, or undefined when nothing was needed.
export function nightlyHandover(limitBytes: number): string | undefined {
	if (!proc || orch.status !== "idle" || !orch.sessionFile || !existsSync(orch.sessionFile)) return undefined;
	const bytes = statSync(orch.sessionFile).size;
	if (bytes <= limitBytes) return undefined;
	rotate();
	return `orchestrator session file ${+(bytes / 1e6).toFixed(2)} MB > ${+(limitBytes / 1e6).toFixed(0)} MB: rotated to a fresh session with a handover`;
}

function rotate(): void {
	if (!proc || rotating) return;
	log(`orchestrator context ${orch.ctx.tokens} tokens; rotating to a fresh session`);
	rotateWhenIdle = false;
	compactRetried = false;
	rotating = true;
	proc.kill();
}

export function start(): void {
	if (proc) return;
	stopping = false;
	const { sessionFile: prior, model: priorModel, runtime: priorRuntime } = saved();
	const model = selectorOf(orchestratorModel());
	const runtime = runtimeFor("orchestrator");
	// Resuming a session on another model or thinking level re-writes the whole context to cache, so a model change
	// starts a fresh session with a handover instead (omonyang rule "model change = fresh session"); so does a change of
	// runtime (a session written by omp is not resumed by OmO; a state saved before the runtime was recorded is omp's).
	const rotate = prior && existsSync(prior) && (rotating || statSync(prior).size > ROTATE_BYTES || (priorModel !== undefined && priorModel !== model) || (priorRuntime ?? "omp") !== runtime.id);
	rotating = false;
	orch.ctx = newCtx();
	turnsSinceStart = 0;
	const resume = prior && existsSync(prior) && !rotate;
	// The keepalive's idle clock continues from the session's last answer, not from this process start: the cache of a
	// resumed session aged while the gateway was down (2026-10-20: a ping 2 h after the last turn re-wrote 98.7K).
	if (resume) lastTurnEnd = lastAnswerAt(prior) ?? lastTurnEnd;
	currentModel = model;
	clearTimeout(errorHold);
	adapter = runtime;
	const entries = chainAfter(model, fallbackChain("orchestrator"));
	// The hub switches the chain itself on OmO, and on omp when an entry is conditional (fallback.ts hubChain); otherwise the
	// runtime gets the models as its own plain fallback list.
	const driven = hubChain(runtime.id, entries);
	chain = driven ? new Chain(model, driven, orchestratorModel().thinking) : undefined;
	capped = undefined;
	let spawnModel = model;
	const env: Record<string, string> = { DOTZ_ORCHESTRATOR: "1" };
	if (chain) {
		const until = chain.exhaustedUntil();
		if (until !== undefined) return pauseExhausted(chain, until);
		chain.active = chain.initial();
		spawnModel = chain.selector(chain.active);
		Object.assign(env, chain.env(chain.active));
	}
	startedModel = spawnModel;
	reverter.reset();
	orch.activeModel = spawnModel;
	chained = !chain && entries.length > 0;
	proc = runtime.start({ role: "orchestrator", cwd: DATA_DIR, model: spawnModel, fallback: chain ? [] : entries.filter(e => !e.key_file).map(e => e.model), hubSwitches: Boolean(chain), resume: resume ? prior : undefined, env });
	orch.status = "starting";
	orch.startedAt = now();
	void readEvents(proc);
	const self = proc;
	void proc.exited.then(code => {
		if (proc !== self) return;
		proc = undefined;
		orch.status = "stopped";
		clearTimeout(errorHold);
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
		asksNext = false;
		const asks = pendingAsksBlock();
		proc.send(recall() + (rotate ? handover(runtime, prior!) : "") + (asks ? `\n\n${asks}` : ""), "prompt");
	} else asksNext = true;
	proc.watchSubagents();
	if (continueAfterSwitch && resume) {
		proc.send(msg().orchTransient, "followUp");
		armWatchdog();
	}
	continueAfterSwitch = false;
	for (const h of held.splice(0)) sendOwner(h.text, h.header);
	setTimeout(() => proc?.refreshSession(), 4000);
	log(`orchestrator ${resume ? `resumed ${prior}` : rotate ? "rotated to a fresh session" : "started"} (${model})`);
	statusActivity("orchestrator", `orchestrator ${resume ? "resumed its session" : rotate ? "started a fresh session with a handover" : "started"} (${model})`);
}

// When the model last answered in a session file: the timestamp of its last assistant message, read from the file's tail
// (startup bookkeeping lines after it and the file's mtime say nothing about the prompt cache).
export function lastAnswerAt(file: string, tailBytes = 512 * 1024): number | undefined {
	try {
		const size = statSync(file).size;
		const start = Math.max(0, size - tailBytes);
		const buf = Buffer.alloc(size - start);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buf, 0, buf.length, start);
		} finally {
			closeSync(fd);
		}
		const lines = buf.toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i]!.includes('"assistant"')) continue;
			try {
				const e = JSON.parse(lines[i]!);
				if (e.type !== "message" || e.message?.role !== "assistant") continue;
				const at = Date.parse(e.timestamp);
				if (Number.isFinite(at)) return at;
			} catch {}
		}
	} catch {}
	return undefined;
}

// A failed keepalive ping is not retried, failed over or alerted (2026-10-20 12:14 KST: one ping on a dead network ran four
// 5-minute retries, twice, and told the owner the model had stopped): it only kept a cache warm, so the next real message is
// the next try. Usage limits and owner-fixable errors still go through the normal path (they pause and hold messages).
export const keepaliveErrorDropped = (kind: ProviderErrorKind): boolean => kind !== "rate" && kind !== "owner";

// Keepalive (as on the macmini 오모냥): the 1h prompt cache would expire after an idle hour and the next message would
// re-write the whole prefix at 2x. A ping at 50-58 min idle costs a 0.1x read, so pinging wins for any gap shorter than
// ~18 pings; after KEEPALIVE_MAX consecutive pings (a night or longer away) the cache is allowed to expire.
const KEEPALIVE_FROM_MS = Number(process.env.DOTZ_KEEPALIVE_FROM_MS ?? 50 * 60_000);
const KEEPALIVE_TO_MS = Number(process.env.DOTZ_KEEPALIVE_TO_MS ?? 58 * 60_000);
const KEEPALIVE_MAX = 12;
setInterval(() => {
	const idle = Date.now() - lastTurnEnd;
	if (!proc || !adapter?.caps.promptCacheKeepalive || rotating || orch.status !== "idle" || keepalives >= KEEPALIVE_MAX || errorStreak.stopped) return;
	if (idle < KEEPALIVE_FROM_MS || idle > KEEPALIVE_TO_MS) return;
	keepalives++;
	inKeepalive = true;
	log(`keepalive ${keepalives}/${KEEPALIVE_MAX} after ${Math.round(idle / 60_000)} min idle`);
	proc.send(msg().keepalive, "prompt");
	armWatchdog();
}, Math.min(60_000, Math.max(5_000, (KEEPALIVE_TO_MS - KEEPALIVE_FROM_MS) / 2)));

// `owner` marks a prompt that carries an owner message (it gets the what-runs-now line); lane reports and gateway notes do not.
export function deliver(text: string, owner = false): void {
	if (rotating || restarting || orch.status === "rate-limited") {
		held.push({ text, header: owner });
		return;
	}
	if (!proc) start();
	sendOwner(text, owner);
	armWatchdog();
}

// Injects a note into the running turn (no effect when idle: the next prompt starts a turn anyway).
// True when the text went into the running turn.
// What keeps a requested gateway restart waiting: a turn, or a compaction queued or running (2026-10-20 19:47 KST: a restart
// 1 s after "compacting in place" lost the compaction, and the session came back at 244K tokens).
export function orchBusy(o: Pick<typeof orch, "status" | "ctx"> = orch): string | undefined {
	if (o.status === "working" || o.status === "starting") return "orchestrator";
	if (o.ctx.compaction.state === "queued" || o.ctx.compaction.state === "compacting") return "orchestrator compaction";
	return undefined;
}

export function steer(text: string): boolean {
	if (orch.status !== "working" || !proc) return false;
	proc.send(text, "steer");
	return true;
}

export function stop(): void {
	stopping = true;
	// A pause timer (usage limit, spent chain) must not start a stopped orchestrator again.
	clearTimeout(resumeTimer);
	resumeTimer = undefined;
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

// dotz's Claude account changed (hub/account-sticky.ts: a limit, or the owner pinned another): the process takes it at
// its next start, now when idle, after the running turn otherwise. No keepalive pings until the next real turn: a ping
// right after a switch would pay the whole prefix on the new account for nothing (2 of the 4 switches of 2026-10-20 did).
export function applyAccountChange(): "restarted" | "after-turn" | "next-start" {
	keepalives = KEEPALIVE_MAX;
	if (!proc) return "next-start";
	if (orch.status !== "idle") {
		pendingRestart = true;
		return "after-turn";
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

// A hub-driven chain may owe a return to an earlier entry (its limit reset) or a spend-cap decision; checked once a minute while idle.
setInterval(() => {
	settleRevert(true);
	void settleChain();
}, 60_000);
