import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noreplyMail } from "../hub/commit-identity.ts";
import { channelCommand } from "./guard-channels.ts";
import { GUARD_DEFAULTS } from "./guard-config.ts";
import { evalSpawnBlock, evalSpawnProblem, reviveBrief } from "./guard-spawn.ts";
import { budgetLine, externalAction, installGuard, installSubagentGuard, sharedWriteBlock } from "./guard.ts";
import { expandShellVars } from "./guard-shell.ts";
import { shellText } from "./index.ts";

type Handler = (event: any, ctx: any) => any;

const noGate = { ...GUARD_DEFAULTS, budget_gate: false };
const MERGE = 'await tool.bash({ command: "gh pr merge 3 --squash" })';
const ISOLATION_ERROR = "Isolated subagent execution could not be prepared: repository is over the isolation size budget";

let dir: string;
let saved: Record<string, string | undefined>;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-guard-gaps-"));
	process.env.ORCH_GUARD_STATE_DIR = join(dir, "state");
});
afterAll(() => {
	delete process.env.ORCH_GUARD_STATE_DIR;
	rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
	saved = { DOTZ_LANE: process.env.DOTZ_LANE, DOTZ_CONV: process.env.DOTZ_CONV };
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

const main = (cwd: string, session = "s1") => ({ agent: { kind: "main" }, cwd, sessionManager: { getSessionId: () => session } });
const call = (handlers: Record<string, Handler[]>, event: unknown, ctx: unknown) => handlers.tool_call![0]!(event, ctx);

test("F6-01: omp's hashline edit, apply_patch, xd:// device calls and ast_edit are refused on a shared file for a lane and a conversation session, other files pass", () => {
	const data = join(dir, "data");
	const sessions: [conv: string, lane: string][] = [["mail:acme-1", ""], ["", "fleet"]];
	const refused = (tool: string, input: unknown) => sessions.map(([conv, lane]) => sharedWriteBlock(tool, input, data, conv, lane) !== undefined);
	const hashline = (file: string) => `[${file}#1A2B]\nPUT 1.=1:\n+x`;
	for (const file of ["RULES.md", "state.json", "LESSONS.md", join("memory", "owner.md")]) {
		expect(refused("edit", { input: hashline(join(data, file)) })).toEqual([true, true]);
	}
	expect(refused("edit", { input: `[${join(data, "notes.md")}#0001]\nPUT 1.=1:\n+x\n[${join(data, "RULES.md")}#0002]\nCUT 1.=1` })).toEqual([true, true]);
	expect(refused("edit", { input: `[${join(dir, "other.md")}#1A2B]\nMV ${join(data, "LESSONS.md")}` })).toEqual([true, true]);
	expect(refused("apply_patch", { input: `*** Begin Patch\n*** Update File: ${join(data, "LESSONS.md")}\n@@\n-a\n+b\n*** End Patch` })).toEqual([true, true]);
	expect(refused("write", { path: "xd://edit", content: JSON.stringify({ input: hashline(join(data, "RULES.md")) }) })).toEqual([true, true]);
	expect(refused("ast_edit", { paths: [join(data, "state.json")], ops: [] })).toEqual([true, true]);
	expect(refused("edit", { input: hashline(join(data, "notes.md")) })).toEqual([false, false]);
	expect(refused("edit", { input: `[${join(dir, "other.md")}#1A2B]\nPUT 1.=1:\n+see ${join(data, "RULES.md")}` })).toEqual([false, false]);
});

test("F6-03: a lane's merge inside an eval cell is refused as a bash one is; other eval cells and the same cell outside a lane pass", async () => {
	process.env.DOTZ_LANE = "l1";
	const { pi, handlers } = fakePi();
	installGuard(pi, noGate);
	const ctx = main(dir);
	const eval_ = (code: string) => ({ toolName: "eval", input: { language: "js", code } });
	expect((await call(handlers, eval_(MERGE), ctx)).reason).toContain("dotz_merge");
	expect((await call(handlers, { toolName: "bash", input: { command: "gh pr merge 3 --squash" } }, ctx)).reason).toContain("dotz_merge");
	expect(await call(handlers, eval_('await tool.bash({ command: "gh pr checks 3" })'), ctx)).toBeUndefined();
	delete process.env.DOTZ_LANE;
	expect(await call(handlers, eval_(MERGE), ctx)).toBeUndefined();
});

test("F6-04: a writing worker started from an eval cell is refused at spawn, a read-only one and the task tool's own spawns pass, on the main guard and the subagent guard", () => {
	const { pi, handlers } = fakePi();
	installGuard(pi, noGate);
	const sub = fakePi();
	installSubagentGuard(sub.pi, noGate);
	for (const spawn of [handlers.before_subagent_spawn![0]!, sub.handlers.before_subagent_spawn![0]!]) {
		for (const agent of ["task", "sonic", undefined]) expect(spawn({ invocationKind: "eval", agent }, {})).toMatchObject({ block: true });
		expect(spawn({ invocationKind: "eval", agent: "scout" }, {})).toBeUndefined();
		expect(spawn({ invocationKind: "task", agent: "task" }, {})).toBeUndefined();
	}
	expect(evalSpawnBlock({ invocationKind: "eval", agent: "task" })?.reason).toContain("task tool");
	expect(evalSpawnBlock(undefined)).toBeUndefined();
});

test("F6-04: an eval cell that starts workers needs the done-condition line a task brief needs", async () => {
	const { pi, handlers } = fakePi();
	installGuard(pi, noGate);
	const sub = fakePi();
	installSubagentGuard(sub.pi, noGate);
	const cell = (code: string) => ({ toolName: "eval", input: { language: "js", code } });
	for (const code of ['await agent("scout", "list the files")', 'await workpool([{ prompt: "scan" }])']) {
		expect(evalSpawnProblem("eval", { code })).toContain("done-condition");
		expect((await call(handlers, cell(code), main(dir))).reason).toContain("done-condition");
		expect((await call(sub.handlers, cell(code), { agent: { kind: "sub", id: "W" }, cwd: dir })).reason).toContain("done-condition");
		expect(evalSpawnProblem("eval", { code: `${code} // Acceptance: lists every file` })).toBeUndefined();
	}
	expect(evalSpawnProblem("eval", { code: "const x = myagent(1); x + 1" })).toBeUndefined();
	expect(evalSpawnProblem("bash", { command: 'agent("x")' })).toBeUndefined();
});

test("F6-04: a write to agent://<id> that is not known to reach a running worker is a brief: done-condition required, budget line added; a running worker and a broadcast pass", async () => {
	const { pi, handlers } = fakePi();
	installGuard(pi, noGate);
	const ctx = main(dir, "revive");
	const revive = (content: string, path = "agent://Falcon") => ({ toolName: "write", input: { path, content } });
	expect((await call(handlers, revive("go on and fix the rest"), ctx)).reason).toContain("done-condition");
	const briefed = await call(handlers, revive("go on\nAcceptance: tests pass"), ctx);
	expect(briefed.input.content).toEndWith(budgetLine(noGate));
	expect((await call(handlers, revive("x".repeat(20_000) + "\nDone when: y"), ctx)).reason).toContain("limit");
	expect(await call(handlers, revive("everyone stop", "agent://all"), ctx)).toBeUndefined();
	await handlers.tool_result![0]!({ toolName: "task", input: { tasks: [] }, content: [{ type: "text", text: "Spawned agent `Falcon`" }], details: { progress: [{ id: "Falcon" }] } }, ctx);
	expect(await call(handlers, revive("wrap up"), ctx)).toBeUndefined();
	expect(reviveBrief({ path: "agent://X", content: "a\nAcceptance: b" }, noGate)).toHaveProperty("input");
});

test("F6-04: omp's isolation error (from the task result or a later wait/task-result) puts the folder's parallel writing workers in place; before it they are isolated", async () => {
	const repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "f"), "x");
	git("add", "f");
	git("-c", "user.name=t", "-c", `user.email=${noreplyMail("t", "1")}`, "commit", "-q", "-m", "f");
	const spawn = async (handlers: Record<string, Handler[]>, ctx: unknown) => (await call(handlers, { toolName: "task", input: { tasks: [{ agent: "task", task: "do it\nAcceptance: done" }, { agent: "task", task: "do that\nAcceptance: done" }] } }, ctx)).input.tasks.map((t: { isolated?: boolean }) => t.isolated);
	for (const [name, fire] of [
		["wait result", (h: Record<string, Handler[]>, ctx: unknown) => h.tool_result![0]!({ toolName: "wait", isError: true, content: [{ type: "text", text: `isolation: ${ISOLATION_ERROR}` }] }, ctx)],
		["task result", (h: Record<string, Handler[]>, ctx: unknown) => h.tool_result![0]!({ toolName: "task", isError: true, content: [{ type: "text", text: ISOLATION_ERROR }] }, ctx)],
		["result message in context", (h: Record<string, Handler[]>, ctx: unknown) => h.context![0]!({ messages: [{ role: "user", content: `<task-result id="A">${ISOLATION_ERROR}</task-result>` }] }, ctx)],
	] as const) {
		const { pi, handlers } = fakePi();
		installGuard(pi, noGate);
		const ctx = main(repo, `iso-${name}`);
		expect([name, await spawn(handlers, ctx)]).toEqual([name, [true, true]]);
		await fire(handlers, ctx);
		expect([name, await spawn(handlers, ctx)]).toEqual([name, [false, false]]);
	}
});

test("F6-13: the github tool, a debug launch and any ssh:// path stand for the shell command the worker checks judge", () => {
	expect(channelCommand("github", { op: "pr_push", branch: "feature", forceWithLease: true })).toBe("git push --force-with-lease origin feature");
	expect(channelCommand("github", { op: "pr_create", repo: "o/r", base: "main", title: "t", body: "b" })).toBe('gh pr create --repo o/r --base main --title "t" --body "b"');
	expect(channelCommand("github", { op: "issue_view", issue: 3 })).toBeUndefined();
	expect(channelCommand("debug", { action: "launch", program: "python3", args: ["x.py"] })).toBe("python3 x.py");
	expect(channelCommand("debug", { action: "attach", host: "build.example.com" })).toBe("ssh build.example.com");
	expect(channelCommand("debug", { action: "attach", host: "localhost" })).toBeUndefined();
	expect(channelCommand("write", { path: "ssh://deploy@box.example.com:2222/srv/app/.env", content: "x" })).toBe("ssh box.example.com");
	expect(channelCommand("edit", { input: `[ssh://box/etc/hosts#1A2B]\nPUT 1.=1:\n+x` })).toBe("ssh box");
	expect(channelCommand("read", { path: "src/main.ts" })).toBeUndefined();
	const text = (toolName: string, input: unknown) => shellText({ toolName, input });
	expect(externalAction(expandShellVars(text("github", { op: "pr_push", branch: "f" }) ?? ""))).toBeDefined();
	expect(externalAction(expandShellVars(text("github", { op: "pr_create", title: "t" }) ?? ""))).toBeDefined();
	expect(externalAction(expandShellVars(text("write", { path: "ssh://box/srv/x", content: "y" }) ?? ""))).toBeDefined();
	expect(text("bash", { command: "ls" })).toBe("ls");
	expect(text("eval", { code: "1+1" })).toBe("1+1");
	expect(text("read", { path: "a.ts" })).toBeUndefined();
});

type Event = { toolName: string; input: Record<string, unknown> };

const WORKER_SCRIPT = `
const handlers = []; const base = { on: (n, f) => n === "tool_call" && handlers.push(f) };
const pi = new Proxy(base, { get: (t, p) => (p in t ? t[p] : p === "zod" ? undefined : () => undefined) });
(await import("./extension/index.ts")).default(pi);
const out = [];
for (const event of JSON.parse(process.env.WORKER_EVENTS)) {
	let verdict;
	for (const f of handlers) if ((verdict = await f(event, { cwd: process.env.WORKER_CWD }))?.block) break;
	out.push(verdict?.block ? verdict.reason : null);
}
console.log(JSON.stringify(out));
process.exit(0);`;

function workerVerdicts(events: Event[]): (string | null)[] {
	const data = join(dir, "worker-data");
	mkdirSync(join(data, "secrets"), { recursive: true });
	const env = { ...process.env, DOTZ_RUNTIME: "omo", DOTZ_DIR: data, DOTZ_LANE: "alpha", OMO_SENPI_TASK_DEPTH: "1", WORKER_CWD: dir, WORKER_EVENTS: JSON.stringify(events), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string>;
	delete env.DOTZ_ORCHESTRATOR;
	const r = Bun.spawnSync([process.execPath, "-e", WORKER_SCRIPT], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "[]");
}

test("F6-13: a lane's task worker is refused a github push or PR, a write to a remote host and a hashline edit of a shared file; local reads and edits pass", () => {
	const shared = join(dir, "worker-data", "RULES.md");
	const [push, pr, remote, sharedEdit, readLocal, editLocal] = workerVerdicts([
		{ toolName: "github", input: { op: "pr_push", branch: "feature" } },
		{ toolName: "github", input: { op: "pr_create", title: "t", body: "b" } },
		{ toolName: "write", input: { path: "ssh://box/srv/app/.env", content: "x" } },
		{ toolName: "edit", input: { input: `[${shared}#1A2B]\nPUT 1.=1:\n+x` } },
		{ toolName: "read", input: { path: join(dir, "a.ts") } },
		{ toolName: "edit", input: { input: `[${join(dir, "a.ts")}#1A2B]\nPUT 1.=1:\n+x` } },
	]);
	for (const refused of [push, pr, remote, sharedEdit]) expect(refused).toEqual(expect.any(String));
	expect([readLocal, editLocal]).toEqual([null, null]);
});

test("F6-04: installGuard answers whether it knows a worker as running, for the restart hold's steer-versus-revive split", async () => {
	const { pi, handlers } = fakePi();
	const running = installGuard(pi, noGate);
	const ctx = main(join(dir, "running-lookup"), "running-lookup");
	expect(running(ctx, "Falcon")).toBe(false);
	await handlers.tool_result![0]!({ toolName: "task", input: { tasks: [] }, content: [{ type: "text", text: "Spawned agent `Falcon`" }], details: { progress: [{ id: "Falcon" }] } }, ctx);
	expect(running(ctx, "Falcon")).toBe(true);
	expect(running(ctx, "Hawk")).toBe(false);
	expect(installGuard(fakePi().pi, { ...noGate, enabled: false })(ctx, "Falcon")).toBe(false);
});
