// Per-model context window and auto-compaction point (config.json context.models, the 컨텍스트 screen): the hub's
// compaction trigger uses the running model's value, a window replaces the reported one, and bad values are refused.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { cfg, compactAtFor, CONFIG_FILE, ContextLimitError, setContextLimits } from "./config.ts";
import { contextView } from "./control.ts";
import { orch, orchestratorCompactAt } from "./orchestrator.ts";

const saved = readFileSync(CONFIG_FILE, "utf8");
const savedCtx = cfg.context;
afterEach(() => {
	writeFileSync(CONFIG_FILE, saved);
	cfg.context = savedCtx;
	orch.activeModel = "";
	orch.ctx.tokens = 0;
	orch.ctx.window = 0;
});

test("a model's compact_at replaces the role default; a window alone keeps the default below it; other models keep the default", () => {
	cfg.context = { models: { "anthropic/a": { compact_at: 150_000 }, "anthropic/b": { window: 200_000 } } };
	expect(compactAtFor("anthropic/a:high", 300_000)).toBe(150_000);
	expect(compactAtFor("anthropic/b", 300_000)).toBe(200_000 - 16_384);
	expect(compactAtFor("anthropic/b", 100_000)).toBe(100_000);
	expect(compactAtFor("anthropic/c:medium", 300_000)).toBe(300_000);
});

test("the orchestrator compacts at its running model's own point, read again on every call", () => {
	orch.activeModel = "anthropic/a:medium";
	cfg.context = {};
	const before = orchestratorCompactAt();
	setContextLimits("anthropic/a:medium", { compact_at: 120_000 });
	expect(orchestratorCompactAt()).toBe(120_000);
	expect(before).not.toBe(120_000);
});

test("saving writes config.json context.models by model id; null resets; bad values are refused", () => {
	setContextLimits("anthropic/a:high", { window: 400_000, compact_at: 250_000 });
	expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).context.models["anthropic/a"]).toEqual({ window: 400_000, compact_at: 250_000 });
	expect(() => setContextLimits("anthropic/a", { window: 400_000, compact_at: 400_000 })).toThrow(ContextLimitError);
	expect(() => setContextLimits("anthropic/a", { compact_at: 900_000 }, 800_000)).toThrow(ContextLimitError);
	expect(() => setContextLimits("anthropic/a", { window: 1000 })).toThrow(ContextLimitError);
	expect(() => setContextLimits("anthropic/a", { compact_at: 5000 })).toThrow(ContextLimitError);
	expect(() => setContextLimits("anthropic/a", { compact_at: 1.5e5 + 0.5 })).toThrow(ContextLimitError);
	expect(cfg.context?.models?.["anthropic/a"]).toEqual({ window: 400_000, compact_at: 250_000 });
	setContextLimits("anthropic/a", { window: null, compact_at: null });
	expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).context.models["anthropic/a"]).toBeUndefined();
	expect(cfg.context?.models?.["anthropic/a"]).toBeUndefined();
});

test("the context view applies a set window to the percent and lists the model with its defaults", () => {
	orch.activeModel = "anthropic/a:high";
	orch.ctx.tokens = 100_000;
	orch.ctx.window = 1_000_000;
	cfg.context = {};
	let v = contextView();
	expect(v.processes[0]).toMatchObject({ window: 1_000_000, percent: 10 });
	const m = v.models.find(x => x.model === "anthropic/a")!;
	expect(m).toMatchObject({ window: null, window_default: 1_000_000, compact_at: null });
	expect(m.used_by).toContain("orchestrator");
	cfg.context = { models: { "anthropic/a": { window: 200_000, compact_at: 150_000 } } };
	v = contextView();
	expect(v.processes[0]).toMatchObject({ window: 200_000, percent: 50, compact_at: 150_000 });
	expect(v.models.find(x => x.model === "anthropic/a")).toMatchObject({ window: 200_000, window_default: 1_000_000, compact_at: 150_000 });
});
