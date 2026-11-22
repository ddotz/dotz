// The orchestrator's long-work refusals (guard-long.ts): a long bash call, back-to-back waits, sleep-polling while workers run, and recursive deletes outside the session's folder.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS } from "./guard-config.ts";
import { blocksLongWork, deletionProblem, longBashProblem, pollingProblem } from "./guard-long.ts";
import { callRules } from "./guard-notes.ts";
import { installGuard, installSubagentGuard } from "./guard.ts";

type Handler = (event: any, ctx: any) => any;

const noGate = { ...GUARD_DEFAULTS, budget_gate: false };
const HOME = homedir();
const CWD = join(HOME, "work", "proj");
const ENV_KEYS = ["DOTZ_LANE", "DOTZ_CONV", "DOTZ_ORCHESTRATOR", "DOTZ_RUNTIME"];

let dir: string;
let saved: Record<string, string | undefined>;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-guard-long-"));
	process.env.ORCH_GUARD_STATE_DIR = join(dir, "state");
});
afterAll(() => {
	delete process.env.ORCH_GUARD_STATE_DIR;
	rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function fakePi() {
	const handlers: Record<string, Handler[]> = {};
	const pi = {
		pi: { getAgentDir: () => join(dir, "agent-empty") },
		logger: { warn: () => undefined },
		on: (name: string, fn: Handler) => void (handlers[name] ??= []).push(fn),
		registerCommand: () => undefined,
		registerTool: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
	};
	return { pi, handlers };
}

// Every handler of an event in registration order, the way omp runs them: the first block wins.
async function fire(handlers: Record<string, Handler[]>, name: string, event: unknown, ctx: unknown) {
	for (const fn of handlers[name] ?? []) {
		const verdict = await fn(event, ctx);
		if (verdict?.block) return verdict;
	}
	return undefined;
}
const ctxOf = (cwd = CWD, kind = "main") => ({ agent: { kind, id: "A" }, cwd, sessionManager: { getSessionId: () => cwd } });
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ toolName: "bash", input: { command, ...extra } });
const ORCHESTRATOR = { DOTZ_ORCHESTRATOR: "1" };

function installed(env: Record<string, string> = ORCHESTRATOR) {
	for (const key of ENV_KEYS) delete process.env[key];
	Object.assign(process.env, { DOTZ_RUNTIME: "omp", ...env });
	const host = fakePi();
	installGuard(host.pi, noGate);
	return host.handlers;
}

test("long bash: a deadline over 120 s or none is refused in the orchestrator, a short one, async and a named service pass", async () => {
	const h = installed();
	const ctx = ctxOf();
	expect((await fire(h, "tool_call", bash("bun test", { timeout: 600 }), ctx)).reason).toContain("`task` worker");
	expect((await fire(h, "tool_call", bash("bun test", { timeout: 0 }), ctx)).reason).toContain("no deadline");
	for (const extra of [{ timeout: 60 }, { timeout: 120 }, {}, { timeout: 600, async: true }, { timeout: 600, name: "dev", ready: { port: 3000 } }]) {
		expect([extra, await fire(h, "tool_call", bash("bun test", extra), ctx)]).toEqual([extra, undefined]);
	}
});

test("long bash: a conversation session is bound as the orchestrator is; a subagent, a lane and a plain session are not", async () => {
	const conv = installed({ DOTZ_CONV: "ch:1" });
	expect((await fire(conv, "tool_call", bash("bun test", { timeout: 600 }), ctxOf())).reason).toContain("120 s");
	expect(await fire(conv, "tool_call", bash("bun test", { timeout: 600 }), ctxOf(CWD, "sub"))).toBeUndefined();
	expect(await fire(installed({ DOTZ_LANE: "perf", DOTZ_ORCHESTRATOR: "1" }), "tool_call", bash("bun test", { timeout: 600 }), ctxOf())).toBeUndefined();
	expect(await fire(installed({}), "tool_call", bash("bun test", { timeout: 600 }), ctxOf())).toBeUndefined();
	expect([blocksLongWork({ DOTZ_ORCHESTRATOR: "1" }), blocksLongWork({ DOTZ_CONV: "x" }), blocksLongWork({ DOTZ_ORCHESTRATOR: "1", DOTZ_LANE: "l" }), blocksLongWork({})]).toEqual([true, true, false, false]);
	expect(longBashProblem({ timeout: "300" })).toContain("300 s");
});

test("wait: a wait right after a wait that brought nothing is refused; wait, read, wait and a wait after a result pass", async () => {
	const h = installed();
	const ctx = ctxOf();
	const wait = { toolName: "wait", input: {} };
	const idle = { toolName: "wait", input: {}, content: [{ type: "text", text: "No new results; jobs still running." }] };
	const done = { toolName: "wait", input: {}, content: [{ type: "text", text: '<task-result id="W1" status="completed">' }] };
	expect(await fire(h, "tool_call", wait, ctx)).toBeUndefined();
	await fire(h, "tool_result", idle, ctx);
	expect((await fire(h, "tool_call", wait, ctx)).reason).toContain("`task` worker");
	expect((await fire(h, "tool_call", wait, ctx)).reason).toContain("another wait");
	expect(await fire(h, "tool_call", { toolName: "read", input: { path: "a.ts" } }, ctx)).toBeUndefined();
	expect(await fire(h, "tool_call", wait, ctx)).toBeUndefined();
	await fire(h, "tool_result", done, ctx);
	expect(await fire(h, "tool_call", wait, ctx)).toBeUndefined();
	await fire(h, "agent_end", {}, ctx);
	await fire(h, "tool_result", idle, ctx);
	expect(await fire(h, "tool_call", wait, ctx)).toBeUndefined();
});

test("wait: back-to-back waits pass in a lane and in a plain session", async () => {
	for (const env of [{ DOTZ_LANE: "perf" }, {}]) {
		const h = installed(env);
		const ctx = ctxOf();
		await fire(h, "tool_call", { toolName: "wait", input: {} }, ctx);
		expect([env, await fire(h, "tool_call", { toolName: "wait", input: {} }, ctx)]).toEqual([env, undefined]);
	}
});

const sleeping = (id: string) => ({ toolName: "task", input: { tasks: [] }, content: [{ type: "text", text: `Spawned agent \`${id}\`` }], details: { progress: [{ id }] } });

test("polling: sleep alone, sleep with a status read and a sleeping loop are refused while a worker runs, and pass with none", async () => {
	const h = installed({});
	const busy = ctxOf(join(dir, "busy"));
	const idleHost = installed({});
	const idle = ctxOf(join(dir, "idle"));
	for (const command of ["sleep 30; cat out.log", "sleep 30", "while ! test -f done; do sleep 5; done", "for i in 1 2 3; do sleep 10; done"]) {
		expect([command, await fire(idleHost, "tool_call", bash(command), idle)]).toEqual([command, undefined]);
	}
	await fire(h, "tool_result", sleeping("Falcon"), busy);
	for (const command of ["sleep 30; cat out.log", "sleep 30", "while ! test -f done; do sleep 5; done", "for i in 1 2 3; do sleep 10; done"]) {
		expect([command, (await fire(h, "tool_call", bash(command), busy))?.reason]).toEqual([command, expect.stringContaining("blocking `wait` tool")]);
	}
	// sleep as one step of real work, and a command that only names sleep, are fine.
	expect(await fire(h, "tool_call", bash("sleep 2 && bun run build && git status"), busy)).toBeUndefined();
	expect(await fire(h, "tool_call", bash("grep sleep notes.md"), busy)).toBeUndefined();
	expect(pollingProblem("sleep 5", 0)).toBeUndefined();
	expect(pollingProblem("sleep 5", 2)).toContain("2 worker(s)");
});

test("deletion: rm -r outside the session folder and the temp folders, and protected targets, are refused in the main session and in a subagent", async () => {
	const main = installed({});
	const sub = fakePi();
	installSubagentGuard(sub.pi, noGate);
	const ctx = ctxOf();
	for (const command of [`rm -rf ~/work/x`, `rm -rf ${HOME}/work/other`, "rm -rf ~", "rm -rf $HOME", "rm -rf /", "rm -rf .git", "rm -rf *", "rm -rf ./*", "rm -fr ../sibling", "rm -r -f /opt", "rm --recursive /etc/hosts.d", "rm -rf /tmp", "rm -rf ./build ~/work/x", "bash -c 'rm -rf ~/work/x'", "cd ~/work/foo && rm -rf dist", "find ~ -name '*.tmp' -delete", "sudo rm -rf /var/lib/x"]) {
		expect([command, (await fire(main, "tool_call", bash(command), ctx))?.reason]).toEqual([command, expect.stringContaining("orchestrator-guard")]);
		expect([command, (await fire(sub.handlers, "tool_call", bash(command), ctx))?.reason]).toEqual([command, expect.stringContaining("orchestrator-guard")]);
	}
});

test("deletion: inside the session folder, a temp folder, a quoted mention and a non-recursive rm pass", async () => {
	const main = installed({});
	const ctx = ctxOf();
	for (const command of ["rm -rf ./build", "rm -rf build node_modules/.cache", `rm -rf ${CWD}/dist`, "rm -rf ./build/*", "rm -rf /tmp/x", "rm -rf /private/tmp/x /tmp/y*", `rm -rf ${tmpdir()}/x`, "cd /tmp/x && rm -rf ./y", "rm -f ~/work/proj/a.txt ~/other.txt", "rm ~/work/x", "echo 'rm -rf /'", 'echo "rm -rf ~" > note.txt', "grep -r 'rm -rf' .", "find . -name '*.log' -delete", "find ./out -delete", "bash -c 'rm -rf ./build'", "rm -rf $UNKNOWN/x", "git rm -r --cached dist"]) {
		expect([command, await fire(main, "tool_call", bash(command), ctx)]).toEqual([command, undefined]);
	}
});

test("deletion: the pure function names the target, honours the call's own cwd and falls back to the git checkout", () => {
	expect(deletionProblem("rm -rf ~/work/x", CWD, HOME)).toContain(`outside this session's folder (${CWD})`);
	expect(deletionProblem("rm -rf ~", CWD, HOME)).toContain("protected");
	expect(deletionProblem("rm -rf ./*", CWD, HOME)).toContain("would empty");
	expect(deletionProblem("rm -rf x", "/work/proj", "/home/user", ["/tmp"])).toBeUndefined();
	expect(deletionProblem("rm -rf /work/other", "/work/proj", "/home/user", ["/tmp"])).toContain("outside");
	expect(deletionProblem("rm -rf /tmp/x", "/work/proj", "/home/user", ["/tmp"])).toBeUndefined();
	expect(deletionProblem("rm -rf /work", "/work/proj", "/home/user", ["/tmp"])).toContain("holds this session's own folder");
	// The repo checkout above the session folder (a session started in a subfolder) is also its own.
	const repo = mkdtempSync(join(tmpdir(), "dotz-guard-long-repo-"));
	try {
		Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
		const sub = join(repo, "pkg");
		Bun.spawnSync(["mkdir", "-p", sub]);
		expect(deletionProblem("rm -rf ../dist", sub, HOME, [])).toBeUndefined();
		expect(deletionProblem("rm -rf ../../elsewhere", sub, HOME, [])).toContain("outside");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the rules are runtime-independent: an OmO session refuses the same long bash, back-to-back wait, sleep poll and outside delete", async () => {
	const h = installed({ ...ORCHESTRATOR, DOTZ_RUNTIME: "omo" });
	const ctx = ctxOf(join(dir, "omo"));
	await fire(h, "tool_result", sleeping("Falcon"), ctx);
	expect(await fire(h, "tool_call", { toolName: "wait", input: {} }, ctx)).toBeUndefined();
	for (const call of [{ toolName: "wait", input: {} }, bash("bun test", { timeout: 600 }), bash("sleep 30; cat out.log"), bash("rm -rf ~/work/x")]) {
		expect([call, (await fire(h, "tool_call", call, ctx))?.reason]).toEqual([call, expect.stringContaining("orchestrator-guard")]);
	}
	expect(callRules(noGate)).toContain("bash timeout over 120 s");
});
