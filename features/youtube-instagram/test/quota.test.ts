// quota ledger: units per Pacific day, budget check, rollover at Pacific midnight, the exhausted state with its once-a-day
// notice, and the lock file that serializes read-modify-write.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths, readJson, writeJson } from "../lib/config.ts";
import { announceExhausted, COSTS, can, exhaustedLine, isExhausted, markExhausted, spend, used, VIDEO_INSERT_COST } from "../lib/quota.ts";
import { TransientError } from "../lib/watchkit.ts";
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

test("markExhausted fills the budget and blocks can() until the next Pacific midnight, then the day starts clean", async () => {
	const cfg = loadConfig();
	const ctx = fakeCtx(env);
	await spend(ctx, 40);
	await markExhausted(ctx);
	expect(readJson<{ units: number; exhausted_until: string }>(paths.quota())).toMatchObject({ units: 9000, exhausted_until: "2030-06-16T07:00:00.000Z" });
	expect(isExhausted(ctx)).toBe(true);
	expect(can(ctx, cfg, 1)).toBe(false);
	expect(can(fakeCtx(env, { now: "2030-06-16T06:59:59Z" }), cfg, 1)).toBe(false);
	const next = fakeCtx(env, { now: "2030-06-16T07:00:00Z" });
	expect(isExhausted(next)).toBe(false);
	expect(can(next, cfg, 9000)).toBe(true);
	expect(used(next)).toBe(0);
});

test("the Pacific midnight follows daylight saving: 08:00Z in winter", async () => {
	const ctx = fakeCtx(env, { now: "2030-01-15T12:00:00Z" });
	await markExhausted(ctx);
	expect(readJson<{ exhausted_until: string }>(paths.quota())?.exhausted_until).toBe("2030-01-16T08:00:00.000Z");
});

test("announceExhausted prints the reset time in the owner's zone once per Pacific day and marks the ledger itself", async () => {
	const cfg = loadConfig();
	const ctx = fakeCtx(env);
	expect(exhaustedLine(ctx, cfg)).toBeUndefined();
	expect(await announceExhausted(ctx, cfg)).toEqual(["yt-quota-exhausted until=16:00"]);
	expect(await announceExhausted(ctx, cfg)).toEqual([]);
	expect(exhaustedLine(ctx, cfg)).toBe("yt-quota-exhausted until=16:00");
	const next = fakeCtx(env, { now: "2030-06-16T09:00:00Z" });
	expect(await announceExhausted(next, cfg)).toEqual(["yt-quota-exhausted until=16:00"]);
});

const lock = () => join(paths.cache(), "quota.lock");
const hold = (ageMs = 0) => {
	mkdirSync(paths.cache(), { recursive: true });
	writeFileSync(lock(), "");
	const at = new Date(Date.now() - ageMs);
	utimesSync(lock(), at, at);
};

test("the lock serializes concurrent spend() calls: both wait for the holder, read after it wrote, and no update is lost", async () => {
	writeJson(paths.quota(), { day: "2030-06-15", units: 10 });
	hold();
	const ctx = fakeCtx(env);
	let other = 0;
	ctx.sleep = async ms => {
		ctx.sleeps.push(ms);
		const first = other++ === 0;
		await Promise.resolve();
		if (first) {
			writeJson(paths.quota(), { day: "2030-06-15", units: 110 });
			unlinkSync(lock());
		}
	};
	await Promise.all([spend(ctx, 5), spend(ctx, 7)]);
	expect(ctx.sleeps).toHaveLength(2);
	expect(used(ctx)).toBe(122);
	expect(existsSync(lock())).toBe(false);
});

test("a lock older than 10 s is stale and taken over without waiting; a fresh one is respected", async () => {
	const ctx = fakeCtx(env);
	hold(11_000);
	await spend(ctx, 3);
	expect(used(ctx)).toBe(3);
	expect(ctx.sleeps).toHaveLength(0);
	expect(existsSync(lock())).toBe(false);
	hold(9_000);
	let waited = 0;
	ctx.sleep = async () => {
		if (waited++ === 0) unlinkSync(lock());
	};
	await spend(ctx, 4);
	expect(waited).toBe(1);
	expect(used(ctx)).toBe(7);
});

test("the wait for the lock is bounded and then fails as a transient error", async () => {
	const ctx = fakeCtx(env);
	hold();
	await expect(spend(ctx, 1)).rejects.toBeInstanceOf(TransientError);
	expect(ctx.sleeps.length).toBeGreaterThan(1);
	expect(ctx.sleeps.length).toBeLessThan(200);
	expect(used(ctx)).toBe(0);
});
