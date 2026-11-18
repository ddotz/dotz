// The harness's done gate in lanes (hub/done-gate.ts): off unless `lanes.harness_gate` is on and the harness is installed. A lane's fresh session in a
// worktree without a gate file waits for the harness's bootstrap before its first prompt; a failing or hanging bootstrap never keeps the lane waiting.
// The harness is a stub here: a script in a temp omp agent folder that records its calls and writes the files the real one writes.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BOOTSTRAP_LIMIT_MS } from "../extension/harness-gate.ts";
import { cfg, paths } from "./config.ts";
import { gateBootstrap, harnessGate } from "./done-gate.ts";
import * as l from "./lanes.ts";
import { resetLaneStateForTest } from "./lanestate.ts";
import { git } from "./lanetree.ts";
import { adapters } from "./runtime/index.ts";
import { omo, omoArgs } from "./runtime/omo.ts";
import { omp } from "./runtime/omp.ts";
import { advance, realClearTimeout, realSetTimeout } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

resetLaneStateForTest();
const DATA = process.env.DOTZ_DIR!;
const TMP = mkdtempSync(join(tmpdir(), "dotz-done-gate-"));
const AGENT = join(TMP, "agent");
const EXTENSION = join(AGENT, "extensions", "done-gate.ts");
const BOOTSTRAP = join(AGENT, "harness", "gate", "bootstrap.ts");
const STUB_LOG = join(TMP, "stub.log");

// What the real script does for a repo: it takes the worktree path, writes the gate file and the lint kit, and tells what it did.
const STUB = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const repo = process.argv[2];
appendFileSync(process.env.GATE_STUB_LOG, repo + "\\n");
if (process.env.GATE_STUB_MODE === "hang") setInterval(() => {}, 1000);
else if (process.env.GATE_STUB_MODE === "fail") {
	console.error("no check could run");
	process.exit(3);
} else {
	mkdirSync(join(repo, ".omp", "lint"), { recursive: true });
	writeFileSync(join(repo, ".omp", "gate.json"), "{}\\n");
	writeFileSync(join(repo, ".omp", "lint", "sgconfig.yml"), "ruleDirs: []\\n");
	console.log("bootstrap " + repo + ": created");
}
`;

// Puts the harness's files (the stub for the script) into an omp agent folder.
function install(agent: string, files = ["extensions/done-gate.ts", "harness/gate/bootstrap.ts"]): void {
	for (const f of files) {
		mkdirSync(dirname(join(agent, f)), { recursive: true });
		writeFileSync(join(agent, f), f.endsWith("bootstrap.ts") ? STUB : "");
	}
}

class FakeAgent implements AgentProcess {
	pid = 7500;
	// Whether the gate file was already in the worktree when each message arrived.
	sent: { text: string; mode: SendMode; gateFile: boolean }[] = [];
	readonly first = Promise.withResolvers<void>();
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (): AsyncGenerator<AgentEvent> {})();
	constructor(readonly cwd: string) {}
	send = (text: string, mode: SendMode) => {
		this.sent.push({ text, mode, gateFile: existsSync(join(this.cwd, ".omp", "gate.json")) });
		this.first.resolve();
	};
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}

const spawns: { opts: SpawnOpts; agent: FakeAgent }[] = [];
function record(opts: SpawnOpts): AgentProcess {
	const agent = new FakeAgent(opts.cwd);
	spawns.push({ opts, agent });
	return agent;
}
const caps: RuntimeAdapter["caps"] = { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false };
// A runtime that loads the gate (as omp does), and OmO's own adapter with only its start swapped for the recorder: its caps and argv stay the real ones.
const fakes: Record<string, RuntimeAdapter> = {
	fakegate: { id: "omo", caps: { ...caps, doneGate: true }, start: record, classifyError: omp.classifyError, recentExchanges: () => undefined, detect: async () => ({ installed: true }) },
	fakeomo: { ...omo, start: record },
};

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "GATE_STUB_LOG", "GATE_STUB_MODE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const savedLanes = cfg.lanes;
const running = new Set<string>();

beforeAll(() => {
	Object.assign(adapters, fakes);
	install(AGENT);
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
beforeEach(() => {
	// max_active and min_free_disk_gb keep this machine's memory and disk from queueing the lanes of a test.
	cfg.lanes = { ...savedLanes, runtime: "fakegate", harness_gate: true, max_active: 8, min_free_disk_gb: 0 };
	process.env.PI_CODING_AGENT_DIR = AGENT;
	process.env.OMP_PROFILE = ""; // no named profile, whatever the developer's shell has
	process.env.GATE_STUB_LOG = STUB_LOG;
	process.env.GATE_STUB_MODE = "ok";
	writeFileSync(STUB_LOG, "");
});
afterEach(async () => {
	for (const n of running) l.stopLane(n);
	running.clear();
	await advance(300);
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});
afterAll(() => {
	for (const id of Object.keys(fakes)) delete adapters[id];
	cfg.lanes = savedLanes;
});

function repoWith(files: Record<string, string> = { "a.txt": "1\n" }): string {
	const repo = mkdtempSync(join(TMP, "repo-"));
	git(repo, "init", "-q", "-b", "main");
	for (const [f, text] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, f)), { recursive: true });
		writeFileSync(join(repo, f), text);
	}
	git(repo, "add", "-A");
	expect(git(repo, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "one").ok).toBe(true);
	return repo;
}
const exclude = (repo: string) => readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
// The worktree paths the stub was started with, oldest first.
const calls = () => readFileSync(STUB_LOG, "utf8").split("\n").filter(Boolean);
// What the hub log gets from now on.
function hubLog(): () => string {
	const from = existsSync(paths.log) ? statSync(paths.log).size : 0;
	return () => readFileSync(paths.log).subarray(from).toString("utf8");
}
// A wait on a real child process, with a deadline that names the step.
function within<T>(p: Promise<T>, what: string): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const timer = realSetTimeout(() => reject(new Error(`${what} never came`)), 10_000);
	p.then(resolve, reject).finally(() => realClearTimeout(timer));
	return promise;
}

function launch(name: string, cwd: string) {
	running.add(name);
	const lane = l.launch(name, cwd, "Fix the thing.\nDone when: the tests pass");
	return { lane, ...spawns.findLast(s => s.opts.lane?.name === name)! };
}

test("off unless lanes.harness_gate is on: no extension handed to the process, no bootstrap, the first prompt goes at once", () => {
	delete cfg.lanes.harness_gate;
	expect(harnessGate()).toBeUndefined();
	const { opts, agent } = launch("gate-off", repoWith());
	expect("doneGate" in opts).toBe(false);
	expect(agent.sent).toHaveLength(1);
	expect(calls()).toEqual([]);
});

test("on with the harness installed: the process gets the gate extension, and the first prompt waits until the bootstrap has written the gate file", async () => {
	expect(harnessGate()).toEqual({ extension: EXTENSION, bootstrap: BOOTSTRAP });
	const { lane, opts, agent } = launch("gate-on", repoWith());
	expect(opts.doneGate).toBe(EXTENSION);
	expect(agent.sent).toHaveLength(0);
	await within(agent.first.promise, "the first prompt");
	expect(agent.sent).toHaveLength(1);
	expect(agent.sent[0]!.text).toContain("Fix the thing.");
	expect(agent.sent[0]!.gateFile).toBe(true);
	expect(calls()).toEqual([lane.worktree!.path]);
});

test("the files the bootstrap writes stay out of git status; info/exclude gets its two lines once, however many lanes the repo has", async () => {
	const repo = repoWith();
	const first = launch("gate-ex-1", repo);
	await within(first.agent.first.promise, "the first lane's prompt");
	const second = launch("gate-ex-2", repo);
	await within(second.agent.first.promise, "the second lane's prompt");
	expect(exclude(repo).split("\n").filter(x => x.startsWith("/.omp/"))).toEqual(["/.omp/gate.json", "/.omp/lint/"]);
	for (const lane of [first.lane, second.lane]) {
		expect(existsSync(join(lane.worktree!.path, ".omp", "lint", "sgconfig.yml"))).toBe(true);
		expect(git(lane.worktree!.path, "status", "--porcelain").out).toBe("");
	}
});

test("an exclude file without a final newline keeps its line, and a path the repo tracks at HEAD is not excluded", async () => {
	const repo = repoWith({ "a.txt": "1\n", ".omp/lint/rules/r.yml": "id: r\n" });
	writeFileSync(join(repo, ".git", "info", "exclude"), "# mine");
	const { lane, agent } = launch("gate-ex-tracked", repo);
	await within(agent.first.promise, "the first prompt");
	expect(exclude(repo)).toBe("# mine\n/.omp/gate.json\n");
	expect(git(lane.worktree!.path, "status", "--porcelain").out).toBe("?? .omp/lint/sgconfig.yml");
});

test("a worktree that already has the gate file is left alone: no bootstrap, no hold, no exclude line", () => {
	const repo = repoWith({ "a.txt": "1\n", ".omp/gate.json": "{}\n" });
	const before = exclude(repo);
	const { opts, agent } = launch("gate-has", repo);
	expect(opts.doneGate).toBe(EXTENSION);
	expect(agent.sent).toHaveLength(1);
	expect(calls()).toEqual([]);
	expect(exclude(repo)).toBe(before);
});

test("a harness that is not installed, or only half of it, does nothing", () => {
	const empty = mkdtempSync(join(TMP, "empty-agent-"));
	const half = mkdtempSync(join(TMP, "half-agent-"));
	install(half, ["extensions/done-gate.ts"]);
	for (const agent of [empty, half]) {
		process.env.PI_CODING_AGENT_DIR = agent;
		expect(harnessGate()).toBeUndefined();
	}
	const { opts, agent } = launch("gate-none", repoWith());
	expect("doneGate" in opts).toBe(false);
	expect(agent.sent).toHaveLength(1);
	expect(calls()).toEqual([]);
});

test("the agent folder is the one omp itself uses: a named profile lives under the home folder's .omp/profiles", () => {
	const home = mkdtempSync(join(TMP, "home-"));
	install(join(home, ".omp", "profiles", "work", "agent"));
	process.env.HOME = home;
	process.env.OMP_PROFILE = "work";
	expect(harnessGate()?.extension).toBe(join(home, ".omp", "profiles", "work", "agent", "extensions", "done-gate.ts"));
});

test("a bootstrap that fails still lets the lane start; the exit code and the script's words go to the hub log", async () => {
	process.env.GATE_STUB_MODE = "fail";
	const said = hubLog();
	const { lane, agent } = launch("gate-fail", repoWith());
	await within(agent.first.promise, "the first prompt");
	expect(agent.sent[0]!.gateFile).toBe(false);
	expect(calls()).toEqual([lane.worktree!.path]);
	expect(said()).toContain("lane gate-fail: harness bootstrap exited 3");
	expect(said()).toContain("no check could run");
});

test("a bootstrap that hangs is killed at the limit, and the lane starts then, not before", async () => {
	process.env.GATE_STUB_MODE = "hang";
	const said = hubLog();
	const { agent } = launch("gate-hang", repoWith());
	await advance(BOOTSTRAP_LIMIT_MS - 1000);
	expect(agent.sent).toHaveLength(0);
	await advance(1000);
	await within(agent.first.promise, "the first prompt after the limit");
	expect(agent.sent).toHaveLength(1);
	expect(said()).toContain("lane gate-hang: harness bootstrap timed out");
});

test("a lane that resumes its session is not bootstrapped again, and still loads the gate", async () => {
	process.env.GATE_STUB_MODE = "fail";
	const { lane, agent } = launch("gate-resume", repoWith());
	await within(agent.first.promise, "the first prompt");
	const session = join(DATA, "omo-agent", "sessions", "gate-resume.jsonl");
	mkdirSync(dirname(session), { recursive: true });
	writeFileSync(session, "");
	lane.sessionFile = session;
	l.stopLane("gate-resume");
	await advance(300);
	const before = spawns.length;
	l.sendToLane("gate-resume", "[owner via Discord] one more tweak");
	expect(spawns).toHaveLength(before + 1);
	const resumed = spawns.at(-1)!;
	expect(resumed.opts.resume).toBe(session);
	expect(resumed.opts.doneGate).toBe(EXTENSION);
	expect(resumed.agent.sent).toHaveLength(1);
	expect(calls()).toHaveLength(1);
});

test("messages to a held process go in the order they were sent once the bootstrap is done, later ones go straight through, and a worktree gets one bootstrap", async () => {
	const worktree = repoWith();
	const gate = harnessGate()!;
	const sent: string[] = [];
	const done = Promise.withResolvers<void>();
	const proc = () => ({
		send: (text: string, mode: SendMode) => {
			sent.push(`${mode}:${text}`);
			if (sent.length === 3) done.resolve();
		},
	});
	const a = gateBootstrap(proc(), gate, { name: "gate-a", worktree: { path: worktree } });
	const b = gateBootstrap(proc(), gate, { name: "gate-b", worktree: { path: worktree } });
	a.send("one", "prompt");
	a.send("two", "steer");
	b.send("other", "prompt");
	expect(sent).toEqual([]);
	await within(done.promise, "the held messages");
	expect(sent).toEqual(["prompt:one", "steer:two", "prompt:other"]);
	a.send("three", "followUp");
	expect(sent.at(-1)).toBe("followUp:three");
	expect(calls()).toEqual([worktree]);
});

test("OmO lanes are untouched: with the setting on and the harness installed, a lane's spawn options, argv and prompt equal those with it off", async () => {
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	const repo = repoWith();
	const run = async (on: boolean) => {
		cfg.lanes = { ...cfg.lanes, harness_gate: on };
		const { opts, agent } = launch("omo-same", repo);
		const out = { opts: JSON.stringify(opts), argv: omoArgs(opts), sent: agent.sent.map(s => `${s.mode}:${s.text}`), field: "doneGate" in opts };
		l.stopLane("omo-same");
		await advance(300);
		return out;
	};
	const off = await run(false);
	const on = await run(true);
	expect(on).toEqual(off);
	expect(on.field).toBe(false);
	expect(on.sent).toHaveLength(1); // the prompt went at once
	expect(calls()).toEqual([]); // and no bootstrap ran
	expect(omoArgs({ ...JSON.parse(on.opts), doneGate: EXTENSION })).toEqual(on.argv); // the OmO argv builder ignores the field even if it were handed one
	expect(omo.caps.doneGate).toBeUndefined();
});
