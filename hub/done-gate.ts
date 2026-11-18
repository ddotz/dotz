// The harness's done gate in dotz lanes. Off unless `lanes.harness_gate` is true (hub/config.ts). On, and with the harness installed, an omp lane loads
// the gate's extension beside dotz's own (hub/runtime/omp.ts reads SpawnOpts.doneGate), and the bootstrap of the lane's fresh worktree runs before
// its first prompt: the gate then finds its gate file, or the record that no check passes, and has no reason to ask the model to bootstrap.
// The harness belongs to the owner: none of its files is read or changed here. It counts as installed when its extension and its bootstrap script both
// exist in the omp agent folder. The script runs as a command (`bun <script> <worktree>`): it writes `.omp/gate.json` and `.omp/lint/` into the worktree
// and its own state into the gate's state folder, the same one the lane's gate reads (DONE_GATE_STATE_DIR).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BOOTSTRAP_LIMIT_MS, excludeGenerated, type HarnessGate, harnessFiles, WORKER_GATE_AGENT_DIR_ENV } from "../extension/harness-gate.ts";
import { withoutApiKeys } from "./apikey-policy.ts";
import { lanesHarnessGate, log, workersHarnessGate } from "./config.ts";
import { ompAgentDir } from "./omp-dirs.ts";
import { runLimited, type Ran } from "./run-limited.ts";
import { NICE } from "./runtime/agent-proc.ts";
import { homeDir } from "./runtime/omp-overlay.ts";
import type { SendMode } from "./runtime/types.ts";

let missingNoted = false;
let workersMissingNoted = false;

/** The harness's two files in the omp agent folder when `lanes.harness_gate` is on and both exist; undefined when it is off or the harness is not installed. */
export function harnessGate(): HarnessGate | undefined {
	if (!lanesHarnessGate()) return undefined;
	const agent = ompAgentDir(process.env, homeDir());
	const gate = harnessFiles(agent);
	if (gate) return gate;
	if (!missingNoted) log(`lanes.harness_gate is on, but the harness is not installed in ${agent} (extensions/done-gate.ts and harness/gate/bootstrap.ts): lanes start without its done gate`);
	missingNoted = true;
	return undefined;
}

export function workerGateEnv(caps: { doneGate?: boolean }): Record<string, string> {
	if (!caps.doneGate || !workersHarnessGate()) return {};
	const agent = ompAgentDir(process.env, homeDir());
	if (harnessFiles(agent)) return { [WORKER_GATE_AGENT_DIR_ENV]: agent };
	if (!workersMissingNoted) log(`workers.harness_gate is on, but the harness is not installed in ${agent} (extensions/done-gate.ts and harness/gate/bootstrap.ts): task workers run without its done gate`);
	workersMissingNoted = true;
	return {};
}

// The script's own words, on one log line.
const said = (r: Ran): string => ` (${[r.stdout, r.stderr].join("\n").trim().replace(/\s*\n\s*/g, " | ").slice(0, 300) || "no output"})`;

// Never throws: the lane starts whatever the bootstrap did.
async function bootstrap(gate: HarnessGate, lane: string, worktree: string): Promise<void> {
	const started = Date.now();
	try {
		excludeGenerated(worktree);
		const r = await runLimited([...NICE, process.execPath, gate.bootstrap, worktree], BOOTSTRAP_LIMIT_MS, { cwd: worktree, env: withoutApiKeys({ ...process.env }) });
		log(`lane ${lane}: harness bootstrap ${r.timedOut ? "timed out" : `exited ${r.code}`} after ${Math.round((Date.now() - started) / 1000)} s${said(r)}`);
	} catch (e) {
		log(`lane ${lane}: harness bootstrap not run: ${(e as Error).message}`);
	}
}

// One bootstrap at a time per worktree: a lane started again while the first still runs waits for that one.
const running = new Map<string, Promise<void>>();
function bootstrapOnce(gate: HarnessGate, lane: string, worktree: string): Promise<void> {
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
export function gateBootstrap<P extends { send(text: string, mode: SendMode): void }>(proc: P, gate: HarnessGate, lane: { name: string; worktree?: { path: string } }): P {
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
