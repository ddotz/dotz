// Task cap growth keys: defaults and validation next to task_token_cap.
import { expect, test } from "bun:test";
import { guardConfigFrom } from "./guard-config.ts";

test("growth defaults: on, 6M step, 48M ceiling", () => {
	const g = guardConfigFrom({});
	expect([g.task_cap_grow, g.task_cap_step, g.task_cap_ceiling]).toEqual([true, 6_000_000, 48_000_000]);
});

test("growth values are validated one by one and fall back to the default", () => {
	const g = guardConfigFrom({ task_cap_grow: "yes", task_cap_step: -5, task_cap_ceiling: "big" });
	expect([g.task_cap_grow, g.task_cap_step, g.task_cap_ceiling]).toEqual([true, 6_000_000, 48_000_000]);
	const set = guardConfigFrom({ task_cap_grow: false, task_cap_step: 2_000_000, task_cap_ceiling: 30_000_000 });
	expect([set.task_cap_grow, set.task_cap_step, set.task_cap_ceiling]).toEqual([false, 2_000_000, 30_000_000]);
});

test("the ceiling is never under the configured cap, and a cap of 0 stays 0", () => {
	expect(guardConfigFrom({ task_token_cap: 60_000_000 }).task_cap_ceiling).toBe(60_000_000);
	expect(guardConfigFrom({ task_token_cap: 60_000_000, task_cap_ceiling: 10_000_000 }).task_cap_ceiling).toBe(60_000_000);
	const none = guardConfigFrom({ task_token_cap: 0 });
	expect(none.task_token_cap).toBe(0);
	expect(none.task_cap_ceiling).toBe(48_000_000);
});
