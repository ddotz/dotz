import { afterEach, expect, test } from "bun:test";
import { cfg, DEFAULT_MODEL, DEFAULT_WORKER_MODEL, lanesModel, orchestratorModel, parseSelector, splitThinking, workerModel } from "./config.ts";
import { clampEffort, sweetSpot } from "./model-effort.ts";

test("every table row gives its effort, with or without a provider prefix and an effort suffix", () => {
	const rows: [string, string][] = [
		["claude-fable-5-2", "high"],
		["claude-opus-5-5", "medium"],
		["claude-sonnet-5-5", "high"],
		["claude-haiku-5-5", "medium"],
		["deepseek-v4.1-flash", "high"],
		["gpt-6-astra", "high"],
		["gpt-6.1-sol", "medium"],
		["gpt-6-luna", "medium"],
	];
	for (const [id, effort] of rows) {
		for (const form of [id, `anthropic/${id}`, `x/${id}:max`, `${id}-20261001`]) expect(sweetSpot(form)).toEqual({ effort, source: "table" });
	}
});

test("an unknown family gets medium and says it is the default", () => {
	expect(sweetSpot("acme/mystery-9")).toEqual({ effort: "medium", source: "default" });
	expect(sweetSpot("anthropic/claude-mythos-5-1")).toEqual({ effort: "medium", source: "default" });
});

test("a new version of a known family takes the nearest earlier row of that family", () => {
	expect(sweetSpot("anthropic/claude-fable-5-3")).toEqual({ effort: "high", source: "family" });
	expect(sweetSpot("anthropic/claude-opus-5-6")).toEqual({ effort: "medium", source: "family" });
	expect(sweetSpot("anthropic/claude-opus-6")).toEqual({ effort: "medium", source: "family" });
	expect(sweetSpot("openai/gpt-6.2-sol")).toEqual({ effort: "medium", source: "family" });
	expect(sweetSpot("openai/gpt-7-astra")).toEqual({ effort: "high", source: "family" });
	expect(sweetSpot("deepseek/deepseek-v4.2-flash")).toEqual({ effort: "high", source: "family" });
	expect(sweetSpot("anthropic/claude-fable-5-1")).toEqual({ effort: "medium", source: "default" });
});

test("a level the model does not list is clamped the way OmO does: nearest above, else nearest below, else the first listed", () => {
	expect(clampEffort("medium", ["low", "high", "xhigh"])).toBe("high");
	expect(clampEffort("high", ["low", "medium"])).toBe("medium");
	expect(clampEffort("high", ["xhigh", "max"])).toBe("xhigh");
	expect(clampEffort("medium", [])).toBe("off");
	expect(clampEffort("medium", ["low", "medium", "high"])).toBe("medium");
	expect(sweetSpot("anthropic/claude-opus-5-5", ["low", "high", "xhigh"])).toEqual({ effort: "high", source: "table" });
	expect(sweetSpot("anthropic/claude-sonnet-5-5", ["off", "low", "medium"])).toEqual({ effort: "medium", source: "table" });
});

const SONNET = "anthropic/claude-sonnet-5-5", FABLE = "anthropic/claude-fable-5-2", OPUS = "anthropic/claude-opus-5-5";
const savedModels = cfg.models;
afterEach(() => {
	cfg.models = savedModels;
});

test("a target that names only a model runs it at that model's sweet spot", () => {
	cfg.models = { orchestrator: { model: SONNET }, lanes: { model: FABLE }, workers: { model: OPUS } };
	expect(orchestratorModel()).toEqual({ model: SONNET, thinking: "high" });
	expect(lanesModel()).toEqual({ model: FABLE, thinking: "high" });
	expect(parseSelector(workerModel())).toEqual({ model: OPUS, thinking: "medium" });
	expect(parseSelector(SONNET).thinking).toBe("high");
});

test("an effort the owner set is used as given, in config.json and in a selector suffix", () => {
	cfg.models = { orchestrator: { model: SONNET, thinking: "low" }, lanes: { model: FABLE, thinking: "xhigh" }, workers: { model: SONNET, thinking: "medium" } };
	expect(orchestratorModel().thinking).toBe("low");
	expect(lanesModel().thinking).toBe("xhigh");
	expect(workerModel()).toBe(`${SONNET}:medium`);
	expect(parseSelector(`${SONNET}:low`)).toEqual({ model: SONNET, thinking: "low" });
	cfg.models = { workers: { model: `${SONNET}:low` } };
	expect(workerModel()).toBe(`${SONNET}:low`);
});

test("DEFAULT_MODEL and DEFAULT_WORKER_MODEL carry the effort the table gives their model", () => {
	expect(DEFAULT_MODEL.thinking).toBe(sweetSpot(DEFAULT_MODEL.model).effort);
	const w = splitThinking(DEFAULT_WORKER_MODEL);
	expect(w.thinking).toBe(sweetSpot(w.model).effort);
});
