// How much of the owner's monthly API spend limit is used. The limit is set on the Anthropic platform console, and no API
// exposes it (the Spend Limits API is Claude Enterprise only), so the owner types it into the settings (config.json
// api_budget.monthly_usd). The month-to-date spend comes from, in order:
//   1. the Admin API cost report (GET /v1/organizations/cost_report), when an sk-ant-admin key is stored as
//      <data dir>/secrets/anthropic-admin-key: the real organization-wide spend, billed by calendar month in UTC;
//   2. dotz's own recorded spend on its API key (token usage x model prices, hub/fallback.ts keySpend), a KST-month estimate
//      that misses everything else the key is used for.
// The cost call is cached for 10 minutes (a failed read too) and bounded by a 20 s timeout. The admin key is format-checked and
// tried once before it is stored (mode 600); it is never returned, logged or written anywhere else.
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { cfg, setApiBudgetLimit, writeAtomic } from "./config.ts";
import { keyPath, keySpend } from "./fallback.ts";

export const ADMIN_KEY_FILE = "anthropic-admin-key";
const API_KEY_FILE = "anthropic-api-key";
const API = "https://api.anthropic.com";
const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;
const ADMIN_FORMAT = /^sk-ant-admin[\w-]{10,}$/;
const LIMIT_MAX = 10_000_000;

export type ApiBudget = {
	fetched_at: number;
	source: "admin" | "estimate";
	month: string; // "YYYY-MM" of the billing month the spend covers
	spent_usd: number;
	limit_usd: number | null;
	pct: number | null;
	resets_at: number; // start of the next month, epoch ms
	hint?: string;
	error?: string;
};

const utcMonth = (at: number) => new Date(at).toISOString().slice(0, 7);
// The platform bills by calendar month in UTC; the cost report's day buckets are UTC too.
export const utcMonthStart = (at: number) => { const d = new Date(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
export const utcMonthEnd = (at: number) => { const d = new Date(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

const readKeyFile = (file: string) => (existsSync(keyPath(file)) ? readFileSync(keyPath(file), "utf8").trim() : "");
const maskKey = (key: string) => `sk-ant-admin…${key.slice(-4)}`;
const headers = (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" });

export const monthlyLimit = (): number | null => {
	const v = cfg.api_budget?.monthly_usd;
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
};

// Pure: the cost report's amounts are decimal strings in cents; this is the sum over every bucket in dollars.
export function sumCostUsd(pages: unknown[]): number {
	let cents = 0;
	for (const p of pages) for (const b of (p as { data?: { results?: { amount?: unknown }[] }[] })?.data ?? []) for (const r of b.results ?? []) cents += Number(r.amount) || 0;
	return cents / 100;
}

// Month-to-date cost of the whole organization. One page holds up to 31 day buckets, so a month is one request; the loop only
// follows a cursor if the API ever splits it.
async function monthCost(key: string, fetcher: typeof fetch, now: number): Promise<number> {
	const start = new Date(utcMonthStart(now)).toISOString().replace(/\.\d+Z$/, "Z");
	const pages: unknown[] = [];
	let page: string | undefined;
	for (let i = 0; i < 4; i++) {
		const qs = new URLSearchParams({ starting_at: start, bucket_width: "1d", limit: "31", ...(page ? { page } : {}) });
		const res = await fetcher(`${API}/v1/organizations/cost_report?${qs}`, { headers: headers(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as { has_more?: boolean; next_page?: string | null };
		pages.push(json);
		if (!json.has_more || !json.next_page) break;
		page = json.next_page;
	}
	return sumCostUsd(pages);
}

type Cached = { at: number; key: string; result: { usd: number } | { error: string } };
let cache: Cached | undefined;
export const resetApiBudgetCacheForTest = () => { cache = undefined; };

export type Deps = { fetcher?: typeof fetch; now?: number; adminKey?: string; limitUsd?: number | null };

export async function apiBudget(d: Deps = {}): Promise<ApiBudget> {
	const now = d.now ?? Date.now(), fetcher = d.fetcher ?? fetch;
	const adminKey = d.adminKey ?? readKeyFile(ADMIN_KEY_FILE);
	const limit = d.limitUsd !== undefined ? d.limitUsd : monthlyLimit();
	const pctOf = (spent: number) => (limit ? (spent / limit) * 100 : null);
	let error: string | undefined;
	if (adminKey) {
		if (!(cache && cache.key === adminKey && now - cache.at < TTL_MS)) {
			const result = await monthCost(adminKey, fetcher, now).then(usd => ({ usd }), e => ({ error: `관리자 키로 비용을 읽지 못했어요 (${e instanceof Error ? e.message : "오류"})` }));
			cache = { at: now, key: adminKey, result };
		}
		const r = cache.result;
		if ("usd" in r) return { fetched_at: cache.at, source: "admin", month: utcMonth(now), spent_usd: r.usd, limit_usd: limit, pct: pctOf(r.usd), resets_at: utcMonthEnd(now) };
		error = r.error;
	}
	const own = keySpend(API_KEY_FILE, now);
	return {
		fetched_at: now, source: "estimate", month: new Date(now + 9 * 3600e3).toISOString().slice(0, 7), spent_usd: own.usd, limit_usd: limit, pct: pctOf(own.usd), resets_at: own.resets_at,
		hint: "콘솔 기준 전체 사용액은 관리자 키(sk-ant-admin…)를 설정에서 추가하면 보여줘요.",
		...(error ? { error } : {}),
	};
}

// ---- settings: the limit and the admin key -----------------------------------------------------------------------------
export function budgetSettings() {
	const key = readKeyFile(ADMIN_KEY_FILE);
	return { monthly_usd: monthlyLimit(), admin_key: { file: ADMIN_KEY_FILE, present: Boolean(key), ...(key ? { masked: maskKey(key) } : {}) } };
}

// null / "" clears the limit; anything else must be a positive number of dollars.
export function saveMonthlyLimit(v: unknown): void {
	if (v == null || (typeof v === "string" && v.trim() === "")) return setApiBudgetLimit(null);
	const n = typeof v === "number" ? v : Number(String(v).trim().replace(/^\$/, ""));
	if (!Number.isFinite(n) || n <= 0 || n > LIMIT_MAX) throw new Error("월 한도는 0보다 큰 달러 금액으로 입력해 주세요");
	setApiBudgetLimit(Math.round(n * 100) / 100);
}

// One cost-report request with the key: 200 = good; 401/403 = a wrong key or one without admin rights; else could not tell (nothing is stored).
export async function saveAdminKey(raw: string, fetcher: typeof fetch = fetch): Promise<{ masked: string }> {
	const key = raw.replace(/\s+/g, "");
	if (!ADMIN_FORMAT.test(key)) throw new Error("관리자 키 형식이 아니에요 (sk-ant-admin…으로 시작해요)");
	try {
		await monthCost(key, fetcher, Date.now());
	} catch (e) {
		const msg = e instanceof Error ? e.message : "오류";
		if (/HTTP 40[13]/.test(msg)) throw new Error(`키가 맞지 않아요 (${msg.slice(5)}). 관리자 키를 다시 복사해 붙여 넣어 주세요.`);
		throw new Error(`키를 확인하지 못했어요 (${msg}). 잠시 뒤 다시 해 주세요.`);
	}
	const file = keyPath(ADMIN_KEY_FILE);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeAtomic(file, `${key}\n`, 0o600);
	chmodSync(file, 0o600);
	cache = undefined;
	return { masked: maskKey(key) };
}

export function deleteAdminKey(): { deleted: boolean } {
	const file = keyPath(ADMIN_KEY_FILE);
	cache = undefined;
	if (!existsSync(file)) return { deleted: false };
	unlinkSync(file);
	return { deleted: true };
}
