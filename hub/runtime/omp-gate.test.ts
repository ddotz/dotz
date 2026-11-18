// The omp end of the harness done gate (hub/done-gate.ts): a lane's omp process loads the gate's extension right after dotz's own when the hub names it,
// and no other role does. The hub names it only with lanes.harness_gate on and the harness installed in the omp agent folder (the stub files here).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cfg, DATA_DIR } from "../config.ts";
import * as l from "../lanes.ts";
import { resetLaneStateForTest } from "../lanestate.ts";
import { NICE } from "./agent-proc.ts";
import { adapters } from "./index.ts";
import { EXTENSION, omp, ompArgv } from "./omp.ts";
import { advance } from "./test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./types.ts";

resetLaneStateForTest();
const patchable = Bun as unknown as { spawn: unknown };
const TMP = mkdtempSync(join(tmpdir(), "dotz-omp-gate-"));
const AGENT = join(TMP, "agent");
const GATE = join(AGENT, "extensions", "done-gate.ts");

type Started = { argv: string[]; env: Record<string, string | undefined> };

const orchestrator = (extra: Partial<SpawnOpts> = {}): SpawnOpts => ({ role: "orchestrator", cwd: DATA_DIR, model: "anthropic/test-orch:low", env: { DOTZ_ORCHESTRATOR: "1" }, ...extra });
const conversation = (key: string, extra: Partial<SpawnOpts> = {}): SpawnOpts => orchestrator({ env: { DOTZ_ORCHESTRATOR: "1", DOTZ_CONV: key }, ...extra });
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
	cfg.lanes = { ...savedLanes, runtime: "ompprobe", harness_gate: true, max_active: 8, min_free_disk_gb: 0 };
	process.env.PI_CODING_AGENT_DIR = AGENT;
	process.env.OMP_PROFILE = "";
	for (const f of [GATE, join(AGENT, "harness", "gate", "bootstrap.ts")]) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, "");
	}
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
});

// What the hub hands the omp adapter for a lane started with the current settings (the lane runs in a plain folder: no worktree, no bootstrap).
function launched(name: string): SpawnOpts {
	running.add(name);
	l.launch(name, TMP, "Fix the thing.\nDone when: the tests pass");
	return handed.findLast(o => o.lane?.name === name)!;
}

test("only omp declares that a lane's process can load the gate", () => {
	expect(omp.caps.doneGate).toBe(true);
	for (const id of ["omo", "claude"]) expect(adapters[id]?.caps.doneGate).toBeUndefined();
});

test("a lane handed the gate extension loads it right after dotz's own and keeps --no-extensions; no other role does", () => {
	const plain = ompArgv(lane("gate-argv"));
	const at = plain.indexOf(EXTENSION);
	const gated = ompArgv(lane("gate-argv", { doneGate: GATE }));
	expect(gated).toEqual([...plain.slice(0, at + 1), "--extension", GATE, ...plain.slice(at + 1)]);
	expect(gated.filter(a => a === "--no-extensions")).toHaveLength(1);
	expect(plain.filter(a => a === "--extension")).toHaveLength(1);
	for (const o of [orchestrator(), conversation("c1")]) expect(ompArgv({ ...o, doneGate: GATE })).toEqual(ompArgv(o));
});

test("the process omp.start spawns for a lane differs from the plain one by that argument only: same environment, same everything else", () => {
	omp.start(lane("gate-env", { doneGate: GATE }));
	omp.start(lane("gate-env"));
	const [gated, plain] = started as [Started, Started];
	expect(gated.argv.filter(a => a === "--extension")).toHaveLength(2);
	expect(gated.argv.toSpliced(gated.argv.indexOf(GATE) - 1, 2)).toEqual(plain.argv);
	expect(gated.env).toEqual(plain.env);
	expect(gated.env.DOTZ_RUNTIME).toBe("omp");
});

test("on with the harness installed, the hub hands a lane's omp process the gate extension, and its argv has it after dotz's own", () => {
	const opts = launched("gate-hub-on");
	expect(opts.doneGate).toBe(GATE);
	const argv = ompArgv(opts);
	expect(argv.slice(argv.indexOf(EXTENSION) - 1, argv.indexOf(EXTENSION) + 3)).toEqual(["--extension", EXTENSION, "--extension", GATE]);
});

test("off, or on without the harness, the hub hands nothing and the argv has dotz's extension alone", () => {
	cfg.lanes = { ...cfg.lanes, harness_gate: false };
	const off = launched("gate-hub-off");
	cfg.lanes = { ...cfg.lanes, harness_gate: true };
	process.env.PI_CODING_AGENT_DIR = join(TMP, "no-harness-here");
	const missing = launched("gate-hub-none");
	for (const opts of [off, missing]) {
		expect("doneGate" in opts).toBe(false);
		expect(ompArgv(opts).filter(a => a === "--extension")).toHaveLength(1);
	}
});
