import { type Lane, setStatus, hooks, pendingFile } from "./lanestate.ts";
import { type ProviderErrorKind, OWNER_RETRY_MS, rateLimitDelay, TRANSIENT_RETRIES, transientBackoff } from "./providers.ts";
import { TZ, log, parseSelector } from "./config.ts";
import { pinnedLimitAlert } from "./accounts-api.ts";
import { firstAlertForReset } from "./rate-alert.ts";
import { report, withHeld, scheduleReport } from "./lanereport.ts";
import { prompt } from "./laneprompt.ts";
import { msg } from "./i18n.ts";
import { type AgentError } from "./runtime/types.ts";
import { failsOver, failureReason, type Move, Chain, atTime, quotaResetAt } from "./fallback.ts";
import { rmSync } from "node:fs";
import { runningSubagents } from "./activity.ts";
import { resumeLane } from "./lanerun.ts";

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
	if ((!lane.pauseReported || lane.pauseKind !== kind) && (owner || firstAlertForReset(`lane:${lane.name}`, Date.now() + wait))) {
		report(lane, owner
			? `모델 제공자 결제/인증 문제로 멈췄어요 (${err.replace(/\s+/g, " ").slice(0, 160)}). 크레딧 충전이나 로그인 확인이 필요해요. 그동안 온 메시지는 모아뒀다가 해결되면 이어서 처리하고, ${Math.round(wait / 60_000)}분마다 다시 시도해요.`
			: pinnedLimitAlert(Date.now() + wait) ?? `사용량 한도에 걸려서 멈췄어요. ${reset ? `한도가 리셋되는 ${at} 직후에` : `${at}쯤부터`} 다시 시도하고, 그동안 온 메시지는 모아뒀다가 이어서 처리해요.`, true);
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
export function handleError(lane: Lane, e: AgentError): void {
	if (lane.chain && failsOver(e.kind) && !(e.kind === "transient" && (lane.transientTries ?? 0) < TRANSIENT_RETRIES)) void failOver(lane, e).then(moved => !moved && legacyError(lane, e));
	else legacyError(lane, e);
}
function legacyError(lane: Lane, e: AgentError): void {
	lane.failing = false;
	if (e.kind === "rate" || e.kind === "owner") void pauseForRateLimit(lane, e.text, e.kind);
	else if (e.kind !== "transient" || !retryTransient(lane, e.text)) {
		lane.lastText = `[lane error] ${(e.text || "model request failed").slice(0, 300)}`;
		lane.unreported = true;
		scheduleReport(lane);
	}
}
// The next entry of a hub-driven chain takes over when the active one fails (a temporary error is retried a few times first).
async function failOver(lane: Lane, e: AgentError): Promise<boolean> {
	const active = lane.chain;
	if (!active) return false;
	const reason = failureReason({ kind: e.kind, text: e.text });
	const until = reason === "quota" ? await quotaResetAt(e.text, active.selector(active.active), "lane") : undefined;
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
	hooks.notice(lane, line);
	clearTimeout(lane.timer);
	rmSync(pendingFile(lane), { force: true });
	lane.revive = { text: again ? msg().laneTransient : undefined };
	lane.proc.kill(true);
	return true;
}
// Switches the lane's process back to its configured model once that is due: before a prompt starts a turn (a refusal, a
// provider error, or a usage limit that has reset), or at an idle moment for a usage limit that has reset. Never mid-turn.
export function settleRevert(lane: Lane, idle: boolean): void {
	if (!lane.proc?.setModel || lane.chain || lane.status === "working" || lane.status === "rate-limited" || (idle && lane.status !== "idle")) return;
	const to = lane.reverter?.take(idle);
	if (!to) return;
	lane.proc.setModel(to);
	lane.activeModel = to;
	const line = msg().modelReverted(parseSelector(to).model);
	log(`lane ${lane.name} ${line}`);
	hooks.notice(lane, line);
}
// At an idle moment: act on a spend cap reached during the turn, or go back to an earlier entry whose limit has reset.
export function settleChain(lane: Lane): void {
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
export function pauseExhausted(lane: Lane, c: Chain, until: number): void {
	setStatus(lane, "rate-limited");
	const at = new Date(until).toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
	const line = msg().fallbackExhausted(c.label(c.active), at);
	log(`lane ${lane.name} ${line}`);
	hooks.notice(lane, line);
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
