// The Claude subscription account dotz's agents actually run on, and that account's plan limits ("한도", the lane budget
// gate, the 429 resume time). Under OmO that is OmO's own login (<agent dir>/auth.json "anthropic-subscription": the pinned
// account, else the one OmO's credential pool last used successfully), which can be another account than the omp login
// `omp usage` reads (the owner's default). Other runtimes keep reading omp's report.
//
// Ported from herdr-web-ui server/usage.ts: read only on purpose. A token is never refreshed here (Claude rotates refresh
// tokens, so a refresh OmO did not make would log OmO out); an expired one is reported as "expired" and OmO refreshes it on
// its next request. An account is asked at most every FRESH_MS (a forced read at most every MIN_REFRESH_MS), and one that
// answered 429 is not asked again before its retry-after.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { cfg } from "./config.ts";

const FRESH_MS = 2 * 60_000;
export const MIN_REFRESH_MS = 30_000;
const RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

type SubscriptionAccount = { name: string; pinned: boolean; sticky?: boolean; token: string; expiresAt: number | null; plan?: string };
type AccountProblem = "expired" | "rate_limited" | "failed";
type Limit = { id: string; label: string; window: { id: string; label: string; durationMs: number; resetsAt?: number }; amount: { used: number; limit: number; remaining: number; usedFraction: number; remainingFraction: number; unit: "percent" }; status: string; scope?: string; active?: boolean };
// One limit as GET /api/quota carries it (hub/providers.ts buildQuota, hub/codex-usage.ts).
export type QuotaLimit = { id: string; label: string; window: string; used: number | null; limit: number | null; remaining: number | null; unit: string; resets_at: number | null; status: string; scope?: string; active?: boolean };
// Shaped like one `omp usage --json` report, plus whose numbers they are.
export type AccountReport = { provider: "anthropic"; account: string; via: "omo-pinned" | "omo-sticky" | "omo-pool" | "omp"; limits: Limit[]; fetchedAt?: number; problem?: AccountProblem; retryAt?: number; plan?: string; resets?: ClaudeResets };
// The account's 리셋권 (Anthropic's "limit reset", program cedar_ember): how many are left, by kind (주간, Fable), the nearest expiry,
// and the grant a use spends (next_grant_id, else the usable one that expires first). usable: a grant applies now and the account's
// organization id is known locally (the use call needs it, and dotz makes no extra request to learn it).
// One kind's share: its count, nearest expiry, whether one of its grants can be spent now, and the grant 사용 spends for it.
export type ClaudeResetKind = { kind: string; left: number; expires_at: number | null; usable: boolean; grant_id?: string };
export type ClaudeResets = { held: number; usable: boolean; expires_at: number | null; kinds: ClaudeResetKind[]; grant?: { id: string; kind: string } };

type Json = Record<string, any>;
const readJson = (file: string): Json | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

// OmO 2026.10.31+ logins (store "claude-cli") keep no token in auth.json: the Claude CLI holds it for the account's own dir
// <agent dir>/anthropic-subscription-claude/<dirId>, in the macOS keychain item "Claude Code-credentials-<first 8 hex of
// sha256(dir)>" or, elsewhere, <dir>/.credentials.json. Read only, like the rest of this file; cached a minute per dir
// (an expired token is looked at again after EXPIRED_RECHECK_MS, not on every call). The keychain is read by a `security`
// child that never runs on the caller's path: a stale entry is answered from the cache while one read per dir runs in the
// background (a synchronous read blocked the gateway's event loop, and an expired token re-ran it on every call).
const CLI_TOKEN_TTL_MS = 60_000;
const EXPIRED_RECHECK_MS = 15_000;
type CliCred = { access: string; expires?: number; subscriptionType?: string; rateLimitTier?: string };
const cliTokens = new Map<string, { at: number; cred?: CliCred }>();
const keychainReads = new Map<string, Promise<void>>();
const securityRead = (service: string): Promise<string | undefined> =>
	new Promise(done => execFile("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", timeout: 5_000 }, (err, out) => done(err ? undefined : out)));
let keychainRead = securityRead;
export const setKeychainReaderForTest = (fn: (service: string) => Promise<string | undefined>) => void (keychainRead = fn);
export const resetCliTokensForTest = () => {
	cliTokens.clear();
	keychainReads.clear();
	keychainRead = securityRead;
};
// Resolves when the keychain reads started so far are done (the background usage refresh waits for them, never a request).
export const cliTokensSettled = async (): Promise<void> => void (await Promise.all(keychainReads.values()));
const parseCred = (raw: string | undefined): CliCred | undefined => {
	try {
		const o = JSON.parse(raw ?? "")?.claudeAiOauth;
		if (typeof o?.accessToken === "string" && o.accessToken)
			return { access: o.accessToken, ...(typeof o.expiresAt === "number" ? { expires: o.expiresAt } : {}), ...(typeof o.subscriptionType === "string" ? { subscriptionType: o.subscriptionType } : {}), ...(typeof o.rateLimitTier === "string" ? { rateLimitTier: o.rateLimitTier } : {}) };
	} catch {}
	return undefined;
};
function cliCredential(file: string, dirId: unknown, now: number): CliCred | undefined {
	if (typeof dirId !== "string" || !/^[0-9a-f]{32}$/.test(dirId)) return undefined;
	const dir = join(dirname(file), "anthropic-subscription-claude", dirId);
	const hit = cliTokens.get(dir);
	const age = hit ? now - hit.at : Number.POSITIVE_INFINITY;
	if (hit && age < CLI_TOKEN_TTL_MS && !((hit.cred?.expires ?? Number.POSITIVE_INFINITY) <= now && age >= EXPIRED_RECHECK_MS)) return hit.cred;
	let raw: string | undefined;
	try {
		raw = readFileSync(join(dir, ".credentials.json"), "utf8");
	} catch {
		if (process.platform === "darwin") {
			if (!keychainReads.has(dir)) {
				const service = `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
				const read = keychainRead(service)
					.catch(() => undefined)
					.then(out => void cliTokens.set(dir, { at: Date.now(), cred: parseCred(out) }))
					.finally(() => keychainReads.delete(dir));
				keychainReads.set(dir, read);
			}
			return hit?.cred;
		}
	}
	const cred = parseCred(raw);
	cliTokens.set(dir, { at: now, cred });
	return cred;
}
// The subscription accounts OmO lists, each with the token its usage is read with (accounts with none are left out).
function tokenAccounts(file: string, now: number): { sub: Json | undefined; accounts: Json[] } {
	const sub = readJson(file)?.["anthropic-subscription"];
	const accounts: Json[] = (Array.isArray(sub?.accounts) ? sub.accounts : []).flatMap((a: Json) => {
		if (typeof a?.name !== "string") return [];
		if (typeof a.access === "string" && a.access) return [a];
		if (a.store !== "claude-cli" || a.signInRequired) return [];
		const cred = cliCredential(file, a.dirId, now);
		return cred ? [{ ...a, access: cred.access, expires: cred.expires, subscriptionType: cred.subscriptionType, rateLimitTier: cred.rateLimitTier }] : [];
	});
	return { sub, accounts };
}

// Pure: the plan an account is on, as Anthropic names it. `shown` is the name `claude auth status` printed when OmO signed the
// account in (auth.json profile.subscriptionType: "Claude " + the server's plan display name, e.g. "Claude Ultra", or the CLI's own
// "Claude Max"/"Claude Pro"); without it the CLI credential's subscriptionType ("pro", "max", ...) is named. A bare Max is told
// apart by the credential's rateLimitTier (default_claude_max_5x / _20x). An unknown value is shown as it is, never guessed.
const PLAN: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };
export function planName(shown: unknown, type: unknown, tier: unknown): string | undefined {
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const t = str(type);
	const name = str(shown)?.replace(/^Claude\s+/i, "") || (t ? (PLAN[t.toLowerCase()] ?? t) : undefined);
	const x = str(tier)?.match(/_max_(\d+)x$/i)?.[1];
	return name === "Max" && x ? `Max ${x}x` : name;
}
const planOf = (a: Json): string | undefined => planName(a.profile?.subscriptionType, a.subscriptionType, a.rateLimitTier);

// The runtime that runs a role, as hub/runtime/index.ts runtimeFor decides it (unknown names run OmO); kept here so the
// usage path does not import the adapters (they import providers.ts).
export function runtimeIdOf(role: "orchestrator" | "lane"): string {
	const id = (role === "orchestrator" ? cfg.orchestrator?.runtime : cfg.lanes?.runtime) ?? cfg.runtime ?? "omo";
	return id === "omp" || id === "claude" ? id : "omo";
}

// Whether OmO skips an account now, and until when. OmO records a block in two places: on the account entry in auth.json
// (blockedUntil/blockReason, which its account selection reads: isAccountBlocked) and in credential-pool-state.json (a slot).
// Reading only the pool state missed a block that exists only in auth.json, so dotz showed and pinned an account OmO then
// skipped (2026-10-22: default blocked until 16:00Z, shown as the connected account while requests ran on teammate-shared).
// Both are honoured; a block without an expiry (an auth block) lasts until the owner logs in again.
export function blockOf(account: Json | undefined, slot: Json | undefined, now: number): { until?: number; reason: string } | undefined {
	const found: { until?: number; reason: string }[] = [];
	if (slot?.blockReason) {
		const until = typeof slot.blockedUntil === "number" ? slot.blockedUntil : undefined;
		if (until === undefined || until > now) found.push({ ...(until !== undefined ? { until } : {}), reason: String(slot.blockReason) });
	}
	if (typeof account?.blockedUntil === "number" && account.blockedUntil > now) found.push({ until: account.blockedUntil, reason: String(account.blockReason ?? "rate_limit") });
	return found.sort((a, b) => (b.until ?? Number.POSITIVE_INFINITY) - (a.until ?? Number.POSITIVE_INFINITY))[0];
}

// The account requests really go to. OmO skips a blocked account, so the chosen one (dotz's pick, or the pin) is used only
// while it is not blocked; otherwise the pool's pick is: not blocked, latest success. With nothing usable the chosen one stays.
export function usedAccount(chosen: string | undefined, names: string[], isBlocked: (name: string) => boolean, lastSuccess: (name: string) => number): string | undefined {
	if (chosen && names.includes(chosen) && !isBlocked(chosen)) return chosen;
	return [...names].filter(n => !isBlocked(n)).sort((a, b) => lastSuccess(b) - lastSuccess(a))[0] ?? chosen ?? names[0];
}

// OmO's subscription account for Anthropic models: the one dotz keeps its processes on (`prefer`, hub/account-sticky.ts: a
// manual pick, a rule or the owner's pin all end up there, and its processes get it as their soft pin), else the pinned one,
// else the pool's pick (not blocked, latest success). `prefer` wins over auth.json's pin, or a manual switch would keep
// showing the pinned account's numbers.
// hard: the owner's 고정 mode, where requests stay on `prefer` even while it is blocked.
export function subscriptionAccount(file = authFile(), now = Date.now(), prefer?: string, hard = false): SubscriptionAccount | undefined {
	const { sub, accounts } = tokenAccounts(file, now);
	if (!accounts.length) return undefined;
	const pin = typeof sub.pinned === "string" ? accounts.find(a => a.name === sub.pinned) : undefined;
	const slots: Json = readJson(join(dirname(file), "credential-pool-state.json"))?.providers?.["anthropic-subscription"]?.lanes?.stored?.slots ?? {};
	const usable = (a: Json) => !blockOf(a, slots[a.name], now);
	const last = (a: Json) => Number(slots[a.name]?.lastSuccessAt ?? 0);
	const preferred = accounts.find(a => a.name === prefer);
	const wanted = preferred ?? pin ?? [...accounts].sort((a, b) => Number(usable(b)) - Number(usable(a)) || last(b) - last(a))[0];
	// a blocked pick is skipped by OmO, so the numbers are those of the account it really falls back to
	const usedName = hard && preferred ? preferred.name : usedAccount(wanted.name, accounts.map(a => a.name), n => !usable(accounts.find(a => a.name === n)!), n => last(accounts.find(a => a.name === n)!));
	const chosen = accounts.find(a => a.name === usedName) ?? wanted;
	const pinned = chosen === pin;
	const plan = planOf(chosen);
	return { name: chosen.name, pinned, ...(preferred && chosen === preferred && !pinned ? { sticky: true } : {}), token: chosen.access, expiresAt: typeof chosen.expires === "number" ? chosen.expires : null, ...(plan ? { plan } : {}) };
}

// Every subscription account OmO holds, for the per-account usage numbers the owner's rules read (hub/account-rules.ts).
export function subscriptionAccounts(file = authFile()): SubscriptionAccount[] {
	const { sub, accounts } = tokenAccounts(file, Date.now());
	return accounts.map(a => {
		const plan = planOf(a);
		return { name: a.name, pinned: sub?.pinned === a.name, token: a.access, expiresAt: typeof a.expires === "number" ? a.expires : null, ...(plan ? { plan } : {}) };
	});
}

const WINDOWS: [key: string, id: string, label: string, windowId: string, durationMs: number][] = [
	["five_hour", "anthropic:5h", "Claude 5 Hour", "5h", 5 * 3600_000],
	["seven_day", "anthropic:7d", "Claude 7 Day", "7d", 7 * 86400_000],
	["seven_day_opus", "anthropic:7d:opus", "Claude 7 Day (Opus)", "7d", 7 * 86400_000],
	["seven_day_sonnet", "anthropic:7d:sonnet", "Claude 7 Day (Sonnet)", "7d", 7 * 86400_000],
];

// Pure: the oauth/usage answer as omp-shaped limits (percent of the window used).
export function limitsOf(body: Json): Limit[] {
	const main = WINDOWS.flatMap(([key, id, label, windowId, durationMs]): Limit[] => {
		const w = body?.[key];
		const used = typeof w?.utilization === "number" && Number.isFinite(w.utilization) ? Math.round(Math.min(100, Math.max(0, w.utilization)) * 10) / 10 : undefined;
		if (used === undefined) return [];
		const resetsAt = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : Number.NaN;
		const remaining = Math.round((100 - used) * 10) / 10;
		return [{ id, label, window: { id: windowId, label: windowId === "5h" ? "5 Hour" : "7 Day", durationMs, ...(Number.isNaN(resetsAt) ? {} : { resetsAt }) }, amount: { used, limit: 100, remaining, usedFraction: used / 100, remainingFraction: remaining / 100, unit: "percent" }, status: used >= 100 ? "exhausted" : "ok" }];
	});
	// limits[] kind "weekly_scoped": a window of its own for one model or surface (the name the entry carries). scope + active mark it
	// so nothing reads it as the weekly or the 5-hour window; active is the API's is_active, passed on unread.
	const scoped = (Array.isArray(body?.limits) ? body.limits : []).flatMap((e: Json): Limit[] => {
		const scope = e?.scope?.model?.display_name ?? e?.scope?.surface?.display_name;
		if (e?.kind !== "weekly_scoped" || typeof scope !== "string" || !scope || typeof e.percent !== "number" || !Number.isFinite(e.percent)) return [];
		const used = Math.round(Math.min(100, Math.max(0, e.percent)) * 10) / 10;
		const resetsAt = typeof e.resets_at === "string" ? Date.parse(e.resets_at) : Number.NaN;
		const remaining = Math.round((100 - used) * 10) / 10;
		const durationMs = 7 * 86400_000;
		return [{ id: `anthropic:7d:${scope.toLowerCase()}`, label: `Claude 7 Day (${scope})`, window: { id: "7d", label: "7 Day", durationMs, ...(Number.isNaN(resetsAt) ? {} : { resetsAt }) }, amount: { used, limit: 100, remaining, usedFraction: used / 100, remainingFraction: remaining / 100, unit: "percent" }, status: used >= 100 ? "exhausted" : "ok", scope, ...(typeof e.is_active === "boolean" ? { active: e.is_active } : {}) }];
	});
	const at = main.findIndex(l => l.id === "anthropic:7d") + 1;
	return at ? [...main.slice(0, at), ...scoped, ...main.slice(at)] : [...main, ...scoped];
}

// The usage read. cedar_ember=1 adds the 리셋권 (null without it); the server lists them only to a Claude Code user-agent (with
// dotz's own it answers ineligible_reason "surface"), so this GET, and the reset POST (hub/claude-reset.ts), name the installed Claude Code version, else a known one.
let cliUa: string | undefined;
export function claudeCliUa(): string {
	if (cliUa) return cliUa;
	let v = "2.1.316";
	try {
		const found = readdirSync(join(homedir(), ".local", "share", "claude", "versions")).filter(n => /^\d+\.\d+\.\d+$/.test(n));
		const num = (s: string) => s.split(".").map(Number);
		found.sort((a, b) => { const x = num(a), y = num(b); return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!; });
		v = found.at(-1) ?? v;
	} catch {
		// no Claude Code install on this machine: the known version stays
	}
	return (cliUa = `claude-cli/${v} (external, cli)`);
}
export const CLAUDE_USAGE_URL = `${USAGE_URL}?cedar_ember=1&skip_spend=1`;
export const claudeUsageGet = (fetchFn: (url: string, init: RequestInit) => Promise<Response>, token: string): Promise<Response> =>
	fetchFn(CLAUDE_USAGE_URL, { headers: { authorization: `Bearer ${token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20", "user-agent": claudeCliUa(), "x-app": "cli" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

// Pure: the grants with a reset left, nearest expiry first. A grant named Fable is "Fable", a weekly one "주간", one that clears
// the 5-hour window too (type "full") "전체"; any other kind keeps "기타".
const msOf = (v: unknown): number | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
export function claudeGrants(body: Json): { id: string; kind: string; left: number; expires: number | null; now: boolean }[] {
	const list: Json[] = Array.isArray(body?.cedar_ember?.grants) ? body.cedar_ember.grants : [];
	return list
		.filter(g => typeof g?.id === "string" && Number(g.resets_left) > 0)
		.map(g => ({
			id: g.id as string,
			kind: /fable/i.test(`${g.id} ${g.label ?? ""}`) ? "Fable" : g.type === "weekly" || /weekly/i.test(String(g.label ?? "")) ? "주간" : g.type === "full" || (Array.isArray(g.clears) && g.clears.includes("five_hour")) ? "전체" : "기타",
			left: Math.floor(Number(g.resets_left)),
			expires: msOf(g.ends_at),
			now: g.usable_now !== false && g.paused !== true,
		}))
		.sort((a, b) => (a.expires ?? Number.MAX_SAFE_INTEGER) - (b.expires ?? Number.MAX_SAFE_INTEGER));
}
// Pure: the 리셋권 in one usage answer. Undefined when the answer has none to show: no cedar_ember (null) or ineligible with no grants.
export function claudeResets(body: Json, canUse: () => boolean): ClaudeResets | undefined {
	const c = body?.cedar_ember;
	if (!c || typeof c !== "object") return undefined;
	const grants = claudeGrants(body);
	if (!grants.length && c.eligible === false) return undefined;
	const ready = c.eligible === false ? [] : grants.filter(g => g.now);
	const next = ready.find(g => g.id === c.next_grant_id) ?? ready[0];
	const kinds: ClaudeResetKind[] = [];
	for (const g of grants) {
		const k = kinds.find(x => x.kind === g.kind);
		if (k) { k.left += g.left; continue; }
		const mine = ready.filter(x => x.kind === g.kind), pick = next?.kind === g.kind ? next : mine[0];
		kinds.push({ kind: g.kind, left: g.left, expires_at: g.expires, usable: !!pick && canUse(), ...(pick ? { grant_id: pick.id } : {}) });
	}
	return { held: grants.reduce((n, g) => n + g.left, 0), usable: !!next && canUse(), expires_at: grants[0]?.expires ?? null, kinds, ...(next ? { grant: { id: next.id, kind: next.kind } } : {}) };
}
// The organization id an OmO account's reset call goes to: its Claude CLI dir's .claude.json (oauthAccount.organizationUuid), read
// locally. An account without that dir (a token kept in auth.json) has none, and its 리셋권 are shown only.
export function claudeOrg(name: string, file = authFile()): string | undefined {
	const a = (readJson(file)?.["anthropic-subscription"]?.accounts ?? []).find((x: Json) => x?.name === name);
	if (typeof a?.dirId !== "string" || !/^[0-9a-f]{32}$/.test(a.dirId)) return undefined;
	const org = readJson(join(dirname(file), "anthropic-subscription-claude", a.dirId, ".claude.json"))?.oauthAccount?.organizationUuid;
	return typeof org === "string" && /^[0-9a-f-]{36}$/i.test(org) ? org : undefined;
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

	// A switch to this account: its next read goes to the usage endpoint at once, not after the 2-minute hold.
	forget(name: string): void {
		this.last.delete(name);
	}

	async report(acct: SubscriptionAccount, force = false): Promise<AccountReport> {
		const t = this.now();
		const held = this.last.get(acct.name);
		if (held && t < held.next && !(force && t - held.at >= MIN_REFRESH_MS && held.report.problem !== "rate_limited")) return held.report;
		const via = acct.pinned ? "omo-pinned" : acct.sticky ? "omo-sticky" : "omo-pool";
		const plan = acct.plan ? { plan: acct.plan } : {};
		// the last numbers stay, marked with what went wrong since
		const keep = (problem: AccountProblem, wait: number, retryAt?: number): AccountReport => this.settle(acct.name, { provider: "anthropic", account: acct.name, via, ...plan, limits: held?.report.limits ?? [], ...(held?.report.fetchedAt ? { fetchedAt: held.report.fetchedAt } : {}), problem, ...(retryAt ? { retryAt } : {}) }, t, wait);
		if (acct.expiresAt !== null && acct.expiresAt <= t) return keep("expired", RETRY_MS);
		const until = this.backoff.get(acct.name);
		if (until !== undefined && t < until) return keep("rate_limited", until - t, until);
		this.backoff.delete(acct.name);
		try {
			const res = await claudeUsageGet(this.fetchFn, acct.token);
			if (res.status === 401 || res.status === 403) return keep("expired", RETRY_MS);
			if (res.status === 429) {
				const wait = Math.max(RETRY_MS, retryAfterMs(res.headers.get("retry-after"), t) ?? FRESH_MS);
				this.backoff.set(acct.name, t + wait);
				return keep("rate_limited", wait, t + wait);
			}
			if (!res.ok) return keep("failed", RETRY_MS);
			const body = await res.json();
			const resets = claudeResets(body, () => !!claudeOrg(acct.name));
			return this.settle(acct.name, { provider: "anthropic", account: acct.name, via, ...plan, limits: limitsOf(body), fetchedAt: t, ...(resets ? { resets } : {}) }, t, FRESH_MS);
		} catch {
			return keep("failed", RETRY_MS);
		}
	}

	private settle(name: string, report: AccountReport, at: number, wait: number): AccountReport {
		this.last.set(name, { report, at, next: at + wait });
		return report;
	}
}

// A length of time rounded down to its two largest units, as the web usage screen shows it (web/js/01-core.js leftText):
// 6일 23시간 59분 reads 6일 23시간, never 7일; then 3시간 12분, then 59분. Under a minute is "1분 미만".
const span = (ms: number): string => {
	const m = Math.floor(ms / 60_000);
	if (m < 1) return "1분 미만";
	const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
	return d ? `${d}일${h ? ` ${h}시간` : ""}` : h ? `${h}시간${mm ? ` ${mm}분` : ""}` : `${mm}분`;
};
const resetIn = (ms: number): string => (ms <= 0 ? "초기화 중" : `${span(ms)} 뒤 초기화`);
const VIA: Record<AccountReport["via"], string> = { "omo-pinned": "OmO 고정 계정", "omo-sticky": "dotz가 유지하는 계정", "omo-pool": "OmO 계정 풀", omp: "omp 로그인" };
const PROBLEM: Record<AccountProblem, string> = { expired: "토큰 만료 - OmO가 다음 요청 때 갱신해요", rate_limited: "사용량 조회가 429로 막힘", failed: "사용량 조회 실패" };

// Pure: the "한도" answer, naming whose limits these are. `labelOf` maps the raw account id to the owner's alias; the raw id
// then goes on a separate "-# " detail line (only when it differs from the label).
export function limitsText(r: AccountReport, now: number, labelOf: (name: string) => string = n => n): string {
	const name = labelOf(r.account);
	const head = [`계정: ${name} (${VIA[r.via]})`, ...(name !== r.account ? [`-# 계정 id: ${r.account}`] : [])].join("\n");
	const note = r.problem ? `${PROBLEM[r.problem]}${r.retryAt ? ` · ${span(r.retryAt - now)} 뒤 다시 조회` : ""}${r.limits.length && r.fetchedAt ? ` · 아래는 ${now - r.fetchedAt < 60_000 ? "방금" : `${span(now - r.fetchedAt)} 전`} 값` : ""}` : undefined;
	const lines = r.limits.map(l => `${l.label.padEnd(22)}${l.amount.used.toFixed(1)}% used${l.window.resetsAt ? ` · ${resetIn(l.window.resetsAt - now)}` : ""}`);
	return [head, ...(note ? [note] : []), ...(lines.length ? ["```", ...lines, "```"] : r.problem ? [] : ["(한도 정보 없음)"])].join("\n");
}
