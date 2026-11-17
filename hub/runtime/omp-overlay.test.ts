import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeOverlay } from "./omp-overlay.ts";
import type { SpawnOpts } from "./types.ts";

type Overlay = {
	task?: { isolation?: Record<string, unknown>; maxRuntimeMs?: number; softRequestBudget?: number };
	compaction?: { idleEnabled?: boolean };
	async?: { enabled?: boolean };
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
const lane = (model = "anthropic/test-lane:medium"): SpawnOpts => ({
	role: "lane",
	cwd: join(root, "work"),
	model,
	env: { DOTZ_LANE: "alpha" },
	lane: { name: "alpha", dir: join(DATA_DIR, "lanes", "alpha"), workerModel: "anthropic/test-worker:high", compactAt: 300_000, keepRecent: 30_000 },
});
const overlayOf = (opts: SpawnOpts): Overlay => Bun.YAML.parse(readFileSync(writeOverlay(opts), "utf8")) as Overlay;

for (const [name, opts] of [["the orchestrator", orchestrator], ["a conversation session", conversation], ["a lane", lane]] as const) {
	test(`${name}'s overlay pins what the owner's own omp settings must not change: isolation with patch review, no idle compaction, async jobs, no update check, no magic keywords, no github tool, secret redaction, omp's own task budgets`, () => {
		const overlay = overlayOf(opts());
		expect(overlay.task?.isolation).toEqual({ enabled: true, apply: false, merge: "patch" });
		expect(overlay.compaction?.idleEnabled).toBe(false);
		expect(overlay.async?.enabled).toBe(true);
		expect(overlay.startup?.checkUpdate).toBe(false);
		expect(overlay.magicKeywords?.enabled).toBe(false);
		expect(overlay.github?.enabled).toBe(false);
		expect(overlay.secrets?.enabled).toBe(true);
		expect([overlay.task?.maxRuntimeMs, overlay.task?.softRequestBudget]).toEqual([0, 200]);
	});
}

test("workers on the process's own model at another thinking level get the task chain to themselves: the process's chain is keyed by its full selector", () => {
	const chains = (opts: SpawnOpts) => Object.keys(overlayOf(opts).retry?.fallbackChains ?? {});
	expect(chains(lane("anthropic/test-worker:low"))).toEqual(["anthropic/test-worker:low", "task"]);
	expect(chains(lane("anthropic/test-worker:high"))).toEqual(["anthropic/test-worker", "task"]);
	expect(chains(lane())).toEqual(["anthropic/test-lane", "task"]);
});
