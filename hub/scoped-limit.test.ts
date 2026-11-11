import { expect, test } from "bun:test";
import { limitsUsable } from "./orchestrator.ts";
import { buildQuota } from "./providers.ts";
import { limitsOf } from "./usage-account.ts";

// Anthropic's usage answer: limits[] holds a "weekly_scoped" entry for one model next to the weekly one. Numbers here are made up.
const WEEK_RESET = "2030-01-07T01:00:00Z";
const body = (extra: unknown[] = []) => ({
	five_hour: null,
	seven_day: { utilization: 59, resets_at: WEEK_RESET },
	limits: [
		{ kind: "weekly_all", group: "weekly", percent: 59, resets_at: WEEK_RESET, is_active: true, scope: {} },
		{ kind: "weekly_scoped", group: "weekly", percent: 47, resets_at: "2030-01-07T00:59:59Z", is_active: false, scope: { model: { display_name: "Fable" }, surface: null } },
		...extra,
	],
});

test("limitsOf turns a weekly_scoped entry into its own row right under the weekly one, as the API gives it", () => {
	const limits = limitsOf(body());
	expect(limits.map(l => l.id)).toEqual(["anthropic:7d", "anthropic:7d:fable"]);
	expect(limits[1]).toMatchObject({ label: "Claude 7 Day (Fable)", scope: "Fable", active: false, status: "ok", amount: { used: 47, remaining: 53, unit: "percent" }, window: { id: "7d", resetsAt: Date.parse("2030-01-07T00:59:59Z") } });
	expect(limits[0]!.amount.used).toBe(59);
});

test("the scope name comes from the entry, not from a fixed list, and is_active is passed on as given", () => {
	const limits = limitsOf(body([{ kind: "weekly_scoped", percent: 10, resets_at: null, is_active: true, scope: { surface: { display_name: "Cowork" } } }]));
	expect(limits.at(-1)).toMatchObject({ id: "anthropic:7d:cowork", label: "Claude 7 Day (Cowork)", scope: "Cowork", active: true });
	expect(limits.at(-1)!.window.resetsAt).toBeUndefined();
});

test("limitsOf without limits[] gives the old rows, and an unknown kind is ignored", () => {
	const plain = { five_hour: { utilization: 20 }, seven_day: { utilization: 59 } };
	expect(limitsOf(plain).map(l => l.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
	const unknown = limitsOf({ ...plain, limits: [{ kind: "monthly_all", percent: 5, scope: { model: { display_name: "Fable" } } }, { kind: "weekly_scoped", percent: 5, scope: {} }] });
	expect(unknown.map(l => l.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
});

test("the budget and account readers look limits up by id: the weekly window stays 59 with a scoped row present", () => {
	const limits = limitsOf(body());
	expect(limits.find(l => l.id === "anthropic:7d")!.amount.used).toBe(59);
	expect(limits.find(l => l.id === "anthropic:5h")).toBeUndefined();
});

test("a scoped row that ran out does not make the subscription unusable; a weekly one still does", () => {
	const out = limitsOf({ seven_day: { utilization: 59 }, limits: [{ kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Fable" } } }] });
	expect(out.find(l => l.scope)!.amount.remaining).toBe(0);
	expect(limitsUsable(out)).toBe(true);
	expect(limitsUsable(limitsOf({ seven_day: { utilization: 100 } }))).toBe(false);
});

test("the quota API carries scope and active so the screen can tell a scoped row from the weekly one", () => {
	const q = buildQuota([{ provider: "anthropic", limits: limitsOf(body()) } as never], []);
	expect(q.providers[0]!.limits.map(l => [l.id, l.scope, l.active])).toEqual([["anthropic:7d", undefined, undefined], ["anthropic:7d:fable", "Fable", false]]);
});
