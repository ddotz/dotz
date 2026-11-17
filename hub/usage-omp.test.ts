import { expect, test } from "bun:test";
import { limitsUsable } from "./orchestrator.ts";
import { buildQuota } from "./providers.ts";
import { fromOmp, ompAccounts, ompResets, ompStanding, scopeOf } from "./usage-account.ts";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const SOON = NOW + 3600e3;
const LATER = NOW + 86400e3;
const limit = (id: string, used: number, resetsAt: number, scope?: unknown) => ({
	id,
	label: id,
	window: { id: id.split(":")[1], label: id, durationMs: 1000, resetsAt },
	amount: { used, limit: 100, remaining: 100 - used, unit: "percent" },
	status: used >= 100 ? "exhausted" : "ok",
	...(scope === undefined ? {} : { scope }),
});
const FABLE = { provider: "anthropic", tier: "fable", windowId: "7d" };
const SHARED = { provider: "anthropic", windowId: "7d", shared: true };
const report = (email: string, limits: unknown[], extra: Record<string, unknown> = {}) => ({ provider: "anthropic", metadata: { email }, limits, ...extra });

test("scopeOf: a shared window has no scope, a model's own window is named by its tier or model, a string passes through", () => {
	expect(scopeOf(SHARED)).toBeUndefined();
	expect(scopeOf({ provider: "anthropic", windowId: "5h" })).toBeUndefined();
	expect(scopeOf(FABLE)).toBe("fable");
	expect(scopeOf({ provider: "anthropic", modelId: "claude-fable-5" })).toBe("claude-fable-5");
	expect(scopeOf("Fable")).toBe("Fable");
	expect(scopeOf("")).toBeUndefined();
	expect(scopeOf(undefined)).toBeUndefined();
});

test("F8-10: a spent Fable-only window keeps the omp subscription usable; a spent shared window does not", () => {
	const fableSpent = fromOmp(report("a@x.io", [limit("anthropic:5h", 10, SOON, SHARED), limit("anthropic:7d", 20, LATER, SHARED), limit("anthropic:7d:fable", 100, LATER, FABLE)]));
	expect(fableSpent.limits.find(l => l.id === "anthropic:7d:fable")?.scope).toBe("fable");
	expect(fableSpent.limits.filter(l => l.id !== "anthropic:7d:fable").every(l => l.scope === undefined)).toBe(true);
	expect(limitsUsable(fableSpent.limits)).toBe(true);
	const weekSpent = fromOmp(report("a@x.io", [limit("anthropic:5h", 10, SOON, SHARED), limit("anthropic:7d", 100, LATER, SHARED), limit("anthropic:7d:fable", 5, LATER, FABLE)]));
	expect(limitsUsable(weekSpent.limits)).toBe(false);
});

test("F8-10: the quota rows carry the scope as a name too, and the active flag", () => {
	const rows = buildQuota([report("a@x.io", [{ ...limit("anthropic:7d:fable", 100, LATER, FABLE), active: false }, limit("anthropic:7d", 20, LATER, SHARED)])], ["anthropic"], NOW).providers[0]!.limits;
	expect(rows[0]).toMatchObject({ id: "anthropic:7d:fable", scope: "fable", active: false });
	expect(rows[1]).not.toHaveProperty("scope");
});

const credit = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, remainingCount: 1, expiresAt: "2030-02-01T00:00:00Z", clears: ["anthropic:7d"], ...extra });

test("F8-11: resetCredits show as 리셋권 held by the login, none of them usable here, the next one named", () => {
	const r = fromOmp(report("a@x.io", [limit("anthropic:5h", 10, SOON, SHARED)], { resetCredits: { availableCount: 2, nextCreditId: "weekly-1", credits: [credit("weekly-1"), credit("fable-1", { clears: ["anthropic:7d:fable"], expiresAt: "2030-01-15T00:00:00Z" })] } })).resets;
	expect(r).toMatchObject({ held: 2, usable: false, expires_at: Date.parse("2030-01-15T00:00:00Z"), grant: { id: "weekly-1", kind: "주간" } });
	expect(r?.kinds.map(k => [k.kind, k.left, k.usable])).toEqual([["Fable", 1, false], ["주간", 1, false]]);
	expect(buildQuota([fromOmp(report("a@x.io", [limit("anthropic:5h", 10, SOON, SHARED)], { resetCredits: { availableCount: 1, credits: [credit("c")] } }))], ["anthropic"], NOW).providers[0]!.resets?.held).toBe(1);
});

test("F8-11: no held credit, expired or redeemed ones and an empty block show nothing; a numeric expiry is read as epoch ms", () => {
	expect(ompResets(undefined)).toBeUndefined();
	expect(ompResets({ availableCount: 0, credits: [credit("a")] })).toBeUndefined();
	expect(ompResets({ credits: [credit("a", { status: "expired" }), credit("b", { status: "redeemed" }), credit("c", { remainingCount: 0 })] })).toBeUndefined();
	expect(ompResets({ credits: [credit("a", { expiresAt: LATER })] })).toMatchObject({ held: 1, expires_at: LATER });
	expect(fromOmp(report("a@x.io", [limit("anthropic:5h", 10, SOON, SHARED)])).resets).toBeUndefined();
});

test("F8-12: two omp logins are two reports and two quota cards named by their login; one login keeps the plain name", () => {
	const reports = [report("a@x.io", [limit("anthropic:5h", 10, SOON, SHARED)]), report("b@x.io", [limit("anthropic:5h", 60, SOON, SHARED)]), { provider: "openai", limits: [limit("openai:5h", 1, SOON)] }];
	const accounts = ompAccounts(reports);
	expect(accounts.map(a => [a.account, a.via, a.limits[0]!.amount.used])).toEqual([["a@x.io", "omp", 10], ["b@x.io", "omp", 60]]);
	const cards = buildQuota(reports, ["anthropic", "openai"], NOW, { anthropic: "Claude 구독", openai: "OpenAI" }).providers;
	expect(cards.map(c => [c.provider, c.account, c.name])).toEqual([["anthropic", "a@x.io", "Claude 구독 · a@x.io"], ["anthropic", "b@x.io", "Claude 구독 · b@x.io"], ["openai", undefined, undefined]]);
	const one = buildQuota([reports[0]!], ["anthropic"], NOW, { anthropic: "Claude 구독" }).providers;
	expect(one.map(c => c.name)).toEqual([undefined]);
});

test("F8-12: the subscription stands on the first login with no spent shared window, else the one that frees first", () => {
	const spent = (email: string, at: number) => fromOmp(report(email, [limit("anthropic:5h", 100, at, SHARED), limit("anthropic:7d:fable", 100, at, FABLE)]));
	const free = fromOmp(report("free@x.io", [limit("anthropic:5h", 30, SOON, SHARED)]));
	expect(ompStanding([spent("a@x.io", SOON), free, spent("b@x.io", LATER)], NOW)?.account).toBe("free@x.io");
	expect(ompStanding([spent("a@x.io", LATER), spent("b@x.io", SOON)], NOW)?.account).toBe("b@x.io");
	expect(ompStanding([fromOmp(report("c@x.io", [{ ...limit("anthropic:5h", 100, SOON, SHARED), window: { id: "5h", label: "5h", durationMs: 1000 } }])), spent("d@x.io", LATER)], NOW)?.account).toBe("d@x.io");
	expect(ompStanding([], NOW)).toBeUndefined();
});
