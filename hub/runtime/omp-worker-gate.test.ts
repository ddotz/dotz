import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const PAYLOAD = join(DATA_DIR, "coding-harness");
const HOME = mkdtempSync(join(tmpdir(), "dotz-omp-worker-gate-home-"));
const savedWorkers = cfg.workers;
const savedEnv = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "HARNESS_AGENT_HOME"].map(k => [k, process.env[k]]));
let realSpawn: unknown;
let started: { argv: string[]; env: Record<string, string | undefined> }[];

const orchestratorOpts = (caps: { doneGate?: boolean }): SpawnOpts => ({ role: "orchestrator", cwd: DATA_DIR, model: "anthropic/test-orch:low", env: { DOTZ_ORCHESTRATOR: "1", ...workerGateEnv(caps) } });
const setting = (on: boolean | undefined) => void (cfg.workers = on === undefined ? undefined : { harness_gate: on });
const installPayload = () => {
	for (const f of [join(PAYLOAD, "SHIPPED_FROM"), join(PAYLOAD, "extensions", "done-gate.ts"), join(PAYLOAD, "harness", "gate", "bootstrap.ts")]) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, "");
	}
};

beforeEach(() => {
	process.env.HOME = HOME;
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.HARNESS_AGENT_HOME;
	installPayload();
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
	rmSync(PAYLOAD, { recursive: true, force: true });
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});
afterAll(() => {
	cfg.workers = savedWorkers;
	rmSync(HOME, { recursive: true, force: true });
});

test("with the payload installed and omp's caps, a missing or true workers.harness_gate names the payload as the worker gate and as the gate's home, and omp.start hands both to the process", () => {
	for (const on of [undefined, true]) {
		setting(on);
		expect(workerGateEnv(omp.caps)).toEqual({ [WORKER_GATE_AGENT_DIR_ENV]: PAYLOAD, HARNESS_AGENT_HOME: PAYLOAD });
	}
	omp.start(orchestratorOpts(omp.caps));
	expect(started[0]?.env[WORKER_GATE_AGENT_DIR_ENV]).toBe(PAYLOAD);
	expect(started[0]?.env.HARNESS_AGENT_HOME).toBe(PAYLOAD);
	expect(started[0]?.env.DOTZ_ORCHESTRATOR).toBe("1");
	expect("DOTZ_CODING_HARNESS" in (started[0]?.env ?? {})).toBe(false);
});

test("the gate a worker imports from the payload keeps its state under the payload, never under the user's ~/.omp/agent", async () => {
	setting(true);
	const handed = workerGateEnv(omp.caps);
	const { agentHome } = await import("../../vendor/coding-harness/harness/agent-home.ts");
	process.env.HARNESS_AGENT_HOME = handed.HARNESS_AGENT_HOME;
	expect(agentHome()).toBe(PAYLOAD);
});

test("workers.harness_gate false, or the payload not installed, names nothing; the user's agent folder holding a harness is never used", () => {
	setting(false);
	expect(workerGateEnv(omp.caps)).toEqual({});
	setting(undefined);
	rmSync(PAYLOAD, { recursive: true, force: true });
	const agent = join(HOME, ".omp", "agent");
	for (const f of [join(agent, "extensions", "done-gate.ts"), join(agent, "harness", "gate", "bootstrap.ts")]) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, "");
	}
	expect(workerGateEnv(omp.caps)).toEqual({});
	omp.start(orchestratorOpts(omp.caps));
	expect(WORKER_GATE_AGENT_DIR_ENV in (started[0]?.env ?? {})).toBe(false);
	expect("HARNESS_AGENT_HOME" in (started[0]?.env ?? {})).toBe(false);
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

test("the omp orchestrator argv is the same on or off: the worker gate goes by the environment alone, never by --extension", () => {
	setting(false);
	const off = ompArgv(orchestratorOpts(omp.caps));
	setting(true);
	const on = ompArgv(orchestratorOpts(omp.caps));
	expect(on).toEqual(off);
	expect(on.filter(a => a === "--extension")).toHaveLength(1);
});
