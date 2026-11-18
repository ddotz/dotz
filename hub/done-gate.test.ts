// A lane's fresh session in a worktree without a gate file waits for the harness's bootstrap before its first prompt; a failing or hanging bootstrap never keeps the lane waiting.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { holdWorkOnApiKey } from "../extension/apikey-hold.ts";
import { BOOTSTRAP_LIMIT_MS } from "../extension/harness-gate.ts";
import dotz from "../extension/index.ts";
import { cfg, paths } from "./config.ts";
import { gateBootstrap, harnessGate } from "./done-gate.ts";
import * as l from "./lanes.ts";
import { laneMode, resetLaneStateForTest, type LaneMode } from "./lanestate.ts";
import { git } from "./lanetree.ts";
import { routeLanes } from "./routes-lanes.ts";
import { adapters } from "./runtime/index.ts";
import { omo, omoArgs } from "./runtime/omo.ts";
import { EXTENSION as DOTZ_EXTENSION, omp, ompArgv } from "./runtime/omp.ts";
import { advance, realClearTimeout, realSetTimeout } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

resetLaneStateForTest();
const DATA = process.env.DOTZ_DIR!;
const TMP = mkdtempSync(join(tmpdir(), "dotz-done-gate-"));
const AGENT = join(TMP, "agent");
const PAYLOAD = join(DATA, "coding-harness");
const EXTENSION = join(PAYLOAD, "extensions", "done-gate.ts");
const BOOTSTRAP = join(PAYLOAD, "harness", "gate", "bootstrap.ts");
const STUB_LOG = join(TMP, "stub.log");

// What the real script does for a repo: it takes the worktree path, writes the gate file and the lint kit, and tells what it did.
const STUB = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const repo = process.argv[2];
appendFileSync(process.env.GATE_STUB_LOG, repo + "\\n");
appendFileSync(process.env.GATE_STUB_LOG + ".home", (process.env.HARNESS_AGENT_HOME ?? "unset") + "\\n");
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

const PAYLOAD_FILES = ["SHIPPED_FROM", "extensions/done-gate.ts", "extensions/orchestrator-guard.ts", "extensions/harness-tools.ts", "harness/gate/bootstrap.ts"];

function install(dir: string, files = PAYLOAD_FILES): void {
	for (const f of files) {
		mkdirSync(dirname(join(dir, f)), { recursive: true });
		writeFileSync(join(dir, f), f.endsWith("bootstrap.ts") ? STUB : "");
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

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "GATE_STUB_LOG", "GATE_STUB_MODE", "DOTZ_ALLOW_LIVE", "DOTZ_PORT"];
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
	cfg.lanes = { ...savedLanes, runtime: "fakegate", max_active: 8, min_free_disk_gb: 0 };
	process.env.PI_CODING_AGENT_DIR = AGENT;
	process.env.OMP_PROFILE = ""; // no named profile, whatever the developer's shell has
	process.env.GATE_STUB_LOG = STUB_LOG;
	process.env.GATE_STUB_MODE = "ok";
	install(PAYLOAD);
	writeFileSync(STUB_LOG, "");
	writeFileSync(`${STUB_LOG}.home`, "");
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
	rmSync(PAYLOAD, { recursive: true, force: true });
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

function launch(name: string, cwd: string, mode?: LaneMode) {
	running.add(name);
	const lane = l.launch(name, cwd, "Fix the thing.\nDone when: the tests pass", undefined, undefined, undefined, undefined, undefined, undefined, mode);
	return { lane, ...spawns.findLast(s => s.opts.lane?.name === name)! };
}
const loadsGate = (opts: SpawnOpts): boolean => ompArgv(opts).join(" ").includes(`--extension ${DOTZ_EXTENSION} --extension ${EXTENSION}`);
const recorded = (name: string): unknown => JSON.parse(readFileSync(join(paths.lanes, name, "lane.json"), "utf8")).mode;

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
async function dotzLaneTool(): Promise<{ tool: Tool; url: string; stop: () => void }> {
	const hub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => { const url = new URL(req.url); return routeLanes(req, url, url.pathname.split("/").filter(Boolean)).then(r => r ?? new Response("{}", { status: 404 })); } });
	const tools: Tool[] = [];
	const host = new Proxy({ registerTool: (t: Tool) => tools.push(t) } as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : key === "then" || key === "zod" ? undefined : () => undefined) });
	Object.assign(process.env, { DOTZ_ORCHESTRATOR: "1", DOTZ_RUNTIME: "omo" });
	holdWorkOnApiKey({}, true);
	await dotz(host);
	delete process.env.DOTZ_ORCHESTRATOR;
	delete process.env.DOTZ_RUNTIME;
	Object.assign(process.env, { DOTZ_ALLOW_LIVE: "1", DOTZ_PORT: String(hub.port) });
	return { tool: tools.find(t => t.name === "dotz_lane")!, url: `http://127.0.0.1:${hub.port}`, stop: () => void hub.stop(true) };
}
function withSession(lane: { name: string; sessionFile?: string }): string {
	const session = join(DATA, "omo-agent", "sessions", `${lane.name}.jsonl`);
	mkdirSync(dirname(session), { recursive: true });
	writeFileSync(session, "");
	lane.sessionFile = session;
	return session;
}

test("lanes.harness_gate false: a coding lane is handed no payload, no bootstrap, and its first prompt goes at once", () => {
	cfg.lanes.harness_gate = false;
	expect(harnessGate()).toBeUndefined();
	const { lane, opts, agent } = launch("gate-off", repoWith());
	expect(lane.mode).toBe("coding");
	expect("codingHarness" in opts).toBe(false);
	expect(loadsGate(opts)).toBe(false);
	expect(agent.sent).toHaveLength(1);
	expect(calls()).toEqual([]);
});

test("on with the payload installed: the process is handed its folder, the bootstrap runs with it as the harness home, and the first prompt waits until the bootstrap has written the gate file", async () => {
	expect(harnessGate()).toMatchObject({ dir: PAYLOAD, extension: EXTENSION, bootstrap: BOOTSTRAP });
	const { lane, opts, agent } = launch("gate-on", repoWith());
	expect(opts.codingHarness).toBe(PAYLOAD);
	expect(agent.sent).toHaveLength(0);
	await within(agent.first.promise, "the first prompt");
	expect(agent.sent).toHaveLength(1);
	expect(agent.sent[0]!.text).toContain("Fix the thing.");
	expect(agent.sent[0]!.gateFile).toBe(true);
	expect(calls()).toEqual([lane.worktree!.path]);
	expect(readFileSync(`${STUB_LOG}.home`, "utf8")).toBe(`${PAYLOAD}\n`);
});

test("with lanes.harness_gate unset the mode decides: a lane in a git worktree is a coding lane and has the payload in its omp argv, a lane without a worktree is an assistant lane and has none, a mode asked at launch wins over the folder", async () => {
	expect(cfg.lanes.harness_gate).toBeUndefined();
	const coding = launch("mode-coding", repoWith());
	expect(coding.lane.worktree).toBeDefined();
	expect(coding.lane.mode).toBe("coding");
	expect(loadsGate(coding.opts)).toBe(true);
	await within(coding.agent.first.promise, "the first prompt");
	const assistant = launch("mode-assistant", TMP);
	expect(assistant.lane.worktree).toBeUndefined();
	expect(assistant.lane.mode).toBe("assistant");
	expect("codingHarness" in assistant.opts).toBe(false);
	expect(loadsGate(assistant.opts)).toBe(false);
	expect(assistant.agent.sent).toHaveLength(1);
	const askedCoding = launch("mode-asked-coding", TMP, "coding");
	expect([askedCoding.lane.worktree, askedCoding.lane.mode, loadsGate(askedCoding.opts)]).toEqual([undefined, "coding", true]);
	const askedAssistant = launch("mode-asked-assistant", repoWith(), "assistant");
	expect(askedAssistant.lane.worktree).toBeDefined();
	expect([askedAssistant.lane.mode, "codingHarness" in askedAssistant.opts, loadsGate(askedAssistant.opts)]).toEqual(["assistant", false, false]);
	const listed = l.laneList();
	for (const { lane } of [coding, assistant, askedCoding, askedAssistant]) {
		expect(recorded(lane.name)).toBe(lane.mode);
		expect(listed.find(row => row.name === lane.name)?.mode).toBe(lane.mode);
	}
	expect(calls()).toEqual([coding.lane.worktree!.path]);
});

test("a lane record from before modes has no mode: it reads as coding with a worktree and as assistant without, and the restored lane keeps it when its worktree goes", () => {
	const worktree = { path: join(TMP, "gone-worktree"), repo: TMP, branch: "lane/old-coding", base: "main" };
	expect([laneMode({ worktree }), laneMode({}), laneMode({ mode: "assistant", worktree })]).toEqual(["coding", "assistant", "assistant"]);
	const record = (name: string, extra: object) => {
		mkdirSync(join(paths.lanes, name), { recursive: true });
		writeFileSync(join(paths.lanes, name, "lane.json"), JSON.stringify({ name, cwd: TMP, model: "m", status: "exited", startedAt: "2026-11-01T00:00:00.000Z", reports: 0, ...extra }));
	};
	record("old-coding", { worktree });
	record("old-plain", {});
	l.restoreLanes();
	expect([l.lanes.get("old-coding")?.mode, l.lanes.get("old-plain")?.mode]).toEqual(["coding", "assistant"]);
	l.lanes.get("old-coding")!.worktree = undefined;
	expect(laneMode(l.lanes.get("old-coding")!)).toBe("coding");
	for (const name of ["old-coding", "old-plain"]) l.lanes.delete(name);
});

test("dotz_lane action=mode records the new mode on the lane and restarts its process on the same session: the gate is loaded for coding and left out for assistant, and the same mode again restarts nothing", async () => {
	const { tool, stop } = await dotzLaneTool();
	try {
		const { lane, agent } = launch("mode-switch", repoWith(), "assistant");
		const session = withSession(lane);
		const before = spawns.length;
		expect(loadsGate(spawns.at(-1)!.opts)).toBe(false);
		const to = async (mode: string) => JSON.parse((await tool.execute("c1", { action: "mode", name: "mode-switch", mode })).content[0]!.text);
		expect(await to("coding")).toEqual({ ok: true, mode: "coding", applied: "restarting" });
		expect([lane.mode, recorded("mode-switch")]).toEqual(["coding", "coding"]);
		await within(agent.exited, "the old process to end");
		expect(spawns).toHaveLength(before + 1);
		expect(spawns.at(-1)!.opts.resume).toBe(session);
		expect(loadsGate(spawns.at(-1)!.opts)).toBe(true);
		await within(spawns.at(-1)!.agent.first.promise, "the restarted lane's first message, held for the bootstrap");
		expect(calls()).toEqual([lane.worktree!.path]);
		expect(await to("assistant")).toEqual({ ok: true, mode: "assistant", applied: "restarting" });
		expect([lane.mode, recorded("mode-switch")]).toEqual(["assistant", "assistant"]);
		expect(spawns).toHaveLength(before + 2);
		expect(spawns.at(-1)!.opts.resume).toBe(session);
		expect(loadsGate(spawns.at(-1)!.opts)).toBe(false);
		expect(await to("assistant")).toEqual({ ok: true, mode: "assistant", applied: "unchanged" });
		expect(spawns).toHaveLength(before + 2);
	} finally {
		stop();
	}
});

test("dotz_lane action=mode on a stopped lane takes effect at its next start; a mode that is not one of the two, and a runtime that cannot load the gate, are refused with the lane unchanged", async () => {
	const { tool, url, stop } = await dotzLaneTool();
	try {
		const { lane } = launch("mode-stopped", repoWith(), "assistant");
		withSession(lane);
		l.stopLane("mode-stopped");
		await advance(300);
		const before = spawns.length;
		const out = JSON.parse((await tool.execute("c2", { action: "mode", name: "mode-stopped", mode: "coding" })).content[0]!.text);
		expect(out).toEqual({ ok: true, mode: "coding", applied: "next-start" });
		expect([lane.mode, recorded("mode-stopped"), spawns.length]).toEqual(["coding", "coding", before]);
		l.sendToLane("mode-stopped", "[owner via Discord] one more tweak");
		expect(spawns).toHaveLength(before + 1);
		expect(loadsGate(spawns.at(-1)!.opts)).toBe(true);
		const bad = await fetch(`${url}/api/lanes/mode-stopped/mode`, { method: "POST", body: JSON.stringify({ mode: "fast" }) });
		expect([bad.status, await bad.json()]).toEqual([400, { error: "mode must be coding or assistant" }]);
		const badLaunch = await fetch(`${url}/api/lanes`, { method: "POST", body: JSON.stringify({ name: "mode-bad", mode: "fast" }) });
		expect(badLaunch.status).toBe(400);
		cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
		await expect(tool.execute("c3", { action: "mode", name: "mode-stopped", mode: "assistant" })).rejects.toThrow(/not omp/);
		expect([lane.mode, recorded("mode-stopped")]).toEqual(["coding", "coding"]);
	} finally {
		stop();
	}
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
	expect(opts.codingHarness).toBe(PAYLOAD);
	expect(agent.sent).toHaveLength(1);
	expect(calls()).toEqual([]);
	expect(exclude(repo)).toBe(before);
});

test("a payload that is not installed, or only half of it, does nothing, and the omp agent folder is never a fallback", () => {
	for (const gone of [BOOTSTRAP, EXTENSION]) {
		rmSync(gone);
		expect(harnessGate()).toBeUndefined();
		install(PAYLOAD);
	}
	rmSync(PAYLOAD, { recursive: true });
	expect(existsSync(join(AGENT, "extensions", "done-gate.ts"))).toBe(true);
	expect(harnessGate()).toBeUndefined();
	const { opts, agent } = launch("gate-none", repoWith());
	expect("codingHarness" in opts).toBe(false);
	expect(ompArgv(opts).some(a => a.startsWith(AGENT))).toBe(false);
	expect(agent.sent).toHaveLength(1);
	expect(calls()).toEqual([]);
});

test("the note that the payload is missing is for an owner who set the key to true: the default on says nothing, true says it once", () => {
	rmSync(PAYLOAD, { recursive: true });
	const said = hubLog();
	expect(harnessGate()).toBeUndefined();
	expect(said()).not.toContain("is not there");
	cfg.lanes.harness_gate = true;
	expect(harnessGate()).toBeUndefined();
	expect(harnessGate()).toBeUndefined();
	expect(said().split(`lanes.harness_gate is true, but the coding harness dotz installs under ${DATA} at gateway start is not there`)).toHaveLength(2);
});

test("the omp profile and agent folder variables play no part: the payload is found in the data dir and nowhere else", () => {
	const home = mkdtempSync(join(TMP, "home-"));
	install(join(home, ".omp", "profiles", "work", "agent"));
	process.env.HOME = home;
	process.env.OMP_PROFILE = "work";
	delete process.env.PI_CODING_AGENT_DIR;
	expect(harnessGate()?.dir).toBe(PAYLOAD);
	rmSync(PAYLOAD, { recursive: true });
	expect(harnessGate()).toBeUndefined();
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
	expect(resumed.opts.codingHarness).toBe(PAYLOAD);
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

test("OmO lanes are untouched: with the setting on and the payload installed, a lane's spawn options, argv and prompt equal those with it off", async () => {
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	const repo = repoWith();
	const run = async (on: boolean) => {
		cfg.lanes = { ...cfg.lanes, harness_gate: on };
		const { opts, agent } = launch("omo-same", repo);
		const out = { opts: JSON.stringify(opts), argv: omoArgs(opts), sent: agent.sent.map(s => `${s.mode}:${s.text}`), field: "codingHarness" in opts };
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
	expect(omoArgs({ ...JSON.parse(on.opts), codingHarness: PAYLOAD })).toEqual(on.argv); // the OmO argv builder ignores the field even if it were handed one
	expect(omo.caps.doneGate).toBeUndefined();
});
