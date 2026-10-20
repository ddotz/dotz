import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { basename, join, relative } from "node:path";
import { emitEventActivity, endSubagents, runningSubagents, statusActivity, workerCheck } from "./activity.ts";
import { pendingAskFile } from "./asks.ts";
import { cfg, chainAfter, DATA_DIR, fallbackChain, lanesCompactAt, lanesKeepRecent, lanesModel, log, now, parseSelector, paths, selectorOf, splitThinking, TZ, workerModel, writeAtomic } from "./config.ts";
import { formatHeader, kstClock, workersOf } from "./lanevis.ts";
import { lang, modeFile, msg, withReplyLine } from "./i18n.ts";
import { featurePrompt } from "./featuredirs.ts";
import { languageName, baseLanguage } from "./language.ts";
import { abandonCompact, type CompactPort, type Compaction, compactDue, type Ctx, ctxView, flushCompact, newCtx, noteEvent, requestCompact } from "./context.ts";
import { OWNER_RETRY_MS, type ProviderErrorKind, rateLimitDelay, TRANSIENT_RETRIES, transientBackoff } from "./providers.ts";
import { HARNESS_NAMES, runtimeFor } from "./runtime/index.ts";
import type { AgentError, AgentProcess } from "./runtime/types.ts";
import { atTime, Chain, failsOver, failureReason, hubChain, type Move, Reverter, revertWhy } from "./fallback.ts";
import { parseTone } from "./tone.ts";
import { broadcast } from "./events.ts";

const REPORT_DEBOUNCE_MS = Number(process.env.DOTZ_REPORT_DEBOUNCE_MS ?? 0);
// A lane started with a fallback chain: after a failed request the runtime may move to the next model by itself and redo
// the turn, so the failure is acted on (pause, retry, error report) only when no such switch follows within a short grace.
const FALLBACK_GRACE_MS = 3000;
const PROGRESS_EVERY_MS = Number(process.env.DOTZ_PROGRESS_MS ?? 5 * 60_000);
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
type Claim = { state: "reported" | "verified"; at: string; evidence?: string; problems?: string[] };
// A lane's own [ask] report stays a question for the owner until the owner answers (sendToLane) or the lane reports again.
// The full text also sits in pending-ask.md (dir(name)) while pending, because report.md is overwritten by gateway notices.
type Ask = { text: string; at: string };
// `runtime`: the runtime that wrote sessionFile (omo, omp, claude); a session is only ever resumed by that runtime.
type Record_ = { name: string; title?: string; cwd: string; model: string; workerModel?: string; fableOk?: boolean; status: LaneStatus; startedAt: string; sessionFile?: string; runtime?: string; reports: number; lastReportAt?: string; held?: string[]; worktree?: Worktree; claim?: Claim; pendingAsk?: Ask };
export type Lane = Record_ & {
	ctx: Ctx;
	// The orchestrator sent work (launch, dotz_lane send) that no relayed report answered yet; an owner-only exchange in
	// the lane channel leaves it false, so that reply is not relayed (lanerelay.ts); unknown (a restored lane) relays.
	orchAsked?: boolean;
	lastText: string;
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
// One line for the lane's channel when the runtime moves it, or one of its task workers, to the next model of a fallback
// chain. Not a report: it does not wake the orchestrator.
let onNotice: ReportFn = () => {};
export function setNoticeHandler(fn: ReportFn): void {
	onNotice = fn;
}
// Called when a lane's turn has ended and it is idle again (after its report had its chance to go out); main.ts sends
// the web messages queued for that lane.
let onIdle: (name: string) => void = () => {};
export function setIdleHandler(fn: (name: string) => void): void {
	onIdle = fn;
}

const dir = (name: string) => join(paths.lanes, name);
function persist(lane: Lane): void {
	const { name, title, cwd, model, workerModel, fableOk, status, startedAt, sessionFile, runtime, reports, lastReportAt, held, worktree, claim, pendingAsk } = lane;
	mkdirSync(dir(name), { recursive: true });
	writeAtomic(join(dir(name), "lane.json"), `${JSON.stringify({ name, ...(title ? { title } : {}), cwd, model, workerModel, ...(fableOk ? { fableOk } : {}), status, startedAt, sessionFile, ...(runtime ? { runtime } : {}), reports, ...(lastReportAt ? { lastReportAt } : {}), ...(held?.length ? { held } : {}), ...(worktree ? { worktree } : {}), ...(claim ? { claim } : {}), ...(pendingAsk ? { pendingAsk } : {}) }, null, 2)}\n`);
}
function setStatus(lane: Lane, status: LaneStatus): void {
	if (lane.status === status) return;
	const wasLive = laneLive(lane);
	lane.status = status;
	if (status === "working") lane.workingSince = Date.now();
	persist(lane);
	// Every lane list in the web app re-reads the state on this frame, so an ended lane leaves them at once.
	broadcast({ kind: "lanes", lane: lane.name, status, live: laneLive(lane), was_live: wasLive });
}

// Compaction needs an idle process: a runtime may abort a running turn to compact, so a busy lane queues it until turn_end.
const portOf = (lane: Lane): CompactPort => ({ idle: () => lane.status === "idle", compact: () => lane.proc?.compact(), refreshUsage: () => lane.proc?.refreshUsage() });

// A paused lane (rate limit) keeps owner messages on disk instead of starting turns that fail at once; they go in with
// the resume note.
function prompt(lane: Lane, text: string): void {
	lane.silent = undefined;
	// OmO refuses a prompt while a requested compaction runs, so a message sent then was lost (2026-10-21, the same hole
	// as the orchestrator's): it is held and goes in when the compaction ends (or with the resume note if it failed).
	if (lane.status === "rate-limited" || (lane.status !== "working" && lane.ctx.compaction.state === "compacting")) {
		(lane.held ??= []).push(text);
		persist(lane);
		return;
	}
	settleRevert(lane, false);
	// Every lane turn ends with the reply-language line too: lane progress notes drifted into English ("Now a throwaway
	// smoke script against a temp DOTZ_DIR.") because the language sat only in the launch footer.
	const nudge = lane.retainNext ? `\n${msg().retainNudge}` : "";
	lane.retainNext = undefined;
	lane.proc?.send(`${text}${nudge}\n${msg().replyIn(languageName(lang()), false)}`, lane.status === "working" ? "steer" : "prompt");
	if (lane.status === "working") return;
	clearTimeout(lane.watchdog);
	lane.watchdog = setTimeout(() => {
		log(`lane ${lane.name} did not start a turn after a prompt; restarting it`);
		lane.revive = { text: msg().laneStopped };
		lane.proc?.kill(true);
	}, WATCHDOG_MS);
}

// A finished turn's report goes out at turn_end, as 오모냥 replied the moment its turn ended (DOTZ_REPORT_DEBOUNCE_MS
// can add a wait). It is kept on disk until sent, so a gateway restart in between sends it on the next start.
const pendingFile = (lane: Lane) => join(dir(lane.name), "pending-report.md");

// `notice` marks a gateway-written text ([lane error], [lane exited], pause/rate-limit): it is not the lane speaking, so it
// leaves a pending ask alone.
function report(lane: Lane, text: string, notice = false): void {
	rmSync(pendingFile(lane), { force: true });
	lane.reports++;
	lane.lastReportAt = now();
	const tone = parseTone(text).tone;
	// A report without a marker (a gateway notice, or the OmO handoff block "Ask: ... wanted: ..." that an OmO lane posts
	// as a separate turn right after its [done], custom-ui 2026-10-20) leaves the claim as it was; [run]/[ask]/[fail] withdraw it.
	lane.claim = tone === "done" ? { state: "reported", at: now() } : tone ? undefined : lane.claim;
	if (tone === "ask" && !notice) {
		lane.pendingAsk = { text, at: now() };
		writeAtomic(pendingAskFile(lane.name), `${text}\n`);
	} else if (!notice) clearAsk(lane);
	persist(lane);
	writeFileSync(join(dir(lane.name), "report.md"), `${text}\n`);
	// A [done] is checked against the task metadata before it is relayed; what contradicts it goes along with it. So is a
	// report without a leading marker that says [done] further down (an OmO lane can open with its handoff block, "Ask: ...").
	const claimsDone = tone === "done" || (!tone && /\[(done|완료)\]/i.test(text));
	if (notice || !claimsDone) return onReport(lane, text);
	const what = tone === "done" ? "[done]" : "report";
	const claim = lane.claim;
	void workerCheck(`lane:${lane.name}`, lane.workingSince ?? 0, lane.sessionFile)
		.catch(e => [`task metadata unreadable: ${e}`])
		.then(problems => {
			if (!problems.length) return onReport(lane, text);
			if (lane.claim === claim && claim) {
				claim.problems = problems.slice(0, 10);
				persist(lane);
			}
			log(`lane ${lane.name} ${what} contradicted by task metadata: ${problems.join("; ")}`);
			onReport(lane, `${text}\n\n[gateway check] task metadata contradicts this ${what}; do not take it as verified:\n- ${problems.slice(0, 10).join("\n- ")}`);
		});
}
// Drops the pending ask; the caller persists.
function clearAsk(lane: Lane): void {
	if (!lane.pendingAsk) return;
	lane.pendingAsk = undefined;
	rmSync(pendingAskFile(lane.name), { force: true });
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
	// A transient provider error is being retried, or a failed request is still being resolved (a fallback may redo it):
	// the failed turn is not a report.
	if (lane.transientTimer || lane.failing) return;
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
		report(lane, lane.lastText, lane.lastText.startsWith("[lane error]"));
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
	const { ms: wait, reset } = owner ? { ms: OWNER_RETRY_MS, reset: false } : await rateLimitDelay(err, lane.model, "lane");
	lane.pausing = false;
	if (lane.status !== "rate-limited") return;
	const at = new Date(Date.now() + wait).toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
	if (!lane.pauseReported || lane.pauseKind !== kind) {
		report(lane, owner
			? `모델 제공자 결제/인증 문제로 멈췄어요 (${err.replace(/\s+/g, " ").slice(0, 160)}). 크레딧 충전이나 로그인 확인이 필요해요. 그동안 온 메시지는 모아뒀다가 해결되면 이어서 처리하고, ${Math.round(wait / 60_000)}분마다 다시 시도해요.`
			: `사용량 한도에 걸려서 멈췄어요. ${reset ? `한도가 리셋되는 ${at} 직후에` : `${at}쯤부터`} 다시 시도하고, 그동안 온 메시지는 모아뒀다가 이어서 처리해요.`, true);
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

// A failed request: a usage limit or a billing/auth problem pauses the lane, a temporary provider error is retried with backoff, anything else is reported as a lane error.
function handleError(lane: Lane, e: AgentError): void {
	if (lane.chain && failsOver(e.kind) && !(e.kind === "transient" && (lane.transientTries ?? 0) < TRANSIENT_RETRIES)) void failOver(lane, e).then(moved => !moved && legacyError(lane, e));
	else legacyError(lane, e);
}
function legacyError(lane: Lane, e: AgentError): void {
	lane.failing = false;
	if (e.kind === "rate" || e.kind === "owner") void pauseForRateLimit(lane, e.text, e.kind);
	else if (e.kind !== "transient" || !retryTransient(lane, e.text)) {
		lane.lastText = `[lane error] ${(e.text || "model request failed").slice(0, 300)}`;
		scheduleReport(lane);
	}
}
// The next entry of a hub-driven chain takes over when the active one fails (a temporary error is retried a few times first).
async function failOver(lane: Lane, e: AgentError): Promise<boolean> {
	const active = lane.chain;
	if (!active) return false;
	const reason = failureReason({ kind: e.kind, text: e.text });
	const until = reason === "quota" ? Date.now() + (await rateLimitDelay(e.text, active.selector(active.active), "lane")).ms : undefined;
	// The restart resumes the session, so it must be known; a first request that failed at once may not have reported it yet.
	for (let i = 0; i < 20 && !lane.sessionFile && lane.proc; i++) {
		if (i === 0) lane.proc.refreshSession();
		await Bun.sleep(100);
	}
	if (lane.chain !== active || !lane.proc || !lane.sessionFile) return false;
	const move = active.fail(reason, until);
	if (!move) return false;
	return switchTo(lane, move, true);
}
// Restarts the lane on the same session with another entry of its chain (spawn() picks it from the persisted limit and spend
// state); `again` tells it to redo the request that just failed.
function switchTo(lane: Lane, move: Move, again: boolean): boolean {
	if (!lane.chain || !lane.proc || lane.revive) return false;
	lane.failing = false;
	const line = msg().fallbackMove(lane.chain.label(move.from), lane.chain.label(move.to), move.why);
	log(`lane ${lane.name} ${line}`);
	onNotice(lane, line);
	clearTimeout(lane.timer);
	rmSync(pendingFile(lane), { force: true });
	lane.revive = { text: again ? msg().laneTransient : undefined };
	lane.proc.kill(true);
	return true;
}
// Switches the lane's process back to its configured model once that is due: before a prompt starts a turn (a refusal, a
// provider error, or a usage limit that has reset), or at an idle moment for a usage limit that has reset. Never mid-turn.
function settleRevert(lane: Lane, idle: boolean): void {
	if (!lane.proc?.setModel || lane.chain || lane.status === "working" || lane.status === "rate-limited" || (idle && lane.status !== "idle")) return;
	const to = lane.reverter?.take(idle);
	if (!to) return;
	lane.proc.setModel(to);
	lane.activeModel = to;
	const line = msg().modelReverted(parseSelector(to).model);
	log(`lane ${lane.name} ${line}`);
	onNotice(lane, line);
}
// At an idle moment: act on a spend cap reached during the turn, or go back to an earlier entry whose limit has reset.
function settleChain(lane: Lane): void {
	if (!lane.chain || !lane.proc || lane.status !== "idle" || lane.revive || runningSubagents(`lane:${lane.name}`) > 0) return;
	if (lane.capped) {
		const reached = lane.capped;
		lane.capped = undefined;
		if (reached.move) switchTo(lane, reached.move, false);
		else pauseExhausted(lane, lane.chain, lane.chain.exhaustedUntil() ?? lane.chain.down(lane.chain.active)?.until ?? Date.now() + 3_600_000);
		return;
	}
	const back = lane.chain.revertTarget();
	if (back) switchTo(lane, back, false);
}
// Every entry is spent: the lane holds its messages until the earliest cap period ends, then starts again.
function pauseExhausted(lane: Lane, c: Chain, until: number): void {
	setStatus(lane, "rate-limited");
	const at = new Date(until).toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
	const line = msg().fallbackExhausted(c.label(c.active), at);
	log(`lane ${lane.name} ${line}`);
	onNotice(lane, line);
	report(lane, line, true);
	lane.pauseReported = true;
	clearTimeout(lane.resumeTimer);
	atTime(until, t => (lane.resumeTimer = t), () => {
		lane.resumeTimer = undefined;
		setStatus(lane, "idle");
		if (lane.proc) {
			lane.revive = { text: msg().laneRate };
			lane.proc.kill(true);
		} else resumeLane(lane, msg().laneRate);
	});
}

async function readEvents(lane: Lane, proc: AgentProcess): Promise<void> {
	const source = `lane:${lane.name}`;
	// Whether the turn was running when the current frame's first event arrived (before any of its events took effect).
	let wasWorking = false;
	for await (const ev of proc.events) {
		emitEventActivity(source, ev);
		noteEvent(lane.ctx, ev, portOf(lane));
		switch (ev.type) {
			case "alive":
				lane.lastFrameAt = Date.now();
				wasWorking = lane.status === "working";
				break;
			case "turn_start":
				clearTimeout(lane.watchdog);
				clearTimeout(lane.timer);
				clearTimeout(lane.transientTimer);
				clearTimeout(lane.errorHold);
				lane.failing = false;
				lane.transientTimer = undefined;
				rmSync(pendingFile(lane), { force: true });
				setStatus(lane, "working");
				lane.progressAt = Date.now();
				break;
			case "assistant":
				if (ev.stop !== "error") lane.transientTries = 0;
				if (ev.text) lane.lastText = ev.text;
				// A compaction error is recovered by recover() below (restart on the same session), not retried here.
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
					// OmO lanes do not read lanes.compact_at (only the omp overlay does), so the hub compacts an idle lane at it.
					if (compactDue(lane.ctx, lanesCompactAt())) requestCompact(lane.ctx, portOf(lane));
					else flushCompact(lane.ctx, portOf(lane));
				}
				if (lane.status === "idle") setTimeout(() => lane.status === "idle" && onIdle(lane.name), REPORT_DEBOUNCE_MS + 100);
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
				if (ev.state === "error") recover(lane, `컨텍스트 압축이 실패했어요 (${ev.error.slice(0, 120)})`, wasWorking);
				else {
					lane.retainNext = true;
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
				onNotice(lane, line);
				break;
			}
		}
	}
}

export const laneWorkerModel = (lane: Pick<Lane, "workerModel">) => lane.workerModel ?? workerModel();

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
const harnessName = (id: string) => HARNESS_NAMES[id] ?? id;

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
// The owner's yes to a handover offer (a bare "인계" / "handover", as typed in the lane channel or the web lane view).
const HANDOVER_RE = /^\s*(인계|인계해(줘|요)?|인계\s*ㄱ+|handover|hand\s*over|새\s*(세션|대화\s*기록)(으로)?(\s*이어가(기|줘)?)?)\s*[.!]*\s*$/i;
const ownerWords = (text: string) => text.replace(/^\[owner via [^\]]+\]\s*/, "");

// Starts the lane's process; false when a resume is refused because the session belongs to another runtime (the lane is
// then left exited, untouched).
function spawn(lane: Lane, resume: boolean): boolean {
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
		Object.assign(env, lane.chain.env(lane.chain.active));
	}
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
		lane: { name: lane.name, dir: dir(lane.name), workerModel: laneWorkerModel(lane), workerFallback: chainAfter(laneWorkerModel(lane), fallbackChain("workers")).map(e => e.model), compactAt: lanesCompactAt(), keepRecent: lanesKeepRecent() },
	});
	lane.activeModel = spawnModel;
	lane.startedModel = spawnModel;
	lane.reverter = new Reverter();
	lane.chained = !lane.chain && entries.length > 0;
	lane.activeWorkerModel = laneWorkerModel(lane);
	lane.proc = proc;
	lane.quiet = false;
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
		if (lane.revive && lane.sessionFile) {
			const { text } = lane.revive;
			if (text) resumeLane(lane, text);
			else if (spawn(lane, true)) setStatus(lane, "idle");
			return;
		}
		if (code !== 0 && code !== 143) report(lane, `[lane exited] 프로세스가 종료됐습니다 (code ${code}). 마지막 상태: ${lane.lastText.slice(0, 300) || "없음"}`, true);
	});
	proc.watchSubagents();
	setTimeout(() => lane.proc?.refreshSession(), 3000);
	return true;
}

// A lane stopped after its merge lost its worktree (dropWorktree moved cwd back to the owner's checkout); resuming it
// would edit that checkout directly, so it gets a fresh worktree from the current HEAD and is told the new path.
function resumeLane(lane: Lane, text: string): void {
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

// Gives a lane whose worktree went with its merge a fresh one; the text gets the new path in front.
function withWorktree(lane: Lane, text: string): string {
	if (lane.worktree) return text;
	const place = laneWorktree(lane.name, lane.cwd);
	if (!place.worktree) return text;
	lane.cwd = place.cwd;
	lane.worktree = place.worktree;
	persist(lane);
	return `${worktreeNote(place.worktree)}\n\n${text}`;
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
	onReport(lane, `[lane recovery] ${why}. 진행 중이던 요청을 중단하고 같은 대화 기록으로 다시 이어서 시작해요 (${lane.recoveries.length}/${RECOVERY_MAX}).`);
	lane.revive = { text: wasWorking ? msg().laneStopped : undefined };
	lane.proc.kill(true);
}

const activeCount = () => [...lanes.values()].filter(l => l.status === "working" || l.status === "starting").length;
// Concurrent task workers a lane may run, from this machine's cores and memory (an omp worker is a process of a few
// hundred MB, mostly waiting on the model), capped by omp's task.maxConcurrency default of 8.
export const WORKER_SLOTS = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2), Math.floor(totalmem() / 2 ** 32)));

function footer(lane: Lane): string {
	const features = featurePrompt(DATA_DIR, "lanes", log);
	// The owner's verbatim don'ts (memory/boundaries.md) bind a lane too; the empty template adds nothing.
	const boundaries = existsSync(paths.boundaries) ? readFileSync(paths.boundaries, "utf8").trim() : "";
	const donts = boundaries.includes("\n- [") ? `\n\n${boundaries.slice(0, 2000)}` : "";
	return withReplyLine(msg().footer({ lane: lane.name, mode: modeFile(), workerModel: laneWorkerModel(lane), slots: WORKER_SLOTS, worktree: worktreeNote(lane.worktree) })) + donts + (features ? `\n\n${features}` : "");
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

// A lane is for multi-hour, multi-step project work (the 오모냥 rule): anything shorter the orchestrator does itself or
// with task subagents, whose results come back into its own session, so no channel, worktree or report relay is spent on
// it. The launch must say why a lane is needed and how long the work is expected to take; under LANE_MIN_HOURS it is
// refused unless the owner asked for a lane.
export const LANE_MIN_HOURS = 1;
export function laneJustification(why: unknown, hours: unknown, ownerAsked: boolean): string | undefined {
	const reason = typeof why === "string" ? why.trim() : "";
	if (reason.length < 15) return "say why this needs a lane (why): a lane is only for multi-hour, multi-step project work; do shorter work yourself or with task subagents, whose results come back into your session";
	if (ownerAsked) return undefined;
	const h = Number(hours);
	if (!Number.isFinite(h) || h <= 0) return "give the expected duration in hours (hours)";
	if (h < LANE_MIN_HOURS) return `a ${h}h job does not get a lane (lanes start at ${LANE_MIN_HOURS}h): do it yourself or with task subagents, whose results come back into your session`;
	return undefined;
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

export type BudgetOutcome = "go" | "blocked" | "forced" | "unknown";
// One audit line per lane-launch gate decision; unfetched windows print as "?".
export function budgetLine(name: string, est: number, five: number | undefined, week: number | undefined, outcome: BudgetOutcome): string {
	const left = (v: number | undefined) => (typeof v === "number" ? `${v}% left` : "? left");
	return `budget gate: lane ${name} est ${est}% 5h ${left(five)} 7d ${left(week)} -> ${outcome}`;
}

// The owner-facing title of a lane or work channel (docs/layers.md §2): 2-4 plain words of the work, never the key, the
// folder or repo basename, or anything codename-shaped. A reason in one line for the agent to retry with, else undefined.
const CODENAME = /^[a-z0-9._-]+$/;
export function titleProblem(title: unknown, ctx: { key?: string; cwd?: string; repo?: string } = {}): string | undefined {
	const t = typeof title === "string" ? title.trim() : "";
	const hint = "use 2-4 plain words of the work in the owner's language (e.g. 디스코드 설정)";
	if (!t) return `title required: ${hint}`;
	const same = [ctx.key, ctx.cwd && basename(ctx.cwd.replace(/\/+$/, "")), ctx.repo && basename(ctx.repo.replace(/\/+$/, ""))].filter(Boolean).map(s => s!.toLowerCase());
	if (same.includes(t.toLowerCase())) return `title "${t}" is the key or a folder name, not a title: ${hint}`;
	if (CODENAME.test(t)) return `title "${t}" looks like a codename (only a-z, 0-9, . _ -): ${hint}`;
	return undefined;
}

export function launch(name: string, cwd: string, brief: string, model?: string, worker?: string, fableOk?: boolean, title?: string): Lane {
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
	const lane: Lane = { name, ...(title ? { title } : {}), cwd: place.cwd, worktree: place.worktree, model: selector, workerModel: worker || undefined, fableOk: fableOk || undefined, status: "starting", startedAt: now(), lastText: "", reports: 0, ctx: newCtx(), orchAsked: true };
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
	if (!lane.proc && lane.sessionFile) {
		const wrong = runtimeMismatch(lane);
		if (wrong && HANDOVER_RE.test(ownerWords(text))) return handoverLane(name);
		if (wrong) {
			if (!HANDOVER_RE.test(ownerWords(text)) && text !== "/budget-ok") lane.pendingHandover = text;
			throw wrong;
		}
	}
	if (!lane.proc && (!lane.sessionFile || !existsSync(lane.sessionFile))) throw new Error(`lane ${name} is not running and has no session to resume`);
	// New work makes an unchecked [done] claim stale; a verified one stays until the lane's next report replaces it.
	// Any message to the lane is the owner's answer to a pending [ask].
	if (lane.claim?.state === "reported" || lane.pendingAsk) {
		if (lane.claim?.state === "reported") lane.claim = undefined;
		clearAsk(lane);
		persist(lane);
	}
	if (!/^\[owner via /.test(text) && text !== "/budget-ok") lane.orchAsked = true;
	if (lane.proc) return prompt(lane, text);
	resumeLane(lane, text);
}

function known(name: string): Lane {
	const lane = lanes.get(name);
	if (!lane) throw new Error(`no lane ${name}`);
	return lane;
}

// A lane's "done" report is only its own claim (OMH evidence labels: reported vs verified); "verified" is set here, by the
// orchestrator, after it checked the Done-when itself, and any later report that is not [done] withdraws the claim.
export function verifyLane(name: string, evidence: string): void {
	const lane = known(name);
	if (lane.claim?.state !== "reported") throw new Error(`lane ${name} has no reported-done claim to verify${lane.claim ? " (already verified)" : ""}`);
	const text = evidence.trim();
	if (!text) throw new Error("verify needs evidence: what was run and its result");
	if (lane.claim.problems?.length) throw new Error(`task metadata contradicts lane ${name}'s [done] (${lane.claim.problems.join("; ")}); have the lane redo or explain it, then verify its next [done]`);
	lane.claim = { state: "verified", at: now(), evidence: text.slice(0, 1000) };
	persist(lane);
}

// "보고됨 · " / "확인됨 · " for a lane's worklog entry; empty while the lane has no claim.
export function claimPrefix(name: string): string {
	const state = lanes.get(name)?.claim?.state;
	if (!state) return "";
	const ko = baseLanguage(lang()) === "ko";
	return `${state === "verified" ? (ko ? "확인됨" : "verified") : ko ? "보고됨" : "reported"} · `;
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
	lane.proc.abort();
}

// Resumes a stopped lane (or, with text, steers a running one) from its saved session.
export function resumeByName(name: string, text?: string): void {
	const lane = known(name);
	if (lane.proc) {
		if (!text) throw new Error(`lane ${name} is already running`);
		if (lane.pendingAsk) {
			clearAsk(lane);
			persist(lane);
		}
		return prompt(lane, text);
	}
	const wrong = runtimeMismatch(lane);
	if (wrong) {
		if (text) lane.pendingHandover = text;
		throw wrong;
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
	// The process runs on the runtime it started on; a runtime switched in config since then cannot take its session over.
	const wrong = runtimeMismatch(lane);
	if (wrong) throw wrong;
	const wasWorking = lane.status === "working" || lane.status === "starting";
	const old = lane.proc;
	lane.quiet = true;
	old.kill();
	await old.exited;
	if (wasWorking) resumeLane(lane, note);
	else if (spawn(lane, true)) setStatus(lane, "idle");
}

// Persists a new model selector on the lane record. A running idle lane switches in place on its session (set_model /
// set_thinking_level, no restart); a working one, or one on a fallback entry or a runtime-owned fallback list, restarts
// and resumes its session.
export async function setLaneModel(name: string, selector: string): Promise<"live" | "restarted" | "next-start"> {
	const lane = known(name);
	lane.model = selector;
	persist(lane);
	if (!lane.proc) return "next-start";
	if (switchLaneInPlace(lane)) return "live";
	await restartLane(name);
	return "restarted";
}
function switchLaneInPlace(lane: Lane): boolean {
	if (!lane.proc?.setModel || lane.chained || lane.status !== "idle" || (lane.chain && lane.chain.active !== 0)) return false;
	const driven = hubChain(runtimeFor("lane").id, chainAfter(lane.model, fallbackChain("lanes")));
	const next = driven ? new Chain(lane.model, driven, parseSelector(lane.model).thinking) : undefined;
	if (next && next.initial() !== 0) return false;
	lane.proc.setModel(lane.model);
	lane.chain = next;
	lane.capped = undefined;
	lane.activeModel = lane.startedModel = lane.model;
	lane.reverter = new Reverter();
	log(`lane ${lane.name} switched in place to ${lane.model}`);
	statusActivity(`lane:${lane.name}`, `lane switched to ${lane.model} on its session`);
	return true;
}

// Compacts a running lane's context: now when idle, after the running turn otherwise. Rewrites the prompt cache once.
export function compactLane(name: string): Compaction {
	const lane = known(name);
	if (!lane.proc) throw new Error(`lane ${name} is not running (resume it first)`);
	return requestCompact(lane.ctx, portOf(lane));
}

// Asks a running lane's runtime for its current context numbers (they arrive as a usage event).
export function refreshLaneStats(name: string): void {
	const lane = known(name);
	lane.proc?.refreshUsage();
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
	lane.retainNext = undefined; // the fresh session's handover already carries the nudge
	spawn(lane, false);
	const tail = previous && existsSync(previous) ? runtimeFor("lane").recentExchanges(previous) : undefined;
	const brief = join(dir(name), "brief.md");
	const lastReport = join(dir(name), "report.md");
	prompt(lane, withReplyLine(`${msg().laneRotated(why, lane.cwd, brief, lastReport)}${previous ? `\n\n${msg().laneHandover(previous, tail)}` : ""}`));
	lane.silent = { lastText: lane.lastText };
}

// The same lane in a fresh session on the current runtime, for a session another runtime wrote (runtimeMismatch): the
// lane keeps its name, channel, folder, model, brief and goal and gets the previous session's recent exchanges (OmO and omp
// write the same session format), its brief and its last report. The owner message the refused resume carried, or `text`,
// goes in the same prompt; without one the reload turn is silent, as after a rotation.
export function handoverLane(name: string, text?: string): void {
	const lane = known(name);
	if (lane.proc) throw new Error(`lane ${name} is running; it needs no handover`);
	const previous = lane.sessionFile;
	const from = harnessName(sessionRuntime(lane) ?? "?");
	const to = harnessName(runtimeFor("lane").id);
	const owner = text?.trim() || lane.pendingHandover;
	lane.pendingHandover = undefined;
	lane.ctx = newCtx();
	lane.retainNext = undefined;
	lane.sessionFile = undefined;
	const tail = previous && existsSync(previous) ? runtimeFor("lane").recentExchanges(previous) : undefined;
	const brief = join(dir(name), "brief.md");
	const lastReport = join(dir(name), "report.md");
	const prior = previous ? `\n\n${msg().laneHandover(previous, tail)}` : "";
	const lead = owner ? msg().laneRuntimeHandover(from, to, lane.cwd, brief, lastReport) : msg().laneRotated(`${from} -> ${to}`, lane.cwd, brief, lastReport);
	const body = withWorktree(lane, `${lead}${prior}`);
	spawn(lane, false);
	log(`lane ${name} handed over to a fresh ${to} session (previous ${from} session ${previous ?? "none"})`);
	if (owner) return prompt(lane, withHeld(lane, `${body}\n\n${owner}`));
	prompt(lane, withReplyLine(body));
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
		const lane: Lane = { ...rec, lastText: "", ctx: newCtx() };
		lanes.set(name, lane);
		if (existsSync(pendingFile(lane))) {
			lane.lastText = readFileSync(pendingFile(lane), "utf8");
			report(lane, lane.lastText, lane.lastText.startsWith("[lane error]"));
		}
		const wrong = runtimeMismatch(lane);
		if (wrong && rec.status !== "exited") log(`lane ${name} not restored: its session was written by ${wrong.from}, lanes run on ${wrong.to} (a message to it offers a handover)`);
		const session = !wrong && Boolean(rec.sessionFile && existsSync(rec.sessionFile));
		if (session && (rec.status === "working" || rec.status === "starting" || rec.status === "rate-limited")) {
			resumeLane(lane, msg().laneGatewayRestarted);
			resumed.push(name);
		} else if (session && rec.status === "idle") {
			if (spawn(lane, true)) setStatus(lane, "idle");
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

// dotz's Claude account changed (hub/account-sticky.ts): every running lane takes it by a restart on its session, at once
// when idle, else at the first idle check after its turn and workers end (a restart would cut them off).
export function applyAccountChange(): void {
	for (const lane of lanes.values()) if (lane.proc) lane.accountStale = true;
	restartStaleLanes();
}
// The lanes' fallback chain in config changed (hub/control.ts setFallback), as the orchestrator's (orchestrator.ts
// applyChainChange): an OmO lane on its primary takes the new chain in place, a lane paused on a limit restarts now (held
// messages go in with the resume note), and a lane on a fallback entry restarts on its session at its next idle moment.
export function applyChainChange(): void {
	for (const lane of lanes.values()) {
		if (!lane.proc) continue;
		if (lane.status === "rate-limited") {
			if (!lane.pausing) void restartPaused(lane).catch(e => log(`lane ${lane.name} restart for the new fallback chain failed: ${(e as Error).message}`));
		} else if (lane.runtime === "omo" && (!lane.chain || lane.chain.active === 0)) {
			const driven = hubChain("omo", chainAfter(lane.model, fallbackChain("lanes")));
			lane.chain = driven ? new Chain(lane.model, driven, parseSelector(lane.model).thinking) : undefined;
			lane.capped = undefined;
		} else lane.accountStale = true;
	}
	restartStaleLanes();
}
async function restartPaused(lane: Lane): Promise<void> {
	clearTimeout(lane.resumeTimer);
	lane.resumeTimer = undefined;
	const old = lane.proc!;
	lane.quiet = true;
	old.kill();
	await old.exited;
	setStatus(lane, "idle");
	resumeLane(lane, msg().laneRate);
}
function restartStaleLanes(): void {
	for (const lane of lanes.values()) {
		if (!lane.accountStale || !lane.proc || lane.status !== "idle" || laneBusy(lane) || lane.revive) continue;
		lane.accountStale = false;
		void restartLane(lane.name).catch(e => log(`lane ${lane.name} account restart failed: ${(e as Error).message}`));
	}
}

setInterval(() => {
	restartStaleLanes();
	for (const lane of lanes.values()) {
		settleChain(lane);
		settleRevert(lane, true);
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

// Throwaway projects (lanes run in a temp folder, e.g. gateway tests) are never shown as live lanes.
const TEMP_RE = /^\/(private\/)?(tmp|var\/folders)\//;
export const isTempLane = (l: Pick<Lane, "cwd" | "worktree">): boolean => TEMP_RE.test(l.worktree?.repo ?? l.cwd) || TEMP_RE.test(l.cwd);
// The one definition of a live lane every list uses (home, lane tab, target chips, sidebar, pickers, palette): not exited,
// its process up (or being restarted in place), and not a temp test project. Ended lanes keep all their data.
export const laneRunning = (l: Lane): boolean => l.status !== "exited" && (Boolean(l.proc) || Boolean(l.quiet) || l.status === "starting");
export const laneLive = (l: Lane): boolean => laneRunning(l) && !isTempLane(l);
export function liveLanes(): { live: string[]; ended: string[] } {
	const all = [...lanes.values()];
	return { live: all.filter(laneLive).map(l => l.name), ended: all.filter(l => !laneLive(l)).map(l => l.name) };
}

export const laneModels = () => [...lanes.values()].map(l => ({ name: l.name, ...parseSelector(l.model), status: l.status, live: laneLive(l), running: Boolean(l.proc), worker_model: laneWorkerModel(l), worker_model_override: l.workerModel, ...(l.proc ? { active_model: l.activeModel, active_worker_model: l.activeWorkerModel } : {}) }));

export function laneSummary(): Array<Record<string, unknown>> {
	return [...lanes.values()].map(l => ({
		name: l.name,
		...(l.title ? { title: l.title } : {}),
		cwd: l.cwd,
		// the checkout a worktree lane works for (its cwd is ~/.dotz/lanes/<name>/worktree)
		...(l.worktree ? { repo: l.worktree.repo } : {}),
		model: l.model,
		worker_model: laneWorkerModel(l),
		status: l.status,
		live: laneLive(l),
		startedAt: l.startedAt,
		reports: l.reports,
		claim: l.claim,
		pendingAsk: l.pendingAsk,
		sessionFile: l.sessionFile,
		resumable: !l.proc && Boolean(l.sessionFile),
		lastText: l.lastText.slice(0, 600),
		context: ctxView(l.ctx),
	}));
}

// The `dotz_lane list` view: the lane summary plus what each lane is doing right now (running task workers with their last
// tool intent, from the hub's own state) and when its last report went out. The new keys come first because the tool
// output is cut at a fixed length, and a long lastText must not push the workers out of it.
export function laneList(): Array<Record<string, unknown>> {
	return laneSummary().map(s => {
		const lane = lanes.get(String(s.name))!;
		return { name: s.name, status: s.status, workers: workersOf(`lane:${lane.name}`), last_report_at: lane.lastReportAt ?? null, last_report_kst: lane.lastReportAt ? kstClock(lane.lastReportAt) : null, ...s };
	});
}

// The leading line of an owner prompt (see formatHeader); empty when nothing runs.
export const turnHeader = (): string => formatHeader([...lanes.values()].map(l => ({ name: l.name, status: l.status, workers: workersOf(`lane:${l.name}`).map(w => w.name) })), workersOf("orchestrator").map(w => w.name));
