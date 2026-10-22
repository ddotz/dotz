// Anthropic limits of the whole organization behind the API key (owner 2026-10-22: account-wide, not per key). The
// `anthropic-ratelimit-*` response headers are org-level, so one 1-token message on the cheapest model reads them; the
// result is cached for 10 minutes. Usage and cost need the Admin API, which only accepts an sk-ant-admin key kept as
// <data dir>/secrets/anthropic-admin-key; without that file the card says so instead of guessing.
import { existsSync, readFileSync } from "node:fs";
import { keyPath } from "./fallback.ts";

export type OrgLimit = { id: string; label: string; window: string; used: number | null; limit: number | null; remaining: number | null; unit: string; resets_at: number | null; status: string };
export type OrgAdmin = { since: number; input_tokens: number; output_tokens: number; cost_usd: number | null };
export type OrgLimits = { fetched_at: number; limits: OrgLimit[]; admin: OrgAdmin | null; unavailable: { item: string; reason: string }[] };

const API = "https://api.anthropic.com";
const TTL_MS = 10 * 60_000;
const PROBE_MODEL = "claude-haiku-4-5";
const KINDS: [string, string, string][] = [["requests", "요청 수", "요청"], ["tokens", "토큰 합계", "토큰"], ["input-tokens", "입력 토큰", "토큰"], ["output-tokens", "출력 토큰", "토큰"]];

// Pure: the `anthropic-ratelimit-*` headers of a response as limit rows (none when the response carried no limits).
export function parseOrgLimits(h: Headers): OrgLimit[] {
	const num = (v: string | null) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
	return KINDS.flatMap(([kind, label, unit]): OrgLimit[] => {
		const limit = num(h.get(`anthropic-ratelimit-${kind}-limit`));
		if (limit == null) return [];
		const remaining = num(h.get(`anthropic-ratelimit-${kind}-remaining`));
		const reset = Date.parse(h.get(`anthropic-ratelimit-${kind}-reset`) ?? "");
		return [{
			id: `anthropic-org:${kind}`, label, window: "1분", used: remaining == null ? null : limit - remaining, limit, remaining, unit,
			resets_at: Number.isFinite(reset) ? reset : null, status: remaining != null && remaining <= 0 ? "exhausted" : "ok",
		}];
	});
}

const readKeyFile = (file: string) => (existsSync(keyPath(file)) ? readFileSync(keyPath(file), "utf8").trim() : "");
const headers = (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" });

async function probeLimits(key: string, fetcher: typeof fetch): Promise<OrgLimit[]> {
	const res = await fetcher(`${API}/v1/messages`, {
		method: "POST", headers: { ...headers(key), "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
	});
	// A 429 still carries the headers, which is exactly when they matter.
	const limits = parseOrgLimits(res.headers);
	if (!limits.length) throw new Error(`HTTP ${res.status}`);
	return limits;
}

// Pure: sums the Admin API usage buckets (tokens) and cost buckets (amounts are decimal strings in cents).
export function sumAdmin(usage: unknown, cost: unknown): { input_tokens: number; output_tokens: number; cost_usd: number | null } {
	const rows = (v: unknown): Record<string, unknown>[] =>
		((v as { data?: { results?: Record<string, unknown>[] }[] })?.data ?? []).flatMap(b => b.results ?? []);
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	let input = 0, output = 0;
	for (const r of rows(usage)) {
		const cc = (r.cache_creation ?? {}) as Record<string, unknown>;
		input += n(r.uncached_input_tokens) + n(r.cache_read_input_tokens) + n(cc.ephemeral_5m_input_tokens) + n(cc.ephemeral_1h_input_tokens);
		output += n(r.output_tokens);
	}
	const cents = rows(cost).reduce((s, r) => s + (Number(r.amount) || 0), 0);
	return { input_tokens: input, output_tokens: output, cost_usd: rows(cost).length ? cents / 100 : null };
}

async function adminTotals(key: string, fetcher: typeof fetch): Promise<OrgAdmin> {
	const since = Date.now() - 7 * 86_400_000, qs = `starting_at=${encodeURIComponent(new Date(since).toISOString().replace(/\.\d+Z$/, "Z"))}&bucket_width=1d&limit=7`;
	const get = async (path: string) => {
		const res = await fetcher(`${API}/v1/organizations/${path}?${qs}`, { headers: headers(key), signal: AbortSignal.timeout(20_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	};
	const [usage, cost] = await Promise.all([get("usage_report/messages"), get("cost_report")]);
	return { since, ...sumAdmin(usage, cost) };
}

type Keys = { api: string; admin: string };
const fileKeys = (): Keys => ({ api: readKeyFile("anthropic-api-key"), admin: readKeyFile("anthropic-admin-key") });

export async function collectOrgLimits(fetcher: typeof fetch = fetch, keys: Keys = fileKeys()): Promise<OrgLimits> {
	const unavailable: OrgLimits["unavailable"] = [];
	let limits: OrgLimit[] = [];
	const apiKey = keys.api;
	if (!apiKey) unavailable.push({ item: "조직 한도", reason: "API 키가 없어요" });
	else limits = await probeLimits(apiKey, fetcher).catch(e => { unavailable.push({ item: "조직 한도", reason: `읽지 못했어요 (${e instanceof Error ? e.message : "오류"})` }); return []; });
	let admin: OrgAdmin | null = null;
	const adminKey = keys.admin;
	if (!adminKey) unavailable.push({ item: "사용량·비용", reason: "관리자 키(sk-ant-admin)가 필요해요" });
	else admin = await adminTotals(adminKey, fetcher).catch(e => { unavailable.push({ item: "사용량·비용", reason: `관리자 API를 읽지 못했어요 (${e instanceof Error ? e.message : "오류"})` }); return null; });
	return { fetched_at: Date.now(), limits, admin, unavailable };
}

let cache: { at: number; value: OrgLimits } | undefined;
let inflight: Promise<OrgLimits> | undefined;
// Cached for 10 minutes (a failed read too, so a dead key is not retried on every card refresh).
export function orgLimits(fetcher: typeof fetch = fetch, now = Date.now(), keys?: Keys): Promise<OrgLimits> {
	if (cache && now - cache.at < TTL_MS) return Promise.resolve(cache.value);
	inflight ??= collectOrgLimits(fetcher, keys).then(value => { cache = { at: now, value }; return value; }).finally(() => { inflight = undefined; });
	return inflight;
}
export const resetOrgLimitsForTest = () => { cache = undefined; inflight = undefined; };
