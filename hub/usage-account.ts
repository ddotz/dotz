// The Claude subscription account dotz's agents actually run on, and that account's plan limits ("한도", the lane budget
// gate, the 429 resume time). Under OmO that is OmO's own login (<agent dir>/auth.json "anthropic-subscription": the pinned
// account, else the one OmO's credential pool last used successfully), which can be another account than the omp login
// `omp usage` reads (the owner's default). Other runtimes keep reading omp's report.
//
// Ported from herdr-web-ui server/usage.ts: read only on purpose. A token is never refreshed here (Claude rotates refresh
// tokens, so a refresh OmO did not make would log OmO out); an expired one is reported as "expired" and OmO refreshes it on
// its next request. An account is asked at most every FRESH_MS (a forced read at most every MIN_REFRESH_MS), and one that
// answered 429 is not asked again before its retry-after.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { cfg } from "./config.ts";

export const FRESH_MS = 2 * 60_000;
export const MIN_REFRESH_MS = 30_000;
export const RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export type SubscriptionAccount = { name: string; pinned: boolean; sticky?: boolean; token: string; expiresAt: number | null };
export type AccountProblem = "expired" | "rate_limited" | "failed";
type Limit = { id: string; label: string; window: { id: string; label: string; durationMs: number; resetsAt?: number }; amount: { used: number; limit: number; remaining: number; usedFraction: number; remainingFraction: number; unit: "percent" }; status: string };
// Shaped like one `omp usage --json` report, plus whose numbers they are.
export type AccountReport = { provider: "anthropic"; account: string; via: "omo-pinned" | "omo-sticky" | "omo-pool" | "omp"; limits: Limit[]; fetchedAt?: number; problem?: AccountProblem; retryAt?: number };

type Json = Record<string, any>;
const readJson = (file: string): Json | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

// The runtime that runs a role, as hub/runtime/index.ts runtimeFor decides it (unknown names run OmO); kept here so the
// usage path does not import the adapters (they import providers.ts).
export function runtimeIdOf(role: "orchestrator" | "lane"): string {
	const id = (role === "orchestrator" ? cfg.orchestrator?.runtime : cfg.lanes?.runtime) ?? cfg.runtime ?? "omo";
	return id === "omp" || id === "claude" ? id : "omo";
}

// OmO's subscription account for Anthropic models: the pinned one, else the one dotz keeps its processes on (`prefer`,
// hub/account-sticky.ts), else the pool's pick (not blocked, latest success).
export function subscriptionAccount(file = authFile(), now = Date.now(), prefer?: string): SubscriptionAccount | undefined {
	const sub = readJson(file)?.["anthropic-subscription"];
	const accounts: Json[] = Array.isArray(sub?.accounts) ? sub.accounts.filter((a: Json) => typeof a?.name === "string" && typeof a?.access === "string" && a.access) : [];
	if (!accounts.length) return undefined;
	const pinned = typeof sub.pinned === "string" ? accounts.find(a => a.name === sub.pinned) : undefined;
	const slots: Json = readJson(join(dirname(file), "credential-pool-state.json"))?.providers?.["anthropic-subscription"]?.lanes?.stored?.slots ?? {};
	const usable = (a: Json) => !slots[a.name]?.blockReason || (typeof slots[a.name].blockedUntil === "number" && slots[a.name].blockedUntil <= now);
	const last = (a: Json) => Number(slots[a.name]?.lastSuccessAt ?? 0);
	const sticky = pinned ? undefined : accounts.find(a => a.name === prefer);
	const chosen = pinned ?? sticky ?? [...accounts].sort((a, b) => Number(usable(b)) - Number(usable(a)) || last(b) - last(a))[0];
	return { name: chosen.name, pinned: Boolean(pinned), ...(sticky ? { sticky: true } : {}), token: chosen.access, expiresAt: typeof chosen.expires === "number" ? chosen.expires : null };
}

// Every subscription account OmO holds, for the per-account usage numbers the owner's rules read (hub/account-rules.ts).
export function subscriptionAccounts(file = authFile()): SubscriptionAccount[] {
	const sub = readJson(file)?.["anthropic-subscription"];
	const accounts: Json[] = Array.isArray(sub?.accounts) ? sub.accounts.filter((a: Json) => typeof a?.name === "string" && typeof a?.access === "string" && a.access) : [];
	return accounts.map(a => ({ name: a.name, pinned: sub.pinned === a.name, token: a.access, expiresAt: typeof a.expires === "number" ? a.expires : null }));
}

const WINDOWS: [key: string, id: string, label: string, windowId: string, durationMs: number][] = [
	["five_hour", "anthropic:5h", "Claude 5 Hour", "5h", 5 * 3600_000],
	["seven_day", "anthropic:7d", "Claude 7 Day", "7d", 7 * 86400_000],
	["seven_day_opus", "anthropic:7d:opus", "Claude 7 Day (Opus)", "7d", 7 * 86400_000],
	["seven_day_sonnet", "anthropic:7d:sonnet", "Claude 7 Day (Sonnet)", "7d", 7 * 86400_000],
];

// Pure: the oauth/usage answer as omp-shaped limits (percent of the window used).
export function limitsOf(body: Json): Limit[] {
	return WINDOWS.flatMap(([key, id, label, windowId, durationMs]): Limit[] => {
		const w = body?.[key];
		const used = typeof w?.utilization === "number" && Number.isFinite(w.utilization) ? Math.round(Math.min(100, Math.max(0, w.utilization)) * 10) / 10 : undefined;
		if (used === undefined) return [];
		const resetsAt = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : Number.NaN;
		const remaining = Math.round((100 - used) * 10) / 10;
		return [{ id, label, window: { id: windowId, label: windowId === "5h" ? "5 Hour" : "7 Day", durationMs, ...(Number.isNaN(resetsAt) ? {} : { resetsAt }) }, amount: { used, limit: 100, remaining, usedFraction: used / 100, remainingFraction: remaining / 100, unit: "percent" }, status: used >= 100 ? "exhausted" : "ok" }];
	});
}

// Pure: omp's Anthropic report (runtimes other than OmO run on omp's login) in the same shape, named by its email.
export function fromOmp(r: { limits?: Json[]; metadata?: { email?: string } }): AccountReport {
	const limits = (r.limits ?? []).flatMap((l): Limit[] => {
		const used = l?.amount?.used;
		if (typeof used !== "number") return [];
		const remaining = typeof l.amount.remaining === "number" ? l.amount.remaining : 100 - used;
		const w = l.window ?? {};
		return [{ id: String(l.id), label: String(l.label ?? l.id), window: { id: String(w.id ?? ""), label: String(w.label ?? ""), durationMs: Number(w.durationMs ?? 0), ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt } : {}) }, amount: { used, limit: typeof l.amount.limit === "number" ? l.amount.limit : 100, remaining, usedFraction: used / 100, remainingFraction: remaining / 100, unit: "percent" }, status: String(l.status ?? "unknown") }];
	});
	return { provider: "anthropic", account: r.metadata?.email ?? "omp login", via: "omp", limits };
}

const retryAfterMs = (header: string | null, now: number): number | undefined => {
	if (!header) return undefined;
	const s = Number(header);
	if (Number.isFinite(s)) return Math.max(0, s * 1000);
	const at = Date.parse(header);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

export class AccountUsage {
	private last = new Map<string, { report: AccountReport; at: number; next: number }>();
	// per account: when it may be asked again after a 429
	private backoff = new Map<string, number>();
	constructor(private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i), private readonly now: () => number = Date.now) {}

	async report(acct: SubscriptionAccount, force = false): Promise<AccountReport> {
		const t = this.now();
		const held = this.last.get(acct.name);
		if (held && t < held.next && !(force && t - held.at >= MIN_REFRESH_MS && held.report.problem !== "rate_limited")) return held.report;
		const via = acct.pinned ? "omo-pinned" : acct.sticky ? "omo-sticky" : "omo-pool";
		// the last numbers stay, marked with what went wrong since
		const keep = (problem: AccountProblem, wait: number, retryAt?: number): AccountReport => this.settle(acct.name, { provider: "anthropic", account: acct.name, via, limits: held?.report.limits ?? [], ...(held?.report.fetchedAt ? { fetchedAt: held.report.fetchedAt } : {}), problem, ...(retryAt ? { retryAt } : {}) }, t, wait);
		if (acct.expiresAt !== null && acct.expiresAt <= t) return keep("expired", RETRY_MS);
		const until = this.backoff.get(acct.name);
		if (until !== undefined && t < until) return keep("rate_limited", until - t, until);
		this.backoff.delete(acct.name);
		try {
			const res = await this.fetchFn(USAGE_URL, { headers: { authorization: `Bearer ${acct.token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20", "user-agent": "dotz" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
			if (res.status === 401 || res.status === 403) return keep("expired", RETRY_MS);
			if (res.status === 429) {
				const wait = Math.max(RETRY_MS, retryAfterMs(res.headers.get("retry-after"), t) ?? FRESH_MS);
				this.backoff.set(acct.name, t + wait);
				return keep("rate_limited", wait, t + wait);
			}
			if (!res.ok) return keep("failed", RETRY_MS);
			return this.settle(acct.name, { provider: "anthropic", account: acct.name, via, limits: limitsOf(await res.json()), fetchedAt: t }, t, FRESH_MS);
		} catch {
			return keep("failed", RETRY_MS);
		}
	}

	private settle(name: string, report: AccountReport, at: number, wait: number): AccountReport {
		this.last.set(name, { report, at, next: at + wait });
		return report;
	}
}

const span = (ms: number): string => {
	const m = Math.max(0, Math.round(ms / 60_000));
	const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
	return d ? `${d}d${h}h` : h ? `${h}h${mm}m` : `${mm}m`;
};
const VIA: Record<AccountReport["via"], string> = { "omo-pinned": "OmO 고정 계정", "omo-sticky": "dotz가 유지하는 계정", "omo-pool": "OmO 계정 풀", omp: "omp 로그인" };
const PROBLEM: Record<AccountProblem, string> = { expired: "토큰 만료 - OmO가 다음 요청 때 갱신해요", rate_limited: "사용량 조회가 429로 막힘", failed: "사용량 조회 실패" };

// Pure: the "한도" answer, naming whose limits these are. `labelOf` maps the raw account id to the owner's alias; the raw id
// then goes on a separate "-# " detail line (only when it differs from the label).
export function limitsText(r: AccountReport, now: number, labelOf: (name: string) => string = n => n): string {
	const name = labelOf(r.account);
	const head = [`계정: ${name} (${VIA[r.via]})`, ...(name !== r.account ? [`-# 계정 id: ${r.account}`] : [])].join("\n");
	const note = r.problem ? `${PROBLEM[r.problem]}${r.retryAt ? ` · ${span(r.retryAt - now)} 뒤 다시 조회` : ""}${r.limits.length && r.fetchedAt ? ` · 아래는 ${span(now - r.fetchedAt)} 전 값` : ""}` : undefined;
	const lines = r.limits.map(l => `${l.label.padEnd(22)}${l.amount.used.toFixed(1)}% used${l.window.resetsAt ? ` · resets in ${span(l.window.resetsAt - now)}` : ""}`);
	return [head, ...(note ? [note] : []), ...(lines.length ? ["```", ...lines, "```"] : r.problem ? [] : ["(한도 정보 없음)"])].join("\n");
}
