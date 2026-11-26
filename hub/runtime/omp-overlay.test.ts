import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cfg, DATA_DIR } from "../config.ts";
import { availableModels, forgetProviderReads, heldModels } from "../providers.ts";
import { writeOverlay } from "./omp-overlay.ts";
import type { SpawnOpts } from "./types.ts";

type Overlay = {
	task?: { isolation?: Record<string, unknown>; maxRuntimeMs?: number; softRequestBudget?: number; maxEffort?: string; enableEffort?: boolean };
	modelRoles?: { task?: string };
	compaction?: { idleEnabled?: boolean };
	async?: { enabled?: boolean; widgets?: boolean };
	startup?: { checkUpdate?: boolean };
	magicKeywords?: { enabled?: boolean };
	github?: { enabled?: boolean };
	secrets?: { enabled?: boolean };
	retry?: { fallbackChains?: Record<string, string[]> };
};

let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-omp-overlay-"));
	saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const orchestrator = (): SpawnOpts => ({ role: "orchestrator", cwd: DATA_DIR, model: "anthropic/test-orch:low", env: { DOTZ_ORCHESTRATOR: "1" } });
const conversation = (): SpawnOpts => ({ ...orchestrator(), env: { DOTZ_ORCHESTRATOR: "1", DOTZ_CONV: "th:7" } });
const lane = (model = "anthropic/test-lane:medium", workerModel = "anthropic/test-worker:high"): SpawnOpts => ({
	role: "lane",
	cwd: join(root, "work"),
	model,
	env: { DOTZ_LANE: "alpha" },
	lane: { name: "alpha", dir: join(DATA_DIR, "lanes", "alpha"), workerModel, compactAt: 300_000, keepRecent: 30_000 },
});
const overlayOf = (opts: SpawnOpts): Overlay => Bun.YAML.parse(readFileSync(writeOverlay(opts), "utf8")) as Overlay;

for (const [name, opts] of [["the orchestrator", orchestrator], ["a conversation session", conversation], ["a lane", lane]] as const) {
	test(`${name}'s overlay pins what the owner's own omp settings must not change: per-task isolation allowed with patch review (omp isolates only a task marked isolated, which the guard does for parallel writers), no idle compaction, async jobs, no update check, no magic keywords, no github tool, secret redaction, omp's own task budgets`, () => {
		const overlay = overlayOf(opts());
		expect(overlay.task?.isolation).toEqual({ enabled: true, apply: false, merge: "patch" });
		expect(overlay.compaction?.idleEnabled).toBe(false);
		expect(overlay.async?.enabled).toBe(true);
		expect(overlay.async?.widgets).toBe(false);
		expect(overlay.startup?.checkUpdate).toBe(false);
		expect(overlay.magicKeywords?.enabled).toBe(false);
		expect(overlay.github?.enabled).toBe(false);
		expect(overlay.secrets?.enabled).toBe(true);
		expect([overlay.task?.maxRuntimeMs, overlay.task?.softRequestBudget]).toEqual([0, 200]);
		expect(overlay.task?.enableEffort).toBe(true);
	});
}

test("workers on the process's own model at another thinking level get the task chain to themselves: the process's chain is keyed by its full selector", () => {
	const chains = (opts: SpawnOpts) => Object.keys(overlayOf(opts).retry?.fallbackChains ?? {});
	expect(chains(lane("anthropic/test-worker:low"))).toEqual(["anthropic/test-worker:low", "task"]);
	expect(chains(lane("anthropic/test-worker:high"))).toEqual(["anthropic/test-worker", "task"]);
	expect(chains(lane())).toEqual(["anthropic/test-lane", "task"]);
});

test("a worker spawned with effort hi stops at high instead of the model's max, unless the owner configured a worker role higher", () => {
	expect(overlayOf(orchestrator()).task?.maxEffort).toBe("high");
	expect(overlayOf(lane()).task?.maxEffort).toBe("high");
	expect(overlayOf(lane(undefined, "anthropic/test-worker:xhigh")).task?.maxEffort).toBe("xhigh");
});

const routesOf = (opts: SpawnOpts): Record<string, { selector: string; basis: string; score?: number; cost?: number }> => JSON.parse(readFileSync(join(dirname(writeOverlay(opts)), "omp-routes.json"), "utf8"));

for (const [name, opts] of [["the orchestrator", orchestrator], ["a conversation session", conversation], ["a lane", lane]] as const) {
	test(`${name}'s routes file has the standard route on the task role its overlay pins`, () => {
		expect(routesOf(opts()).standard?.selector).toBe(overlayOf(opts()).modelRoles?.task);
	});
}

test("a lane's routes file holds the light, standard and hard routes of its worker model: hard moves up the benchmark, light down, standard stays the configured selector", () => {
	const routes = routesOf(lane(undefined, "anthropic/claude-opus-5-5:medium"));
	expect(Object.keys(routes).sort()).toEqual(["hard", "light", "standard"]);
	expect(routes.standard).toEqual({ selector: "anthropic/claude-opus-5-5:medium", basis: "configured", score: 48.21, cost: 2.45 });
	expect(routes.hard).toEqual({ selector: "anthropic/claude-opus-5-5:high", basis: "benchmark", score: 51.84, cost: 3.46 });
	expect(routes.light?.basis).toBe("benchmark");
	expect(routes.light?.cost).toBeLessThan(2.45);
});

const routesPathOf = (opts: SpawnOpts): string => join(dirname(writeOverlay(opts)), "omp-routes.json");
const lightOf = (file: string): string => (JSON.parse(readFileSync(file, "utf8")) as { light: { selector: string } }).light.selector;

async function withModelList<T>(models: object[], run: () => Promise<T>): Promise<T> {
	const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
		const text = argv.includes("--list-models") ? "provider  model  context  max-out  thinking  images\n" : JSON.stringify({ models: models.map(m => ({ kind: "chat", reasoning: true, ...m })) });
		return { stdout: new Response(text).body, stderr: new Response("").body, exited: Promise.resolve(0), kill() {} };
	}) as unknown as typeof Bun.spawn);
	const savedRuntime = cfg.runtime;
	cfg.runtime = "omp";
	forgetProviderReads();
	try {
		return await run();
	} finally {
		spy.mockRestore();
		cfg.runtime = savedRuntime;
		forgetProviderReads();
	}
}

test("a routes file written before the gateway holds a model list is written again once the list has loaded, when the routes differ", async () => {
	await withModelList([{ selector: "anthropic/claude-haiku-5-5", provider: "anthropic", thinking: ["high"] }], async () => {
		const file = routesPathOf(lane(undefined, "anthropic/claude-opus-5-5:medium"));
		const before = lightOf(file);
		expect(heldModels()).toBeUndefined();
		await availableModels();
		expect(before).not.toBe("anthropic/claude-haiku-5-5:high");
		expect(lightOf(file)).toBe("anthropic/claude-haiku-5-5:high");
	});
});

test("a list that changes nothing leaves the routes file untouched, and a file another start replaced meanwhile is not overwritten", async () => {
	await withModelList([{ selector: "anthropic/claude-opus-5-5", provider: "anthropic" }], async () => {
		const file = routesPathOf(lane(undefined, "anthropic/claude-opus-5-5:medium"));
		const written = readFileSync(file, "utf8");
		await availableModels();
		expect(readFileSync(file, "utf8")).toBe(written);
	});
	await withModelList([{ selector: "anthropic/claude-haiku-5-5", provider: "anthropic", thinking: ["high"] }], async () => {
		const file = routesPathOf(lane(undefined, "anthropic/claude-opus-5-5:medium"));
		writeFileSync(file, "{\"newer\":true}\n");
		await availableModels();
		expect(readFileSync(file, "utf8")).toBe("{\"newer\":true}\n");
	});
});
