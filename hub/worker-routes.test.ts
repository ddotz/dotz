import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { cfg } from "./config.ts";
import { availableModels } from "./providers.ts";
import { workerRoutesOf } from "./worker-routes.ts";

type Listed = { selector: string; provider: string; thinking?: string[] };
let listed: Listed[] = [];
const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
	const text = argv.includes("--list-models") ? "provider  model  context  max-out  thinking  images\n" : JSON.stringify({ models: listed.map(m => ({ kind: "chat", reasoning: true, ...m })) });
	return { stdout: new Response(text).body, exited: Promise.resolve(0), kill() {} };
}) as unknown as typeof Bun.spawn);
const savedModels = cfg.models;
const savedRuntime = cfg.runtime;
cfg.runtime = "omp";
afterAll(() => {
	spy.mockRestore();
	cfg.runtime = savedRuntime;
});
afterEach(() => {
	cfg.models = savedModels;
});

const auth = authFile();
mkdirSync(dirname(auth), { recursive: true });
writeFileSync(auth, JSON.stringify({ anthropic: { type: "oauth" } }));
let stamp = 1_700_000_000;
const holdList = async (models: Listed[]): Promise<void> => {
	listed = models;
	utimesSync(auth, ++stamp, ++stamp);
	await availableModels();
};

const OPUS = "anthropic/claude-opus-5-5:medium";

test("before the gateway holds a model list, the routes come from the install's role models and the shipped rows: hard moves up to the best score per extra dollar, light down to a cheaper point", () => {
	const routes = workerRoutesOf(OPUS);
	expect(routes.standard).toEqual({ selector: OPUS, basis: "configured", score: 48.21, cost: 2.45 });
	expect(routes.hard).toEqual({ selector: "anthropic/claude-opus-5-5:high", basis: "benchmark", score: 51.84, cost: 3.46 });
	expect(routes.light.basis).toBe("benchmark");
	expect(routes.light.cost).toBeLessThan(2.45);
});

test("a worker model without any rows steps one level on the same model", () => {
	const routes = workerRoutesOf("acme/unbenchmarked-1:medium");
	expect([routes.light.selector, routes.hard.selector]).toEqual(["acme/unbenchmarked-1:low", "acme/unbenchmarked-1:high"]);
	expect([routes.light.basis, routes.hard.basis]).toEqual(["ladder", "ladder"]);
});

test("the held model list adds the anchor provider's models as candidates and bounds the levels each model lists", async () => {
	await holdList([
		{ selector: "anthropic/claude-opus-5-5", provider: "anthropic", thinking: ["medium", "high"] },
		{ selector: "anthropic/claude-sonnet-5-5", provider: "anthropic", thinking: ["low"] },
		{ selector: "anthropic/claude-haiku-5-5", provider: "anthropic", thinking: ["low", "medium"] },
		{ selector: "other/claude-haiku-5-5", provider: "other", thinking: ["max"] },
	]);
	expect(workerRoutesOf(OPUS).light.selector).toBe("anthropic/claude-haiku-5-5:medium");
});

test("a role model under another provider is not a candidate, even with full rows", async () => {
	await holdList([{ selector: "anthropic/claude-opus-5-5", provider: "anthropic" }]);
	cfg.models = { workers: { model: "anthropic-subscription/claude-haiku-5-5", thinking: "medium" }, lookups: { model: "anthropic-subscription/claude-haiku-5-5" } };
	const routes = workerRoutesOf(OPUS);
	expect(routes.light.selector).toBe("anthropic/claude-opus-5-5:low");
});

test("an API-key anchor routes light and hard under its own provider, never back onto the subscription", async () => {
	await holdList([
		{ selector: "anthropic/claude-sonnet-5-5", provider: "anthropic" },
		{ selector: "anthropic/claude-haiku-5-5", provider: "anthropic" },
		{ selector: "anthropic-apikey/claude-opus-5-5", provider: "anthropic-apikey" },
	]);
	const routes = workerRoutesOf("anthropic-apikey/claude-opus-5-5:medium");
	expect(routes.light.selector).toBe("anthropic-apikey/claude-opus-5-5:low");
	expect(routes.hard.selector).toBe("anthropic-apikey/claude-opus-5-5:high");
});

test("a level above the automatic ceiling is owner-only even where guard.expensive_models is empty: light never lands on max, the ladder never steps to xhigh", async () => {
	await holdList([{ selector: "anthropic/claude-haiku-5-5", provider: "anthropic" }]);
	expect(workerRoutesOf(OPUS).light.selector).toBe("anthropic/claude-haiku-5-5:high");
	const ladder = workerRoutesOf("acme/unbenchmarked-1:high");
	expect(ladder.hard).toEqual(ladder.standard);
});
