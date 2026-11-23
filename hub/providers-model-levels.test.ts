import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { cfg, paths } from "./config.ts";
import { availableModels, forgetProviderReads } from "./providers.ts";

const TABLE = [
	"provider  model  context  max-out  thinking  images",
	"anthropic-subscription  claude-opus-5-5  1M  128K  yes  yes",
	"anthropic-subscription  claude-haiku-5-5  1M  128K  no  yes",
	"",
].join("\n");
const OMP_JSON = JSON.stringify({
	models: [
		{ kind: "chat", selector: "anthropic/claude-opus-5-5", provider: "anthropic", reasoning: true, thinking: ["low", "medium", "high"] },
		{ kind: "chat", selector: "anthropic/claude-haiku-5-5", provider: "anthropic", reasoning: true, thinking: ["medium"] },
		{ kind: "chat", selector: "anthropic/claude-sonnet-5-5", provider: "anthropic", reasoning: true },
	],
});
const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
	const text = argv.includes("--list-models") ? TABLE : OMP_JSON;
	return { stdout: new Response(text).body, exited: Promise.resolve(0), kill() {} };
}) as unknown as typeof Bun.spawn);
const saved = { orchestrator: cfg.orchestrator, lanes: cfg.lanes };
cfg.orchestrator = { ...cfg.orchestrator, runtime: "omo" };
cfg.lanes = { ...cfg.lanes, runtime: "omp" };
afterAll(() => {
	spy.mockRestore();
	cfg.orchestrator = saved.orchestrator;
	cfg.lanes = saved.lanes;
});

const auth = authFile();
mkdirSync(dirname(auth), { recursive: true });
writeFileSync(auth, JSON.stringify({ "anthropic-subscription": { type: "oauth" } }));
utimesSync(auth, 1_700_100_000, 1_700_100_001);

test("an entry both runtimes list takes the thinking levels of the duplicate that has them; an entry that already says its levels keeps them", async () => {
	const byName = Object.fromEntries((await availableModels()).map(m => [m.selector, m.thinking]));
	expect(byName["anthropic/claude-opus-5-5"]).toEqual(["low", "medium", "high"]);
	expect(byName["anthropic/claude-haiku-5-5"]).toEqual([]);
	expect(byName["anthropic/claude-sonnet-5-5"]).toBeUndefined();
});

test("the merged list has one entry per selector", async () => {
	const selectors = (await availableModels()).map(m => m.selector);
	expect(new Set(selectors).size).toBe(selectors.length);
	expect(selectors).toContain("anthropic/claude-sonnet-5-5");
});

test("a runtime whose model list cannot be read is logged once, not swallowed", async () => {
	const healthy = spy.getMockImplementation();
	const logged = (): number => (existsSync(paths.log) ? (readFileSync(paths.log, "utf8").match(/the model list could not be read from omo\b/g)?.length ?? 0) : 0);
	forgetProviderReads();
	await availableModels();
	const before = logged();
	spy.mockImplementation(((argv: string[]) => ({ stdout: new Response("").body, stderr: new Response("").body, exited: Promise.resolve(argv.includes("--list-models") ? 1 : 0), kill() {} })) as unknown as typeof Bun.spawn);
	try {
		forgetProviderReads();
		await availableModels();
		forgetProviderReads();
		await availableModels();
		expect(logged() - before).toBe(1);
	} finally {
		if (healthy) spy.mockImplementation(healthy);
		forgetProviderReads();
	}
});
