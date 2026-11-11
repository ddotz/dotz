import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { cfg, DEFAULT_MODEL, DEFAULT_WORKER_MODEL, lanesModel, orchestratorModel, parseSelector, splitThinking, workerModel } from "./config.ts";
import { targetView, setModel } from "./control.ts";
import { clampEffort, sweetSpot, useLearned } from "./model-effort.ts";
import "./outbound.ts";

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

test("a new version of a known family takes the nearest earlier row of that family, marked provisional", () => {
	expect(sweetSpot("anthropic/claude-fable-5-3")).toEqual({ effort: "high", source: "provisional" });
	expect(sweetSpot("anthropic/claude-opus-5-6")).toEqual({ effort: "medium", source: "provisional" });
	expect(sweetSpot("anthropic/claude-opus-6")).toEqual({ effort: "medium", source: "provisional" });
	expect(sweetSpot("openai/gpt-6.2-sol")).toEqual({ effort: "medium", source: "provisional" });
	expect(sweetSpot("openai/gpt-7-astra")).toEqual({ effort: "high", source: "provisional" });
	expect(sweetSpot("deepseek/deepseek-v4.2-flash")).toEqual({ effort: "high", source: "provisional" });
});

test("a version of a known family with no earlier row takes the nearest later row", () => {
	expect(sweetSpot("anthropic/claude-fable-5-1")).toEqual({ effort: "high", source: "provisional" });
	expect(sweetSpot("openai/gpt-5-sol")).toEqual({ effort: "medium", source: "provisional" });
});

test("precedence: a table row, then the install's benchmark value, then the provisional stand-in, then medium", () => {
	const learned = new Map<string, { effort: "low" | "high"; status: "benchmark" | "provisional" }>([
		["claude-fable-5-3", { effort: "low", status: "benchmark" }],
		["claude-opus-5-5", { effort: "high", status: "benchmark" }],
		["claude-opus-5-6", { effort: "high", status: "provisional" }],
		["acme-9", { effort: "high", status: "benchmark" }],
	]);
	useLearned(() => learned);
	try {
		expect(sweetSpot("claude-opus-5-5")).toEqual({ effort: "medium", source: "table" });
		expect(sweetSpot("anthropic/claude-fable-5-3")).toEqual({ effort: "low", source: "benchmark" });
		expect(sweetSpot("anthropic/claude-fable-5-3", ["medium", "high"])).toEqual({ effort: "medium", source: "benchmark" });
		expect(sweetSpot("anthropic/claude-opus-5-6")).toEqual({ effort: "medium", source: "provisional" });
		expect(sweetSpot("acme-9")).toEqual({ effort: "high", source: "benchmark" });
		expect(sweetSpot("acme-8")).toEqual({ effort: "medium", source: "default" });
		expect(sweetSpot("anthropic/claude-fable-5-4")).toEqual({ effort: "low", source: "provisional" });
		useLearned(() => undefined);
		expect(sweetSpot("anthropic/claude-fable-5-3")).toEqual({ effort: "high", source: "provisional" });
	} finally {
		useLearned(() => undefined);
	}
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

const spy = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill() {} })) as unknown as typeof Bun.spawn);
afterAll(() => spy.mockRestore());

test("changing the model without an effort sets the new model's sweet spot; an effort in the request, or the same model, keeps its own", async () => {
	const P = "ch:7301", view = async () => (await targetView(P)) as { model: string; thinking: string };
	await setModel(P, FABLE);
	expect(await view()).toMatchObject({ model: FABLE, thinking: "high" });
	await setModel(P, OPUS);
	expect(await view()).toMatchObject({ model: OPUS, thinking: "medium" });
	await setModel(P, FABLE, "low");
	expect(await view()).toMatchObject({ model: FABLE, thinking: "low" });
	await setModel(P, `${OPUS}:xhigh`);
	expect(await view()).toMatchObject({ model: OPUS, thinking: "xhigh" });
	await setModel(P, OPUS);
	expect(await view()).toMatchObject({ model: OPUS, thinking: "xhigh" });
	await setModel(P, undefined, "high");
	expect(await view()).toMatchObject({ model: OPUS, thinking: "high" });
});

test("a target with no stored effort follows the install's benchmark value; a stored effort stays", () => {
	const ACME = "anthropic/acme-9";
	const value = (effort: "low" | "high") => useLearned(() => new Map([["acme-9", { effort, status: "benchmark" as const }]]));
	try {
		cfg.models = { orchestrator: { model: ACME }, lanes: { model: ACME, thinking: "xhigh" }, workers: { model: ACME } };
		expect(orchestratorModel().thinking).toBe("medium");
		value("high");
		expect([orchestratorModel().thinking, lanesModel().thinking, parseSelector(workerModel()).thinking]).toEqual(["high", "xhigh", "high"]);
		value("low");
		expect([orchestratorModel().thinking, lanesModel().thinking, parseSelector(workerModel()).thinking]).toEqual(["low", "xhigh", "low"]);
	} finally {
		useLearned(() => undefined);
	}
});

test("picking a model for a config target stores no effort unless the owner gave one", async () => {
	cfg.models = { lanes: { model: OPUS, thinking: "low" } };
	await setModel("lanes", FABLE);
	expect(cfg.models?.lanes).toEqual({ model: FABLE, thinking: undefined });
	await setModel("lanes", OPUS, "xhigh");
	expect(cfg.models?.lanes).toEqual({ model: OPUS, thinking: "xhigh" });
	await setModel("lanes", FABLE, "high");
	await setModel("lanes", FABLE, "medium");
	expect(cfg.models?.lanes?.thinking).toBe("medium");
	await setModel("lanes", undefined, "low");
	expect(cfg.models?.lanes).toEqual({ model: FABLE, thinking: "low" });
});
