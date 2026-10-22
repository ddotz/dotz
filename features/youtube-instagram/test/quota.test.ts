// quota ledger: units per Pacific day, budget check, rollover at Pacific midnight.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, paths } from "../lib/config.ts";
import { COSTS, can, spend, used, VIDEO_INSERT_COST } from "../lib/quota.ts";
import { fakeCtx, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

test("costs follow Google's table with videos.insert as one named constant", () => {
	expect(COSTS).toEqual({ list: 1, update: 50, insertComment: 50, videoInsert: VIDEO_INSERT_COST });
	expect(VIDEO_INSERT_COST).toBe(1600);
});

test("spend adds up and can respects the daily budget", () => {
	const ctx = fakeCtx(env);
	const cfg = loadConfig();
	expect(used(ctx)).toBe(0);
	spend(ctx, 1600);
	spend(ctx, 1);
	expect(used(ctx)).toBe(1601);
	expect(can(ctx, cfg, 7399)).toBe(true);
	expect(can(ctx, cfg, 7400)).toBe(false);
});

test("the ledger rolls over at midnight Pacific, not UTC", () => {
	const cfg = loadConfig();
	const late = fakeCtx(env, { now: "2030-06-16T06:59:00Z" });
	spend(late, 5000);
	expect(used(fakeCtx(env, { now: "2030-06-16T01:00:00Z" }))).toBe(5000);
	const next = fakeCtx(env, { now: "2030-06-16T07:01:00Z" });
	expect(used(next)).toBe(0);
	expect(can(next, cfg, 9000)).toBe(true);
});

test("an unreadable ledger counts as empty", () => {
	mkdirSync(paths.cache(), { recursive: true });
	writeFileSync(paths.quota(), "{not json");
	expect(used(fakeCtx(env))).toBe(0);
});
