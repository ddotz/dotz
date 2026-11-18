import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { BOOTSTRAP_LIMIT_MS, CODING_HARNESS_ENV, excludeGenerated, type HarnessGate, harnessFiles, WORKER_GATE_AGENT_DIR_ENV } from "../extension/harness-gate.ts";
import { withoutApiKeys } from "./apikey-policy.ts";
import { codingHarnessDir } from "./coding-harness-install.ts";
import { cfg, DATA_DIR, lanesHarnessGate, log, workersHarnessGate } from "./config.ts";
import { runLimited, type Ran } from "./run-limited.ts";
import { NICE } from "./runtime/agent-proc.ts";
import type { SendMode } from "./runtime/types.ts";

/**
 * The extension files an omp process loads from a coding harness payload (a pinned copy of the owner's harness in a folder dotz
 * owns: extensions, skills, rules, agents, AGENTS.md), in load order. A payload is usable when its done-gate extension and gate
 * bootstrap exist. Not loaded from it, on purpose: session-restart (dotz restarts a session through the gateway, docs/omp-harness.md
 * section 4), model-tiers (it rewrites the owner's modelRoles; the hub picks a dotz session's model), peer-bus and loop-mode
 * (interactive sessions only; a dotz process runs `omp --mode rpc`). RULES.md is not read either: omp reads it only from its own
 * agent folder or a project's `.omp/`, so the payload ships it as a rule file with `alwaysApply: true`.
 */
export const CODING_EXTENSIONS = ["done-gate", "orchestrator-guard", "harness-tools"];

/** A usable payload: `extensions` are the files of CODING_EXTENSIONS that exist; `skills`, `rules`, `agents` and `context` (AGENTS.md) are paths, present only when they exist. */
export type CodingHarness = HarnessGate & {
	dir: string;
	extensions: string[];
	skills?: string;
	rules?: string;
	agents?: string;
	context?: string;
};

const existing = (path: string): string | undefined => (existsSync(path) ? path : undefined);

/** The payload at `dir`, or undefined when `dir` is not an absolute folder holding the gate's two files. */
export function codingHarnessFiles(dir: string): CodingHarness | undefined {
	if (!isAbsolute(dir)) return undefined;
	const gate = harnessFiles(dir);
	if (!gate) return undefined;
	return {
		...gate,
		dir,
		extensions: CODING_EXTENSIONS.map(n => join(dir, "extensions", `${n}.ts`)).filter(existsSync),
		skills: existing(join(dir, "skills")),
		rules: existing(join(dir, "rules")),
		agents: existing(join(dir, "agents")),
		context: existing(join(dir, "AGENTS.md")),
	};
}

const HARNESS_HOME_ENV = "HARNESS_AGENT_HOME";

const harnessHomeEnv = (dir: string): Record<string, string> => ({ [HARNESS_HOME_ENV]: dir });

/** The environment of a process that loads the payload at `dir`: its state lives under `dir`, and dotz's own guard copies stand down for the payload's (CODING_HARNESS_ENV). */
export function codingHarnessEnv(dir: string): Record<string, string> {
	return { ...harnessHomeEnv(dir), [CODING_HARNESS_ENV]: dir };
}

/** `env` without the two variables that name a payload: what the gateway itself inherited never reaches a process, which gets them only from the hub's own decision for it (`codingHarnessEnv`, `workerGateEnv`). */
export function withoutPayloadEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out = { ...env };
	delete out[HARNESS_HOME_ENV];
	delete out[CODING_HARNESS_ENV];
	return out;
}

const noted = new Set<string>();

function noteMissing(key: "lanes" | "workers", without: string): void {
	if (cfg[key]?.harness_gate !== true || noted.has(key)) return;
	noted.add(key);
	log(`${key}.harness_gate is true, but the coding harness dotz installs under ${DATA_DIR} at gateway start is not there, or its install did not finish (the "coding harness:" lines above say why; extensions/done-gate.ts and harness/gate/bootstrap.ts must be in it): ${without}`);
}

function installedPayload(): CodingHarness | undefined {
	const dir = codingHarnessDir(DATA_DIR);
	return dir ? codingHarnessFiles(dir) : undefined;
}

/** The installed coding harness payload a coding lane loads (hub/lanerun.ts passes it to omp as `SpawnOpts.codingHarness`); undefined when `lanes.harness_gate` is false or dotz has no finished install of it. The owner's omp agent folder is never consulted. */
export function harnessGate(): CodingHarness | undefined {
	if (!lanesHarnessGate()) return undefined;
	const payload = installedPayload();
	if (payload) return payload;
	noteMissing("lanes", "coding lanes start without it");
	return undefined;
}

/** What the omp orchestrator and conversation processes need for the done gate in their task workers: the installed payload as `DOTZ_WORKER_GATE` and as the gate's home. {} when the runtime cannot load the gate, `workers.harness_gate` is false or the payload is not installed. */
export function workerGateEnv(caps: { doneGate?: boolean }): Record<string, string> {
	if (!caps.doneGate || !workersHarnessGate()) return {};
	const payload = installedPayload();
	if (payload) return { [WORKER_GATE_AGENT_DIR_ENV]: payload.dir, ...harnessHomeEnv(payload.dir) };
	noteMissing("workers", "task workers run without the done gate");
	return {};
}

// The script's own words, on one log line.
const said = (r: Ran): string => ` (${[r.stdout, r.stderr].join("\n").trim().replace(/\s*\n\s*/g, " | ").slice(0, 300) || "no output"})`;

// Never throws: the lane starts whatever the bootstrap did.
async function bootstrap(gate: CodingHarness, lane: string, worktree: string): Promise<void> {
	const started = Date.now();
	try {
		excludeGenerated(worktree);
		const r = await runLimited([...NICE, process.execPath, gate.bootstrap, worktree], BOOTSTRAP_LIMIT_MS, { cwd: worktree, env: withoutApiKeys({ ...withoutPayloadEnv(process.env), ...harnessHomeEnv(gate.dir) }) });
		log(`lane ${lane}: harness bootstrap ${r.timedOut ? "timed out" : `exited ${r.code}`} after ${Math.round((Date.now() - started) / 1000)} s${said(r)}`);
	} catch (e) {
		log(`lane ${lane}: harness bootstrap not run: ${(e as Error).message}`);
	}
}

// One bootstrap at a time per worktree: a lane started again while the first still runs waits for that one.
const running = new Map<string, Promise<void>>();
function bootstrapOnce(gate: CodingHarness, lane: string, worktree: string): Promise<void> {
	let run = running.get(worktree);
	if (!run) {
		run = bootstrap(gate, lane, worktree).finally(() => running.delete(worktree));
		running.set(worktree, run);
	}
	return run;
}

/**
 * For a lane's fresh session (not a resume) in a worktree that has no `.omp/gate.json`: starts the harness's bootstrap there at once, while the
 * process starts up, and holds back every message to `proc` until it is done (or killed at BOOTSTRAP_LIMIT_MS), in the order they were sent, so
 * the first prompt starts a turn that finds the gate file in place. Any other lane (no worktree, a gate file already there) gets `proc` untouched.
 */
export function gateBootstrap<P extends { send(text: string, mode: SendMode): void }>(proc: P, gate: CodingHarness, lane: { name: string; worktree?: { path: string } }): P {
	const worktree = lane.worktree?.path;
	if (!worktree || !existsSync(worktree) || existsSync(join(worktree, ".omp", "gate.json"))) return proc;
	const send = proc.send.bind(proc);
	let held: [string, SendMode][] | undefined = [];
	proc.send = (text, mode) => (held ? void held.push([text, mode]) : send(text, mode));
	void bootstrapOnce(gate, lane.name, worktree).then(() => {
		const queued = held ?? [];
		held = undefined;
		for (const [text, mode] of queued) send(text, mode);
	});
	return proc;
}
