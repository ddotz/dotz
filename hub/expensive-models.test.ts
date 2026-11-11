// One definition of an expensive model: config.json guard.expensive_models + ask_before_expensive (extension/guard-config.ts).
// Lane gates, the lane launch route, the nightly token audit and the worker-model choice all read it; a guard-off install has none.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, parseSelector, workerModel } from "./config.ts";
import { isExpensive, workersOf } from "./lanegates.ts";
import { routeLanes } from "./routes-lanes.ts";
import { LOOKUP_CATEGORIES, ORCHESTRATOR_WORKERS, omoSelector, parseJsonc, WORKER_CATEGORIES, writeOrchestratorProfile } from "./runtime/omo.ts";
import { analyze } from "./token-audit.ts";

const CONFIG = join(DATA_DIR, "config.json");
const original = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : undefined;
const setGuard = (guard: Record<string, unknown> | undefined) => {
	const doc = original ? JSON.parse(original) : {};
	if (guard) doc.guard = guard;
	else delete doc.guard;
	writeFileSync(CONFIG, JSON.stringify(doc));
};
afterEach(() => {
	if (original === undefined) rmSync(CONFIG, { force: true });
	else writeFileSync(CONFIG, original);
});
const ON = { ask_before_expensive: true, expensive_models: ["fable", ":max"] };

const FABLE = "anthropic/claude-fable-5-2";
const OPUS = "anthropic/claude-opus-5-5:high";

test("with the guard off nothing is expensive, and the lane launch route does not refuse a Fable model", async () => {
	setGuard({ ask_before_expensive: false, expensive_models: ["fable"] });
	expect(isExpensive(FABLE)).toBe(false);
	expect(isExpensive("anthropic/claude-opus-5-5:max")).toBe(false);
	setGuard(undefined);
	expect(isExpensive(FABLE)).toBe(false);
	const launch = async (model: string) => {
		const url = new URL("http://hub/api/lanes");
		const res = await routeLanes(new Request(url, { method: "POST", body: JSON.stringify({ name: "dear-check", model, brief: "x" }), headers: { "content-type": "application/json" } }), url, ["api", "lanes"]);
		return { status: res!.status, error: String(((await res!.json()) as { error?: string }).error) };
	};
	const off = await launch(FABLE);
	expect(off.error).not.toContain("fable");
	setGuard(ON);
	const on = await launch(FABLE);
	expect(on.status).toBe(409);
	expect(on.error).toContain("fable");
});

test("with the guard on, the configured list decides: a model substring and a :level entry", () => {
	setGuard(ON);
	expect(isExpensive(FABLE)).toBe(true);
	expect(isExpensive("x:max")).toBe(true);
	expect(isExpensive(OPUS)).toBe(false);
	expect(isExpensive("anthropic/claude-opus-5-5:maximum")).toBe(false);
});

test("a main model that is expensive does not hand its workers on: they use models.workers; guard off or a cheap main keeps following it", () => {
	const worker = workerModel();
	setGuard(ON);
	expect(workersOf(`${FABLE}:high`)).toBe(worker);
	expect(workersOf("anthropic/claude-opus-5-5:max")).toBe(worker);
	expect(workersOf(OPUS)).toBe(OPUS);
	setGuard(undefined);
	expect(workersOf(`${FABLE}:high`)).toBe(`${FABLE}:high`);
});

test("the orchestrator profile: an expensive main gives non-quick categories the worker model (quick keeps the lookup model first); guard off keeps the main's", () => {
	const file = join(mkdtempSync(join(tmpdir(), "omo-home-")), "omo.jsonc");
	writeFileSync(file, "{\n}\n");
	const cats = () => (parseJsonc(readFileSync(file, "utf8")) as { profiles: Record<string, { categories: Record<string, { models: unknown[] }> }> }).profiles[ORCHESTRATOR_WORKERS].categories;
	const asOmo = (selector: string) => {
		const { model, thinking } = parseSelector(omoSelector(selector));
		return { model, reasoning: thinking };
	};
	setGuard(ON);
	writeOrchestratorProfile(file, `${FABLE}:high`, []);
	const heavy = WORKER_CATEGORIES.filter(c => !LOOKUP_CATEGORIES.includes(c));
	expect(heavy.length).toBeGreaterThan(0);
	for (const c of heavy) expect(cats()[c].models[0]).toEqual(asOmo(workerModel()));
	expect(cats().quick.models[0]).toEqual(asOmo("anthropic/claude-sonnet-5-5:medium"));
	setGuard(undefined);
	writeOrchestratorProfile(file, `${FABLE}:high`, []);
	for (const c of heavy) expect(cats()[c].models[0]).toEqual(asOmo(`${FABLE}:high`));
});

const T0 = Date.UTC(2026, 9, 19, 12);
const at = (min: number) => new Date(T0 + min * 60e3).toISOString();
const turn = (min: number, model: string) =>
	JSON.stringify({
		type: "message", timestamp: at(min),
		message: { role: "assistant", provider: "anthropic-subscription", model, stopReason: "stop", content: [], usage: { input: 2, output: 500, cacheRead: 1000, cacheWrite: 0, totalTokens: 1502, cost: { total: 0.1 } } },
	});
const level = (min: number, thinkingLevel: string) => JSON.stringify({ type: "thinking_level_change", timestamp: at(min), thinkingLevel });
const audited = () => {
	const file = join(mkdtempSync(join(tmpdir(), "audit-")), "s.jsonl");
	writeFileSync(file, `${[turn(0, "claude-fable-5-2"), turn(1, "claude-fable-5-2"), level(2, "max"), turn(3, "claude-opus-5-5"), turn(4, "claude-opus-5-5"), turn(5, "claude-opus-5-5")].join("\n")}\n`);
	return analyze({ file, label: "audit-dear", child: false, runtime: "omo" }, T0 - 1);
};

test("the token audit counts the configured list: guard off counts nothing, [fable, :max] counts the Fable turns and the max-level turns, [opus] counts Opus", () => {
	setGuard(undefined);
	const off = audited();
	expect([off.fable, off.effortTurns, off.expensiveCost]).toEqual([0, 0, 0]);
	setGuard(ON);
	const on = audited();
	expect([on.fable, on.effortTurns]).toEqual([2, 3]);
	expect(on.expensiveCost).toBeCloseTo(0.5);
	setGuard({ ask_before_expensive: true, expensive_models: ["opus"] });
	const opus = audited();
	expect([opus.fable, opus.effortTurns]).toEqual([3, 0]);
	expect(opus.expensiveCost).toBeCloseTo(0.3);
});
