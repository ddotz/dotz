// The harness's done gate in dotz lanes. Off unless `lanes.harness_gate` is true (hub/config.ts). On, and with the harness installed, an omp lane loads
// the gate's extension beside dotz's own (hub/runtime/omp.ts reads SpawnOpts.doneGate), and the bootstrap of the lane's fresh worktree runs before
// its first prompt: the gate then finds its gate file, or the record that no check passes, and has no reason to ask the model to bootstrap.
// The harness belongs to the owner: none of its files is read or changed here. It counts as installed when its extension and its bootstrap script both
// exist in the omp agent folder. The script runs as a command (`bun <script> <worktree>`): it writes `.omp/gate.json` and `.omp/lint/` into the worktree
// and its own state into the gate's state folder, the same one the lane's gate reads (DONE_GATE_STATE_DIR).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withoutApiKeys } from "./apikey-policy.ts";
import { lanesHarnessGate, log } from "./config.ts";
import { git } from "./lanetree.ts";
import { ompAgentDir } from "./omp-dirs.ts";
import { runLimited, type Ran } from "./run-limited.ts";
import { NICE } from "./runtime/agent-proc.ts";
import { homeDir } from "./runtime/omp-overlay.ts";
import type { SendMode } from "./runtime/types.ts";

export type HarnessGate = { extension: string; bootstrap: string };

// The harness's own budget for a bootstrap is 90 s; the first prompt waits for it, and a lane whose prompt starts no turn within 120 s is restarted
// (WATCHDOG_MS in hub/laneprompt.ts), so a hung script is killed well before that.
export const BOOTSTRAP_LIMIT_MS = 100_000;

let missingNoted = false;

/** The harness's two files in the omp agent folder when `lanes.harness_gate` is on and both exist; undefined when it is off or the harness is not installed. */
export function harnessGate(): HarnessGate | undefined {
	if (!lanesHarnessGate()) return undefined;
	const agent = ompAgentDir(process.env, homeDir());
	const gate = { extension: join(agent, "extensions", "done-gate.ts"), bootstrap: join(agent, "harness", "gate", "bootstrap.ts") };
	if (existsSync(gate.extension) && existsSync(gate.bootstrap)) return gate;
	if (!missingNoted) log(`lanes.harness_gate is on, but the harness is not installed in ${agent} (extensions/done-gate.ts and harness/gate/bootstrap.ts): lanes start without its done gate`);
	missingNoted = true;
	return undefined;
}

// What the bootstrap writes into a worktree. Left out of `git status` and `git add -A` through the repo's info/exclude, so a lane cannot commit
// them and the lane's merge check does not count them as uncommitted work. A path the repo tracks at HEAD is the repo's own and stays as it is.
const GENERATED = [
	{ path: ".omp/gate.json", line: "/.omp/gate.json" },
	{ path: ".omp/lint", line: "/.omp/lint/" },
];

// info/exclude is shared by every worktree of the repo; a line that is already in it is not added again. Throws when the file cannot be written.
function excludeGenerated(worktree: string): void {
	const file = git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
	if (!file.ok || !file.out) return;
	let text = "";
	try {
		text = readFileSync(file.out, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // a repo that has no exclude file yet gets one below
	}
	const have = new Set(text.split("\n").map(l => l.trim()));
	const add = GENERATED.filter(g => !have.has(g.line) && !git(worktree, "ls-tree", "-r", "--name-only", "HEAD", "--", g.path).out).map(g => g.line);
	if (!add.length) return;
	mkdirSync(dirname(file.out), { recursive: true });
	appendFileSync(file.out, `${text && !text.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
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
