import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Collected, type LearnDeps, learnTick, MAX_PER_DAY, RETRY_DAYS } from "./effort-learn.ts";
import { loadState } from "./effort-store.ts";

const HOUR = 3600_000, DAY = 24 * HOUR;
const SONNET_ROWS = [
	{ effort: "low", score: 26, cost: 0.51 },
	{ effort: "medium", score: 31, cost: 0.78 },
	{ effort: "high", score: 42, cost: 1.64 },
	{ effort: "xhigh", score: 50, cost: 4.09 },
	{ effort: "max", score: 55, cost: 10.02 },
];
const FOUND: Collected = { rows: SONNET_ROWS, sources: [{ url: "https://example.com/board" }] };

let dir: string;
let clock: number;
let models: string[];
let named: string[];
let on: boolean;
let calls: string[];
let answer: (id: string) => Collected | undefined;
let told: string[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "effort-learn-"));
	clock = Date.parse("2026-11-12T00:00:00Z");
	models = ["anthropic/claude-opus-5-5", "acme/old-1"];
	named = [];
	on = true;
	calls = [];
	told = [];
	answer = () => FOUND;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const deps = (): LearnDeps => ({
	dir,
	enabled: () => on,
	listed: async () => models,
	named: () => named,
	collect: async id => (calls.push(id), answer(id)),
	now: () => clock,
	learned: e => told.push(`${e.id}:${e.effort}`),
});

test("the first tick records the model list as the baseline and collects nothing", async () => {
	models = ["acme/a-1", "acme/b-1", "acme/c-1"];
	await learnTick(deps());
	expect(calls).toEqual([]);
	expect(loadState(dir).baseline).toEqual(["a-1", "b-1", "c-1"]);
});

test("an id that appears after the baseline is collected once, and its benchmark value is recorded", async () => {
	await learnTick(deps());
	models.push("anthropic/claude-sonnet-9-9");
	const entry = await learnTick(deps());
	expect(calls).toEqual(["claude-sonnet-9-9"]);
	expect(entry).toMatchObject({ id: "claude-sonnet-9-9", effort: "high", status: "benchmark" });
	expect(told).toEqual(["claude-sonnet-9-9:high"]);
	await learnTick(deps());
	await learnTick(deps());
	expect(calls).toEqual(["claude-sonnet-9-9"]);
});

test("a model with a shipped table row is never collected", async () => {
	await learnTick(deps());
	models.push("anthropic/claude-sonnet-5-5");
	await learnTick(deps());
	expect(calls).toEqual([]);
});

test("one model per tick, and at most MAX_PER_DAY collections in 24 hours", async () => {
	await learnTick(deps());
	models.push(...["m-1", "m-2", "m-3", "m-4"].map(id => `acme/${id}`));
	await learnTick(deps());
	expect(calls).toEqual(["m-1"]);
	for (let i = 0; i < 5; i++) await learnTick(deps());
	expect(calls).toEqual(["m-1", "m-2", "m-3"]);
	expect(calls.length).toBe(MAX_PER_DAY);
	clock += 25 * HOUR;
	await learnTick(deps());
	expect(calls).toEqual(["m-1", "m-2", "m-3", "m-4"]);
});

test("a model the config names with no row and no recorded value is collected, also when it was in the baseline", async () => {
	await learnTick(deps());
	named = ["acme/old-1", "anthropic/claude-opus-5-5"];
	await learnTick(deps());
	expect(calls).toEqual(["old-1"]);
});

test("no rows found: provisional, tried again after a day, stopped after two weeks, reopened when the model list changes", async () => {
	await learnTick(deps());
	models.push("acme/new-1");
	answer = () => undefined;
	const first = await learnTick(deps());
	expect(first).toMatchObject({ status: "provisional", tries: 1 });
	expect(Date.parse(first!.next!)).toBe(clock + DAY);
	await learnTick(deps());
	expect(calls).toEqual(["new-1"]);
	clock += DAY;
	await learnTick(deps());
	expect(calls).toEqual(["new-1", "new-1"]);
	for (let d = 2; d <= RETRY_DAYS; d++) {
		clock += DAY;
		await learnTick(deps());
	}
	expect(loadState(dir).entries["new-1"]).toMatchObject({ status: "provisional", stopped: true });
	const before = calls.length;
	clock += 3 * DAY;
	await learnTick(deps());
	expect(calls.length).toBe(before);
	models.push("acme/newer-1");
	answer = id => (id === "new-1" ? FOUND : undefined);
	await learnTick(deps());
	await learnTick(deps());
	expect(loadState(dir).entries["new-1"]?.status).toBe("benchmark");
});

test("a collection that throws or returns malformed output records nothing but a provisional try", async () => {
	await learnTick(deps());
	models.push("acme/bad-1", "acme/bad-2");
	answer = id => {
		if (id === "bad-1") throw new Error("offline");
		return { rows: [{ effort: "turbo", score: 1, cost: 1 }, { effort: "low", score: "x", cost: 1 }], sources: [{ url: "http://plain.example/x" }] };
	};
	await learnTick(deps());
	await learnTick(deps());
	const { entries } = loadState(dir);
	expect(entries["bad-1"]?.status).toBe("provisional");
	expect(entries["bad-2"]).toMatchObject({ status: "provisional", rows: [], sources: [] });
	expect(told).toEqual([]);
});

test("rows without an https source are not a benchmark value", async () => {
	await learnTick(deps());
	models.push("acme/nosrc-1");
	answer = () => ({ rows: SONNET_ROWS, sources: [{ url: "javascript:alert(1)" }, { url: 5 }] });
	expect((await learnTick(deps()))?.status).toBe("provisional");
});

test("with the setting off nothing is listed, fetched or written", async () => {
	on = false;
	let listed = 0;
	await learnTick({ ...deps(), listed: async () => (listed++, models) });
	expect(listed).toBe(0);
	expect(calls).toEqual([]);
	expect(loadState(dir).baseline).toBeUndefined();
});
