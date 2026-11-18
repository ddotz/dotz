import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKER_GATE_AGENT_DIR_ENV } from "../../extension/harness-gate.ts";
import { cfg, DATA_DIR } from "../config.ts";
import { workerGateEnv } from "../done-gate.ts";
import { NICE } from "./agent-proc.ts";
import { adapters } from "./index.ts";
import { omoArgs } from "./omo.ts";
import { omp, ompArgv } from "./omp.ts";
import type { SpawnOpts } from "./types.ts";

const patchable = Bun as unknown as { spawn: unknown };
const TMP = mkdtempSync(join(tmpdir(), "dotz-omp-worker-gate-"));
const AGENT = join(TMP, "agent");
const savedWorkers = cfg.workers;
const savedEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "OMP_PROFILE"].map(k => [k, process.env[k]]));
let realSpawn: unknown;
let started: { argv: string[]; env: Record<string, string | undefined> }[];

const orchestratorOpts = (caps: { doneGate?: boolean }): SpawnOpts => ({ role: "orchestrator", cwd: DATA_DIR, model: "anthropic/test-orch:low", env: { DOTZ_ORCHESTRATOR: "1", ...workerGateEnv(caps) } });
const setting = (on: boolean | undefined) => void (cfg.workers = on === undefined ? undefined : { harness_gate: on });
const installHarness = () => {
	for (const f of [join(AGENT, "extensions", "done-gate.ts"), join(AGENT, "harness", "gate", "bootstrap.ts")]) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, "");
	}
};

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = AGENT;
	process.env.OMP_PROFILE = "";
	installHarness();
	started = [];
	realSpawn = Bun.spawn;
	patchable.spawn = (argv: string[], opts: { env?: Record<string, string | undefined> }) => {
		started.push({ argv: argv.slice(NICE.length), env: opts.env ?? {} });
		return { pid: 4243, stdout: new ReadableStream<Uint8Array>(), stdin: { write: () => 0, flush: () => 0 }, exited: new Promise<number>(() => {}), kill() {} };
	};
});
afterEach(() => {
	patchable.spawn = realSpawn;
	cfg.workers = savedWorkers;
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});
afterAll(() => {
	cfg.workers = savedWorkers;
});

test("with the harness installed and omp's caps, a missing or true workers.harness_gate makes the hub name the omp agent folder, and omp.start hands it to the process", () => {
	for (const on of [undefined, true]) {
		setting(on);
		expect(workerGateEnv(omp.caps)).toEqual({ [WORKER_GATE_AGENT_DIR_ENV]: AGENT });
	}
	omp.start(orchestratorOpts(omp.caps));
	expect(started[0]?.env[WORKER_GATE_AGENT_DIR_ENV]).toBe(AGENT);
	expect(started[0]?.env.DOTZ_ORCHESTRATOR).toBe("1");
});

test("workers.harness_gate false, or the harness not installed, names nothing and nothing throws", () => {
	setting(false);
	expect(workerGateEnv(omp.caps)).toEqual({});
	setting(undefined);
	process.env.PI_CODING_AGENT_DIR = join(TMP, "no-harness-here");
	expect(workerGateEnv(omp.caps)).toEqual({});
	expect(workerGateEnv(omp.caps)).toEqual({});
	omp.start(orchestratorOpts(omp.caps));
	expect(WORKER_GATE_AGENT_DIR_ENV in (started[0]?.env ?? {})).toBe(false);
});

test("a runtime without the done gate cap gets nothing with the setting on, and its orchestrator argv and environment are the same on or off", () => {
	const omo = adapters.omo!;
	expect(omo.caps.doneGate).toBeUndefined();
	setting(false);
	const off = orchestratorOpts(omo.caps);
	setting(true);
	const on = orchestratorOpts(omo.caps);
	expect(workerGateEnv(omo.caps)).toEqual({});
	expect(on).toEqual(off);
	expect(omoArgs(on)).toEqual(omoArgs(off));
});

test("the omp orchestrator argv is the same on or off: the gate goes by the environment alone, never by --extension", () => {
	setting(false);
	const off = ompArgv(orchestratorOpts(omp.caps));
	setting(true);
	const on = ompArgv(orchestratorOpts(omp.caps));
	expect(on).toEqual(off);
	expect(on.filter(a => a === "--extension")).toHaveLength(1);
});
