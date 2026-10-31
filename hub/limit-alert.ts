// One owner alert per blocked episode (owner 2026-10-23: the same "모델 제공자 결제/인증 문제" alert every ~5 minutes on the
// macmini, one per retry, replay or restart; 2026-10-26: still a new one every 12 hours and one per session for the same cause). An episode
// is one kind (auth | billing | limit) shared by every agent ("orchestrator", "lane:<name>"): the first blocked agent tells the owner once,
// the others and every retry, replay or restart (the record is on disk) stay quiet, also when the error names the account differently.
// A new alert comes only with a different kind; the first successful turn ends the episode for every agent with one short recovery line.
// The raw provider error never reaches the owner (hub.log).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";
import { authFile } from "./apikey-policy.ts";
import { OWNER_RETRY_MS, type ProviderErrorKind } from "./providers.ts";

export type LimitKind = "auth" | "billing" | "limit" | "error";
const OWNER_RETRY_MAX_MS = 6 * 3600_000;
export const AUTH_WATCH_MS = 30_000;

// told: the owner was alerted about this episode (false while an error ask is held, hub/orch-error.ts errorAskHold); a missing
// field (records written before it) counts as told.
type Episode = { account: string; kind: LimitKind; since: number; sentAt: number; failures: number; told?: boolean };
export const limitAlertsFile = () => join(DATA_DIR, "limit-alerts.json");
const read = (): Record<string, Episode> => {
	try {
		return JSON.parse(readFileSync(limitAlertsFile(), "utf8"));
	} catch {
		return {};
	}
};
const write = (all: Record<string, Episode>) => writeAtomic(limitAlertsFile(), `${JSON.stringify(all)}\n`);

const BILLING_RE = /credit balance|insufficient[_ ]?(?:quota|funds|credits?)|out of credits|requires more credits|billing|payment required|\b402\b|exceeded your current quota/i;
export const limitKind = (err: string, kind: ProviderErrorKind): LimitKind => (kind === "rate" ? "limit" : BILLING_RE.test(err) ? "billing" : "auth");

// The account the error names ("Claude account 'imported-anthropic' ... is blocked"), else the provider of the model.
export function limitAccount(err: string, model: string): string {
	const named = err.match(/account\s+['"]([^'"]+)['"]/i)?.[1];
	return named ?? (model.split("/")[0] || "unknown");
}
export const providerOf = (model: string): string => model.split("/")[0] || "anthropic";

// Records one blocked turn. `alert` is true when the owner should be told; `failures` counts the blocked turns of this agent.
// `hold`: the caller tells the owner later, or not at all when the episode ends first (markTold records the actual send).
// An episode not told yet alerts again (a held ask lost to a gateway restart); `since` is when the episode began.
export function noteBlock(agent: string, account: string, kind: LimitKind, at = Date.now(), hold = false): { alert: boolean; failures: number; since: number } {
	const all = read();
	const prev = all[agent];
	// One stoppage is one alert until a turn succeeds, even when its cause shows up differently on the way (a limit, then a login
	// error, then a network error after a manual resume): the owner was told it stopped, and the recovery line says when it is back.
	if (prev) {
		if (prev.kind !== kind) prev.failures = 0;
		prev.failures++;
		prev.kind = kind;
		prev.account = account;
		const alert = prev.told === false;
		if (alert && !hold) prev.told = true;
		write(all);
		return { alert, failures: prev.failures, since: prev.since };
	}
	const told = Object.entries(all).some(([a, e]) => a !== agent && e.kind === kind && e.told !== false);
	all[agent] = { account, kind, since: at, sentAt: at, failures: 1, told: !hold };   // told by another agent's alert counts as told
	write(all);
	return { alert: !told, failures: 1, since: at };
}

// A held alert of this agent's episode was sent now.
export function markTold(agent: string, at = Date.now()): void {
	const all = read();
	const e = all[agent];
	if (!e) return;
	e.told = true;
	e.sentAt = at;
	write(all);
}

// A turn succeeded: the episode is over for every agent blocked the same way (they share the cause); the caller tells the owner once.
// Returns the episode only when the owner was told about it: a recovery line without its alert is noise (owner 2026-10-29).
export function noteRecovered(agent: string): Episode | undefined {
	const all = read();
	const prev = all[agent];
	if (!prev) return undefined;
	let told = false;
	for (const [a, e] of Object.entries(all)) if (e.kind === prev.kind) {
		told ||= e.told !== false;
		delete all[a];
	}
	write(all);
	return told ? prev : undefined;
}

// A billing/auth block waits for the owner, so its probe backs off: 30 min, 1 h, 2 h ... up to 6 h (a held prompt retried
// every 30 minutes forever would keep failing for nothing). A changed login retries at once (watchAuth).
export const ownerRetryMs = (failures: number): number => Math.min(OWNER_RETRY_MS * 2 ** Math.max(0, failures - 1), Math.max(OWNER_RETRY_MS, OWNER_RETRY_MAX_MS));

// The login store changes when the owner logs in again; its mtime is the signal (0 when the file does not exist).
export function authStamp(): number {
	try {
		return statSync(authFile()).mtimeMs;
	} catch {
		return 0;
	}
}
// Calls onChange once when the login store changes while `alive()` holds; stops itself when `alive()` turns false.
export function watchAuth(since: number, alive: () => boolean, onChange: () => void): void {
	const w = setInterval(() => {
		if (!alive()) return clearInterval(w);
		if (authStamp() === since) return;
		clearInterval(w);
		onChange();
	}, AUTH_WATCH_MS);
}

const hoursText = (ms: number) => (ms >= 3600_000 ? `${Math.round(ms / 360_000) / 10}시간` : `${Math.round(ms / 60_000)}분`);
// Plain Korean for the owner: what stopped, which account, what to do, when it retries.
export function blockText(kind: "auth" | "billing", account: string, provider: string, retryMs: number): string {
	const wait = `${hoursText(retryMs)} 뒤에 조용히 다시 시도해요 (로그인 정보가 바뀌면 바로). 같은 문제로는 다시 알리지 않아요.`;
	const held = "그동안 온 메시지는 모아뒀다가 해결되면 순서대로 처리해요.";
	if (kind === "billing") return `모델 제공자 결제(크레딧) 문제로 멈췄어요. 계정: ${account}. ${provider} 사이트에서 크레딧을 충전해 주세요. ${held} ${wait}`;
	return `모델 제공자 로그인이 풀려서 멈췄어요. 계정: ${account}. 이 게이트웨이를 돌리는 컴퓨터에서 /login ${provider} 를 실행해 주세요. ${held} ${wait}`;
}
export const recoveryText = (): string => "모델 제공자가 다시 연결됐어요. 멈춰 있던 일을 이어서 처리해요.";
