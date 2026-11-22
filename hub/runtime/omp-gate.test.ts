import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cfg, DATA_DIR } from "../config.ts";
import * as l from "../lanes.ts";
import { resetLaneStateForTest, type LaneMode } from "../lanestate.ts";
import { NICE } from "./agent-proc.ts";
import { adapters } from "./index.ts";
import { EXTENSION, omp, ompArgv } from "./omp.ts";
import { advance } from "./test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./types.ts";

resetLaneStateForTest();
const patchable = Bun as unknown as { spawn: unknown };
const TMP = mkdtempSync(join(tmpdir(), "dotz-omp-gate-"));
const AGENT = join(TMP, "agent");
const PAYLOAD = join(DATA_DIR, "coding-harness");
const PAYLOAD_FILES = ["SHIPPED_FROM", "extensions/done-gate.ts", "extensions/orchestrator-guard.ts", "extensions/harness-tools.ts", "harness/gate/bootstrap.ts", "skills/x/SKILL.md", "rules/always.md", "agents/deep-reviewer.md", "AGENTS.md"];
const AGENT_FILES = ["extensions/done-gate.ts", "harness/gate/bootstrap.ts"];

const install = (dir: string, files: string[]): void => {
	for (const f of files) {
		mkdirSync(dirname(join(dir, f)), { recursive: true });
		writeFileSync(join(dir, f), "");
	}
};

type Started = { argv: string[]; env: Record<string, string | undefined> };

const lane = (name: string, extra: Partial<SpawnOpts> = {}): SpawnOpts => ({
	role: "lane",
	cwd: TMP,
	model: "anthropic/test-lane:medium",
	env: { DOTZ_LANE: name },
	lane: { name, dir: join(DATA_DIR, "lanes", name), workerModel: "anthropic/test-worker:high", compactAt: 300_000, keepRecent: 30_000 },
	...extra,
});

class FakeAgent implements AgentProcess {
	pid = 7600;
	sent: string[] = [];
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (): AsyncGenerator<AgentEvent> {})();
	send = (text: string) => void this.sent.push(text);
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}
const handed: SpawnOpts[] = [];
// The real omp adapter (its caps and argv builder) with a recorder for its start: the hub's own decision shows in what it was handed.
const probe: RuntimeAdapter = {
	...omp,
	start(opts) {
		handed.push(opts);
		return new FakeAgent();
	},
};

const savedLanes = cfg.lanes;
const savedEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "OMP_PROFILE"].map(k => [k, process.env[k]]));
let realSpawn: unknown;
let started: Started[];
const running = new Set<string>();

beforeAll(() => {
	adapters.ompprobe = probe;
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
beforeEach(() => {
	cfg.lanes = { ...savedLanes, runtime: "ompprobe", max_active: 8, min_free_disk_gb: 0 };
	process.env.PI_CODING_AGENT_DIR = AGENT;
	process.env.OMP_PROFILE = "";
	install(PAYLOAD, PAYLOAD_FILES);
	install(AGENT, AGENT_FILES);
	started = [];
	realSpawn = Bun.spawn;
	patchable.spawn = (argv: string[], opts: { env?: Record<string, string | undefined> }) => {
		started.push({ argv: argv.slice(NICE.length), env: opts.env ?? {} });
		return { pid: 4242, stdout: new ReadableStream<Uint8Array>(), stdin: { write: () => 0, flush: () => 0 }, exited: new Promise<number>(() => {}), kill() {} };
	};
});
afterEach(async () => {
	patchable.spawn = realSpawn;
	for (const n of running) l.stopLane(n);
	running.clear();
	await advance(300);
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});
afterAll(() => {
	delete adapters.ompprobe;
	cfg.lanes = savedLanes;
	rmSync(PAYLOAD, { recursive: true, force: true });
});

// What the hub hands the omp adapter for a lane started with the current settings (the lane runs in a plain folder: no worktree, no bootstrap, so it is an assistant lane unless `mode` asks for coding).
function launched(name: string, mode?: LaneMode): SpawnOpts {
	running.add(name);
	l.launch(name, TMP, "Fix the thing.\nDone when: the tests pass", undefined, undefined, undefined, undefined, undefined, undefined, mode);
	return handed.findLast(o => o.lane?.name === name)!;
}

function spawnedOf(opts: SpawnOpts): Started & { overlay: string } {
	omp.start(opts);
	const spawn = started.at(-1)!;
	const config = spawn.argv.find(a => a.startsWith("--config="))!.slice("--config=".length);
	return { ...spawn, overlay: readFileSync(config, "utf8") };
}

test("only omp declares that a lane's process can load the harness", () => {
	expect(omp.caps.doneGate).toBe(true);
	for (const id of ["omo", "claude"]) expect(adapters[id]?.caps.doneGate).toBeUndefined();
});

test("a coding lane with the payload installed and lanes.harness_gate unset is handed the payload folder, and its argv carries the payload's three extensions after dotz's own, then the folder", () => {
	expect(cfg.lanes.harness_gate).toBeUndefined();
	const opts = launched("gate-hub-on", "coding");
	expect(opts.codingHarness).toBe(PAYLOAD);
	const argv = ompArgv(opts);
	const at = argv.indexOf(EXTENSION);
	expect(argv.slice(at - 1, at + 8)).toEqual(["--extension", EXTENSION, ...["done-gate", "orchestrator-guard", "harness-tools"].flatMap(name => ["--extension", join(PAYLOAD, "extensions", `${name}.ts`)]), "--extension"]);
	expect(argv[at + 8]).toBe(PAYLOAD);
	expect(argv.filter(a => a === "--no-extensions")).toHaveLength(1);
	expect(argv.filter(a => a === "--extension")).toHaveLength(5);
});

test("the process omp.start spawns for a lane with the payload is the plain one plus the extension arguments, the payload as harness home and guard marker, and the overlay entries for its skills and AGENTS.md", () => {
	const coding = spawnedOf(lane("gate-env", { codingHarness: PAYLOAD }));
	const plain = spawnedOf(lane("gate-env"));
	expect(coding.argv.toSpliced(coding.argv.indexOf(EXTENSION) + 1, 8)).toEqual(plain.argv);
	expect(coding.env).toEqual({ ...plain.env, HARNESS_AGENT_HOME: PAYLOAD, DOTZ_CODING_HARNESS: PAYLOAD });
	expect(coding.env.DOTZ_RUNTIME).toBe("omp");
	const overlay = Bun.YAML.parse(coding.overlay) as { skills?: { customDirectories?: string[] }; workspace?: { additionalDirectories?: string[] } };
	expect(overlay.skills?.customDirectories).toEqual([join(PAYLOAD, "skills")]);
	expect(overlay.workspace?.additionalDirectories).toEqual([PAYLOAD]);
	expect(plain.overlay).not.toContain("workspace:");
});

test("an assistant lane is the same with the payload installed or not: the options the hub hands, the argv, the environment and the overlay", async () => {
	const run = async () => {
		const opts = launched("gate-assistant");
		const spawn = spawnedOf(opts);
		l.stopLane("gate-assistant");
		await advance(300);
		return { opts: JSON.stringify(opts), ...spawn };
	};
	const installed = await run();
	expect(l.lanes.get("gate-assistant")?.mode).toBe("assistant");
	rmSync(PAYLOAD, { recursive: true });
	const bare = await run();
	expect(installed).toEqual(bare);
	expect("codingHarness" in JSON.parse(installed.opts)).toBe(false);
	expect(installed.argv.filter(a => a === "--extension")).toHaveLength(1);
	for (const name of ["HARNESS_AGENT_HOME", "DOTZ_CODING_HARNESS"]) expect(installed.env).not.toHaveProperty(name);
});

test("a coding lane with the setting false, and one without the payload, are handed nothing and have dotz's extension alone, whatever the owner's omp agent folder holds", () => {
	cfg.lanes = { ...cfg.lanes, harness_gate: false };
	const off = launched("gate-hub-off", "coding");
	delete cfg.lanes.harness_gate;
	rmSync(PAYLOAD, { recursive: true });
	const missing = launched("gate-hub-none", "coding");
	for (const opts of [off, missing]) {
		expect("codingHarness" in opts).toBe(false);
		expect(ompArgv(opts).filter(a => a === "--extension")).toHaveLength(1);
		expect(ompArgv(opts).some(a => a.startsWith(AGENT))).toBe(false);
	}
	expect(readFileSync(join(AGENT, "extensions", "done-gate.ts"), "utf8")).toBe("");
});
