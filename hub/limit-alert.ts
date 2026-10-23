// One owner alert per blocked episode (owner 2026-10-23: the same "모델 제공자 결제/인증 문제" alert every ~5 minutes on the
// macmini, one per retry, replay or restart). An episode is (agent, account, kind): agent = "orchestrator" or "lane:<name>",
// kind = auth | billing | limit. The last one told is kept on disk, so a restart or a replay inside the episode says nothing
// new. The alert repeats only when the account or kind changes, or once after REPEAT_MS if it is still blocked; the first
// successful turn ends the episode with one short recovery line. The raw provider error never reaches the owner (hub.log).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";
import { authFile } from "./apikey-policy.ts";
import { OWNER_RETRY_MS, type ProviderErrorKind } from "./providers.ts";

export type LimitKind = "auth" | "billing" | "limit";
export const REPEAT_MS = 12 * 3600_000;
const OWNER_RETRY_MAX_MS = 6 * 3600_000;
export const AUTH_WATCH_MS = 30_000;

type Episode = { account: string; kind: LimitKind; since: number; sentAt: number; failures: number };
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

// Records one blocked turn. `alert` is true when the owner should be told now; `failures` counts the blocked turns of the episode.
export function noteBlock(agent: string, account: string, kind: LimitKind, at = Date.now()): { alert: boolean; failures: number } {
	const all = read();
	const prev = all[agent];
	if (!prev || prev.account !== account || prev.kind !== kind) {
		all[agent] = { account, kind, since: at, sentAt: at, failures: 1 };
		write(all);
		return { alert: true, failures: 1 };
	}
	prev.failures++;
	const repeat = at - prev.sentAt >= REPEAT_MS;
	if (repeat) prev.sentAt = at;
	write(all);
	return { alert: repeat, failures: prev.failures };
}

// A turn succeeded: the episode of `agent` (if any) is over; the caller tells the owner once.
export function noteRecovered(agent: string): Episode | undefined {
	const all = read();
	const prev = all[agent];
	if (!prev) return undefined;
	delete all[agent];
	write(all);
	return prev;
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
