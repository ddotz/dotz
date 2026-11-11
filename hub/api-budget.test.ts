import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { apiBudget, budgetSettings, deleteAdminKey, resetApiBudgetCacheForTest, saveAdminKey, saveMonthlyLimit, sumCostUsd } from "./api-budget.ts";
import { CONFIG_FILE } from "./config.ts";
import { keyPath, resetFallbackState, spendOnKey } from "./fallback.ts";

const NOW = Date.UTC(2026, 9, 22, 6, 0, 0);
const REPORT = { data: [{ starting_at: "2026-10-01T00:00:00Z", results: [{ amount: "4000" }] }, { starting_at: "2026-10-02T00:00:00Z", results: [{ amount: "1500.5" }, { amount: "999.5" }] }, { results: [] }], has_more: false, next_page: null };
const ADMIN = "sk-ant-admin01-testtesttesttest";

beforeEach(() => {
	resetApiBudgetCacheForTest();
	resetFallbackState();
	deleteAdminKey();
});

const reportFetch = (urls: string[], body: unknown = REPORT, status = 200) =>
	(async (url: string) => { urls.push(url); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;

test("sums the cost report cents into dollars", () => {
	expect(sumCostUsd([REPORT])).toBe(65);
	expect(sumCostUsd([{}, null])).toBe(0);
});

test("admin key: month-to-date cost from the cost report as $ and % of the limit, cached 10 minutes", async () => {
	const urls: string[] = [];
	const fetcher = reportFetch(urls);
	const b = await apiBudget({ fetcher, now: NOW, adminKey: ADMIN, limitUsd: 100 });
	expect(b).toMatchObject({ source: "admin", month: "2026-10", spent_usd: 65, limit_usd: 100, pct: 65 });
	expect(b.hint).toBeUndefined();
	expect(urls).toHaveLength(1);
	const u = new URL(urls[0]);
	expect(u.pathname).toBe("/v1/organizations/cost_report");
	expect(u.searchParams.get("starting_at")).toBe("2026-10-01T00:00:00Z");
	await apiBudget({ fetcher, now: NOW + 9 * 60_000, adminKey: ADMIN, limitUsd: 100 });
	expect(urls).toHaveLength(1);
	await apiBudget({ fetcher, now: NOW + 11 * 60_000, adminKey: ADMIN, limitUsd: 100 });
	expect(urls).toHaveLength(2);
});

test("a missing limit gives the spend without a percentage", async () => {
	const b = await apiBudget({ fetcher: reportFetch([]), now: NOW, adminKey: ADMIN, limitUsd: null });
	expect(b).toMatchObject({ spent_usd: 65, limit_usd: null, pct: null });
});

test("no admin key: dotz's own month-to-date spend, labeled as an estimate with the admin-key hint", async () => {
	spendOnKey("anthropic-api-key", 9, 99, Date.UTC(2026, 8, 20));
	spendOnKey("anthropic-api-key", 1000, 12.5, NOW);
	spendOnKey("anthropic-api-key", 500, 2.5, NOW);
	const urls: string[] = [];
	const b = await apiBudget({ fetcher: reportFetch(urls), now: NOW, adminKey: "", limitUsd: 100 });
	expect(b).toMatchObject({ source: "estimate", month: "2026-10", spent_usd: 15, limit_usd: 100, pct: 15 });
	expect(b.hint).toContain("sk-ant-admin");
	expect(b.error).toBeUndefined();
	expect(urls).toHaveLength(0);
});

test("a failing cost report falls back to the estimate and says why", async () => {
	spendOnKey("anthropic-api-key", 10, 4, NOW);
	const b = await apiBudget({ fetcher: reportFetch([], {}, 403), now: NOW, adminKey: ADMIN, limitUsd: 50 });
	expect(b).toMatchObject({ source: "estimate", spent_usd: 4, pct: 8 });
	expect(b.error).toContain("HTTP 403");
});

test("resets at the start of next month: UTC for the admin report, KST midnight for the estimate", async () => {
	const admin = await apiBudget({ fetcher: reportFetch([]), now: NOW, adminKey: ADMIN, limitUsd: 100 });
	expect(admin.resets_at).toBe(Date.UTC(2026, 10, 1));
	const est = await apiBudget({ now: NOW, adminKey: "", limitUsd: 100 });
	expect(est.resets_at).toBe(Date.UTC(2026, 10, 1) - 9 * 3600e3);
	const dec = Date.UTC(2026, 11, 31, 20, 0, 0);
	expect((await apiBudget({ fetcher: reportFetch([]), now: dec, adminKey: ADMIN, limitUsd: 100 })).resets_at).toBe(Date.UTC(2027, 0, 1));
});

test("the monthly limit is stored in config.json, validated, and cleared by an empty value", () => {
	saveMonthlyLimit("100");
	expect(budgetSettings().monthly_usd).toBe(100);
	expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).api_budget).toEqual({ monthly_usd: 100 });
	expect(() => saveMonthlyLimit("abc")).toThrow();
	expect(() => saveMonthlyLimit(-5)).toThrow();
	expect(budgetSettings().monthly_usd).toBe(100);
	saveMonthlyLimit("");
	expect(budgetSettings().monthly_usd).toBeNull();
	expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).api_budget).toBeUndefined();
});

test("the admin key is checked, stored mode 600, shown only as a mask, and deletable", async () => {
	await expect(saveAdminKey("sk-ant-api03-notadmin")).rejects.toThrow("형식");
	await expect(saveAdminKey(ADMIN, reportFetch([], {}, 403))).rejects.toThrow("맞지 않아요");
	expect(budgetSettings().admin_key.present).toBe(false);
	const r = await saveAdminKey(`  ${ADMIN}\n`, reportFetch([]));
	expect(r.masked).toBe("sk-ant-admin…test");
	expect(statSync(keyPath("anthropic-admin-key")).mode & 0o777).toBe(0o600);
	expect(JSON.stringify(budgetSettings())).not.toContain(ADMIN);
	expect(budgetSettings().admin_key).toMatchObject({ present: true, masked: "sk-ant-admin…test" });
	expect(deleteAdminKey()).toEqual({ deleted: true });
	expect(existsSync(keyPath("anthropic-admin-key"))).toBe(false);
});
