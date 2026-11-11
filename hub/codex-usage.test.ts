// The Codex 리셋권 (hub/codex-usage.ts) against a fake upstream: the usage read parses how many are held, the nearest expiry and whether
// one can be used, with GETs only; POST /api/quota/reset-credit spends one only with confirm: true, after a fresh read, calling the
// fake consume endpoint exactly once. No request here leaves this process: the fake answers every URL and throws on any other.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexUsage, resetCodexForTest } from "./codex-usage.ts";
import { refreshQuota, resetQuotaForTest } from "./providers.ts";
import { routeSettings } from "./routes-settings.ts";

const BASE = "https://chatgpt.com/backend-api/wham";
const ACCOUNT = "me@example.com";
const realFetch = globalThis.fetch;
// This file's own Codex login, so a test file running beside it never sees one.
const home = mkdtempSync(join(tmpdir(), "dotz-codex-"));
process.env.CODEX_HOME = home;
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "tok-codex", account_id: "acct-1", refresh_token: "never-used" } }));
afterAll(() => {
	globalThis.fetch = realFetch;
	rmSync(home, { recursive: true, force: true });
});

type Json = Record<string, any>;
const usage = (over: Json = {}): Json => ({
	email: ACCOUNT,
	plan_type: "plus",
	rate_limit: {
		allowed: false,
		limit_reached: true,
		primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_after_seconds: 3600, reset_at: 1_900_000_000 },
		secondary_window: { used_percent: 64, limit_window_seconds: 604_800, reset_after_seconds: 86_400, reset_at: 1_900_500_000 },
	},
	rate_limit_reset_credits: { available_count: 2, applicable_available_count: 2 },
	...over,
});
const notLimited = { allowed: true, limit_reached: false, primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: 1_900_000_000 } };
const list = {
	credits: [
		{ id: "credit-late", reset_type: "codex_rate_limits", status: "available", expires_at: "2030-02-01T00:00:00Z" },
		{ id: "credit-soon", reset_type: "codex_rate_limits", status: "available", expires_at: "2030-01-15T00:00:00Z" },
		{ id: "credit-spent", reset_type: "codex_rate_limits", status: "redeemed", expires_at: "2029-12-01T00:00:00Z" },
	],
	available_count: 2,
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: Json };
function upstream(body: Json, consume: Json = { code: "reset", windows_reset: ["primary", "secondary"] }): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input), method = init.method ?? "GET";
		calls.push({ url, method, headers: init.headers as Record<string, string>, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
		if (method === "GET" && url === `${BASE}/usage`) return Response.json(body);
		if (method === "GET" && url === `${BASE}/rate-limit-reset-credits`) return Response.json(list);
		if (method === "POST" && url === `${BASE}/rate-limit-reset-credits/consume`) return Response.json(consume);
		throw new Error(`unexpected request ${method} ${url}`);
	}) as typeof fetch;
	return calls;
}
const consumes = (calls: Call[]) => calls.filter(c => c.url.endsWith("/consume"));
const post = async (b: unknown) => {
	const url = new URL("http://x/api/quota/reset-credit");
	const res = (await routeSettings(new Request(url, { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), url, ["api", "quota", "reset-credit"]))!;
	return { status: res.status, body: (await res.json()) as Json };
};

beforeEach(() => {
	resetCodexForTest();
	resetQuotaForTest();
});

test("the usage read holds the count, the nearest expiry and whether one can be used, and only reads", async () => {
	const calls = upstream(usage());
	const r = await codexUsage();
	expect(r?.usage).toMatchObject({ provider: "codex", name: "Codex", account: ACCOUNT, plan: "Plus" });
	expect(r?.usage?.resets).toEqual({ held: 2, usable: true, expires_at: Date.parse("2030-01-15T00:00:00Z") });
	expect(r?.usage?.limits.map(l => [l.label, l.remaining, l.status, l.resets_at])).toEqual([["5시간 한도", 0, "exhausted", 1_900_000_000_000], ["7일 한도", 36, "ok", 1_900_500_000_000]]);
	expect(calls.map(c => [c.method, c.url])).toEqual([["GET", `${BASE}/usage`], ["GET", `${BASE}/rate-limit-reset-credits`]]);
	expect(calls[0]?.headers).toMatchObject({ authorization: "Bearer tok-codex", "chatgpt-account-id": "acct-1" });
	// the usage screen's /api/quota carries it as one more card
	const q = await refreshQuota();
	expect(q.providers.find(p => p.provider === "codex")).toMatchObject({ account: ACCOUNT, resets: { held: 2, usable: true } });
	expect(consumes(calls)).toEqual([]);
});

test("held but no limit reached: the count shows and it cannot be used; none held: zero, and the list is not asked", async () => {
	upstream(usage({ rate_limit: notLimited }));
	expect((await codexUsage())?.usage?.resets).toMatchObject({ held: 2, usable: false });
	resetCodexForTest();
	const calls = upstream(usage({ rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 } }));
	expect((await codexUsage())?.usage?.resets).toEqual({ held: 0, usable: false, expires_at: null });
	expect(calls.map(c => c.url)).toEqual([`${BASE}/usage`]);
});

test("the route refuses without confirm: true and asks the upstream nothing", async () => {
	const calls = upstream(usage());
	for (const b of [{ account: ACCOUNT }, { account: ACCOUNT, confirm: false }, { account: ACCOUNT, confirm: "true" }, {}]) expect((await post(b)).status).toBe(400);
	expect(calls).toEqual([]);
});

test("with confirm: true the route reads afresh and calls consume once, for the credit that expires first", async () => {
	const calls = upstream(usage());
	expect(await post({ account: ACCOUNT, confirm: true })).toEqual({ status: 200, body: { ok: true, outcome: "reset", left: 1 } });
	const used = consumes(calls);
	expect(used.length).toBe(1);
	expect(used[0]?.method).toBe("POST");
	expect(used[0]?.headers).toMatchObject({ authorization: "Bearer tok-codex", "chatgpt-account-id": "acct-1" });
	expect(used[0]?.body).toMatchObject({ credit_id: "credit-soon" });
	expect(typeof used[0]?.body?.redeem_request_id).toBe("string");
	expect(calls.findIndex(c => c.url === `${BASE}/usage`)).toBeLessThan(calls.indexOf(used[0]!));
	// the route started a usage re-read; it settles here, while the fake upstream still answers
	await refreshQuota();
});

test("two uses at once spend one credit", async () => {
	const calls = upstream(usage());
	const both = await Promise.all([post({ account: ACCOUNT, confirm: true }), post({ account: ACCOUNT, confirm: true })]);
	expect(both.map(r => r.status).sort()).toEqual([200, 409]);
	expect(consumes(calls).length).toBe(1);
	await refreshQuota();
});

test("confirmed but nothing held, no limit reached or another account: refused, consume never called", async () => {
	const cases: [Json, Json][] = [
		[usage({ rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 } }), { account: ACCOUNT, confirm: true }],
		[usage({ rate_limit: notLimited }), { account: ACCOUNT, confirm: true }],
		[usage(), { account: "someone-else@example.com", confirm: true }],
	];
	for (const [body, b] of cases) {
		const calls = upstream(body);
		expect((await post(b)).status).toBe(409);
		expect(consumes(calls)).toEqual([]);
	}
});
