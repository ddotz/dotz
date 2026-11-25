import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { advance } from "../hub/runtime/test-clock.ts";
import { BOOTSTRAP_LIMIT_MS } from "./harness-gate.ts";
import { ompHosts } from "./omp-host.ts";
import { installWorkerGate } from "./worker-gate.ts";

const KEY = Symbol.for("dotz.test.workerGate");
const GATE_EVENTS = ["before_agent_start", "agent_start", "agent_end", "assistant_message", "tool_call", "tool_result", "session_switch", "session_branch", "session_shutdown"];

type Hook = (event: unknown, ctx: unknown) => unknown;
type Rec = {
	calls: { name: string; event: unknown; ctx: unknown }[];
	stops: { finished: number }[];
	changed: true[];
	registered: { keys: string; zod: unknown }[];
	files: string[];
	blocks: number;
	broken: boolean;
	repo: string;
	agent: string;
};

const EXTENSION = `import { readFileSync } from "node:fs";
import { join } from "node:path";
const rec = () => globalThis[Symbol.for("dotz.test.workerGate")];
const finished = agent => {
	try {
		return readFileSync(join(agent, "finished.log"), "utf8").split("\\n").filter(Boolean).length;
	} catch {
		return 0;
	}
};
export function registerDoneGate(api) {
	rec().registered.push({ keys: Object.keys(api).sort().join(","), zod: api.zod });
	for (const name of ${JSON.stringify([...GATE_EVENTS, "session_stop"])}) {
		api.on(name, async (event, ctx) => {
			const r = rec();
			r.calls.push({ name, event, ctx });
			if (name === "tool_result") return { additionalContext: "feedback" };
			if (name !== "session_stop") return undefined;
			r.stops.push({ finished: finished(r.agent) });
			return r.blocks-- > 0 ? { decision: "block", reason: "fix the new comment" } : undefined;
		});
	}
	api.registerCommand("gate-ok", {});
	api.registerTool({ name: "mistake" });
	api.sendMessage({ customType: "late", display: true, content: "late check" }, { deliverAs: "aside", triggerTurn: true });
	return {
		handlers: {},
		async sessionChanges() {
			const r = rec();
			r.changed.push(true);
			if (r.broken) throw new Error("snapshot failed");
			return [{ repo: r.repo, base: "HEAD", files: r.files }];
		},
		waive: () => false,
	};
}
`;

const BOOTSTRAP = `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const agent = join(import.meta.dir, "..", "..");
export const needsBootstrap = async () => existsSync(join(agent, "needs-bootstrap"));
if (import.meta.main) {
	const repo = process.argv[2];
	appendFileSync(join(agent, "started.log"), repo + "\\n");
	if (existsSync(join(agent, "hang"))) {
		const grandchild = Bun.spawn(["sleep", "1000"]);
		writeFileSync(join(agent, "pids"), process.pid + " " + grandchild.pid);
		await grandchild.exited;
	} else if (existsSync(join(agent, "fail"))) process.exit(3);
	else {
		mkdirSync(join(repo, ".omp"), { recursive: true });
		writeFileSync(join(repo, ".omp", "gate.json"), "{}\\n");
		appendFileSync(join(agent, "finished.log"), repo + "\\n");
	}
}
`;

const FINAL = { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } };

let root: string;
let repo: string;
let agent: string;
let rec: Rec;
let err: Mock<typeof console.error>;

const put = (file: string, text: string): void => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
};

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	return r.stdout.toString().trim();
}

const lines = (name: string): string[] => (existsSync(join(agent, name)) ? readFileSync(join(agent, name), "utf8").split("\n").filter(Boolean) : []);
const said = (): string[] => err.mock.calls.map(args => String(args[0]));
const exclude = (): string => readFileSync(join(repo, ".git", "info", "exclude"), "utf8");

function appears(name: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const watcher = watch(agent, () => existsSync(join(agent, name)) && resolve());
	if (existsSync(join(agent, name))) resolve();
	return promise.finally(() => watcher.close());
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "dotz-worker-gate-")));
	agent = join(root, "agent");
	repo = join(root, "repo");
	put(join(agent, "extensions", "done-gate.ts"), EXTENSION);
	put(join(agent, "harness", "gate", "bootstrap.ts"), BOOTSTRAP);
	put(join(agent, "needs-bootstrap"), "");
	put(join(repo, "src", "a.ts"), "export const a = 1;\n");
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "one");
	rec = { calls: [], stops: [], changed: [], registered: [], files: ["src/a.ts"], blocks: 1, broken: false, repo, agent };
	(globalThis as Record<symbol, unknown>)[KEY] = rec;
	err = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	err.mockRestore();
	delete (globalThis as Record<symbol, unknown>)[KEY];
	rmSync(root, { recursive: true, force: true });
});

function fakeHost() {
	const seen = { on: [] as { name: string; hook: Hook }[], tools: [] as unknown[], commands: [] as unknown[], sent: [] as { message: unknown; options: unknown }[] };
	const pi = {
		zod: { fake: true },
		on: (name: string, hook: Hook): void => void seen.on.push({ name, hook }),
		registerTool: (tool: unknown): void => void seen.tools.push(tool),
		registerCommand: (name: string): void => void seen.commands.push(name),
		sendMessage: (message: unknown, options?: unknown): void => void seen.sent.push({ message, options }),
	};
	const fire = async (name: string, event: unknown, ctx: unknown): Promise<unknown> => {
		let result: unknown;
		for (const { name: registered, hook } of seen.on) if (registered === name) result = (await hook(event, ctx)) ?? result;
		return result;
	};
	return { pi, seen, fire };
}

async function worker(agentDir: string | undefined = agent) {
	const w = fakeHost();
	await installWorkerGate(w.pi, { agentDir, first: false });
	return w;
}

class SubCtx {
	#cwd: string;
	agent = { kind: "sub", id: "w1", depth: 1 };
	hasUI = true;
	ui = { notify: (): void => undefined };
	sessionManager = { getSessionId: () => "s-w1" };
	constructor(cwd: string) {
		this.#cwd = cwd;
	}
	get cwd(): string {
		return this.#cwd;
	}
}

const nothing = { on: [], tools: [], commands: [], sent: [] };

test("the main agent's run registers nothing, sends nothing and never asks the harness", () => {
	const w = fakeHost();
	expect(installWorkerGate(w.pi, { agentDir: agent, first: true })).toBeUndefined();
	expect(w.seen).toEqual(nothing);
	expect(rec.registered).toEqual([]);
});

test("no agent folder, a harness with a file missing, or the owner's off switch: nothing is registered and nothing throws", () => {
	const w = fakeHost();
	expect(installWorkerGate(w.pi, { agentDir: undefined, first: false })).toBeUndefined();
	expect(installWorkerGate(w.pi, { agentDir: "", first: false })).toBeUndefined();
	expect(installWorkerGate(w.pi, { agentDir: join(root, "nowhere"), first: false })).toBeUndefined();
	rmSync(join(agent, "harness", "gate", "bootstrap.ts"));
	expect(installWorkerGate(w.pi, { agentDir: agent, first: false })).toBeUndefined();
	put(join(agent, "harness", "gate", "bootstrap.ts"), BOOTSTRAP);
	process.env.DONE_GATE_DISABLED = "1";
	try {
		expect(installWorkerGate(w.pi, { agentDir: agent, first: false })).toBeUndefined();
	} finally {
		delete process.env.DONE_GATE_DISABLED;
	}
	expect(w.seen).toEqual(nothing);
	expect(rec.registered).toEqual([]);
});

test("a harness file that does not load or lacks its export registers nothing and says so in one line", async () => {
	const lacking = join(root, "lacking");
	put(join(lacking, "extensions", "done-gate.ts"), "export const other = 1;\n");
	put(join(lacking, "harness", "gate", "bootstrap.ts"), BOOTSTRAP);
	const broken = join(root, "broken");
	put(join(broken, "extensions", "done-gate.ts"), EXTENSION);
	put(join(broken, "harness", "gate", "bootstrap.ts"), "export const = ;\n");
	for (const dir of [lacking, broken]) expect((await worker(dir)).seen).toEqual(nothing);
	expect(said()).toHaveLength(2);
	for (const line of said()) expect(line).toStartWith("dotz worker gate: not installed: ");
	expect(rec.registered).toEqual([]);
});

test("a subagent's run registers one wrapper per gate event, none for session_stop, and drops the gate's tools, commands and late messages", async () => {
	const w = await worker();
	expect(w.seen.on.map(o => o.name).sort()).toEqual([...GATE_EVENTS].sort());
	expect([w.seen.tools, w.seen.commands, w.seen.sent]).toEqual([[], [], []]);
	expect(rec.registered).toEqual([{ keys: "on,registerCommand,registerTool,sendMessage,zod", zod: w.pi.zod }]);
});

test("a subagent's events reach the gate as a main agent's without a UI and answer back; the main agent's events never reach it", async () => {
	const w = await worker();
	const main = { agent: { kind: "main", id: "m" }, cwd: repo, sessionManager: { getSessionId: () => "s-main" } };
	for (const name of GATE_EVENTS) expect(await w.fire(name, {}, main)).toBeUndefined();
	expect(await w.fire("tool_call", {}, {})).toBeUndefined();
	expect(rec.calls).toEqual([]);
	const ctx = new SubCtx(repo);
	expect(await w.fire("tool_result", { toolName: "edit" }, ctx)).toEqual({ additionalContext: "feedback" });
	expect(await w.fire("tool_call", { toolName: "edit" }, ctx)).toBeUndefined();
	expect(rec.calls.map(c => c.name)).toEqual(["tool_result", "tool_call"]);
	const view = rec.calls[0]!.ctx as SubCtx;
	expect(view.agent).toEqual({ kind: "main", worker: true, id: "w1", depth: 1 });
	expect([view.hasUI, view.ui]).toEqual([false, undefined]);
	expect(view.sessionManager).toBe(ctx.sessionManager);
	expect(view.cwd).toBe(repo);
	expect(ctx.agent.kind).toBe("sub");
	expect([ctx.hasUI, typeof ctx.ui.notify]).toEqual([true, "function"]);
});

test("a final message with changes waits for the bootstrap of its repo, which started with the first prompt; the gate's refusal goes to the subagent as a steer, the next final message is let through", async () => {
	const w = await worker();
	const ctx = new SubCtx(join(repo, "src"));
	await w.fire("before_agent_start", { reason: "prompt", prompt: "go" }, ctx);
	await appears("started.log");
	expect(rec.stops).toHaveLength(0);
	await w.fire("agent_start", {}, ctx);
	await w.fire("assistant_message", FINAL, ctx);
	expect(lines("started.log")).toEqual([repo]);
	expect(rec.stops).toEqual([{ finished: 1 }]);
	expect(rec.calls.slice(-2).map(c => c.name)).toEqual(["assistant_message", "session_stop"]);
	expect(rec.calls.at(-1)!.event).toEqual({});
	const stopView = rec.calls.at(-1)!.ctx as SubCtx;
	expect([stopView.agent.kind, stopView.hasUI, stopView.ui, stopView.sessionManager]).toEqual(["main", false, undefined, ctx.sessionManager]);
	expect(w.seen.sent).toEqual([{ message: { customType: "done-gate", display: false, content: "fix the new comment" }, options: { deliverAs: "steer" } }]);
	expect(exclude()).toContain("/.omp/gate.json\n/.omp/lint/\n");
	expect(git(repo, "status", "--porcelain")).toBe("");
	await w.fire("assistant_message", FINAL, ctx);
	expect(rec.stops).toHaveLength(2);
	expect(w.seen.sent).toHaveLength(1);
	expect(said()).toEqual([]);
});

test("a message that calls a tool, was aborted or failed is not judged, though the gate's own handler sees it", async () => {
	const w = await worker();
	const ctx = new SubCtx(repo);
	await w.fire("before_agent_start", {}, ctx);
	const withCall = { stopReason: "toolUse", content: [{ type: "text", text: "x" }, { type: "toolCall", name: "bash" }] };
	for (const message of [withCall, { stopReason: "aborted", content: [] }, { stopReason: "error", content: [] }]) await w.fire("assistant_message", { message }, ctx);
	await appears("finished.log");
	expect(rec.calls.filter(c => c.name === "assistant_message")).toHaveLength(3);
	expect([rec.changed, rec.stops, w.seen.sent]).toEqual([[], [], []]);
});

test("a repo the harness does not want bootstrapped never runs the script or touches info/exclude", async () => {
	rmSync(join(agent, "needs-bootstrap"));
	const before = exclude();
	const w = await worker();
	const ctx = new SubCtx(repo);
	await w.fire("before_agent_start", {}, ctx);
	await w.fire("assistant_message", FINAL, ctx);
	expect(rec.stops).toHaveLength(1);
	expect(w.seen.sent).toHaveLength(1);
	expect(lines("started.log")).toEqual([]);
	expect(exclude()).toBe(before);
});

test("two workers in one repo share one bootstrap, and a repo that was bootstrapped is not run again while the harness still asks", async () => {
	for (let i = 0; i < 3; i++) {
		const w = await worker();
		const ctx = new SubCtx(repo);
		await w.fire("before_agent_start", {}, ctx);
		await w.fire("assistant_message", FINAL, ctx);
	}
	expect(rec.stops.map(s => s.finished)).toEqual([1, 1, 1]);
	expect(lines("started.log")).toEqual([repo]);
	expect(lines("finished.log")).toEqual([repo]);
});

test("a subagent that changed nothing is not judged", async () => {
	rec.files = [];
	const w = await worker();
	const ctx = new SubCtx(repo);
	await w.fire("before_agent_start", {}, ctx);
	await w.fire("assistant_message", FINAL, ctx);
	await appears("finished.log");
	expect([rec.changed.length, rec.stops, w.seen.sent]).toEqual([1, [], []]);
});

test("a bootstrap that fails is told in one line and does not hold the judgement", async () => {
	put(join(agent, "fail"), "");
	const w = await worker();
	const ctx = new SubCtx(repo);
	await w.fire("before_agent_start", {}, ctx);
	await w.fire("assistant_message", FINAL, ctx);
	expect(rec.stops).toEqual([{ finished: 0 }]);
	expect(w.seen.sent).toHaveLength(1);
	expect(said()).toEqual([`dotz worker gate: bootstrap of ${repo}: exited 3`]);
});

test("a bootstrap that hangs is killed with its children at the limit, and the judgement goes on then, not before", async () => {
	put(join(agent, "hang"), "");
	const kill = spyOn(process, "kill");
	try {
		const w = await worker();
		const ctx = new SubCtx(repo);
		await w.fire("before_agent_start", {}, ctx);
		const judged = w.fire("assistant_message", FINAL, ctx);
		await appears("pids");
		await advance(BOOTSTRAP_LIMIT_MS - 1000);
		expect(rec.stops).toHaveLength(0);
		await advance(1000);
		await judged;
		const [script] = readFileSync(join(agent, "pids"), "utf8").split(" ").map(Number);
		expect(kill).toHaveBeenCalledWith(-script!, "SIGKILL");
	} finally {
		kill.mockRestore();
	}
	expect(rec.stops).toHaveLength(1);
	expect(said()).toEqual([`dotz worker gate: bootstrap of ${repo}: timed out after 100 s`]);
});

test("a judgement that throws never throws out of the hook: one line, no steer", async () => {
	rec.broken = true;
	const w = await worker();
	const ctx = new SubCtx(repo);
	await w.fire("before_agent_start", {}, ctx);
	expect(await w.fire("assistant_message", FINAL, ctx)).toBeUndefined();
	await appears("finished.log");
	expect(said()).toEqual(["dotz worker gate: assistant_message hook failed: snapshot failed"]);
	expect([rec.stops, w.seen.sent]).toEqual([[], []]);
});

test("ompHosts tells the main agent's run, the first of a process, from a later one", () => {
	const runs = Symbol.for("dotz.omp.factoryRuns");
	const counter = globalThis as { [runs]?: number };
	const saved = counter[runs];
	delete counter[runs];
	try {
		const { pi } = fakeHost();
		expect([ompHosts(pi).first, ompHosts(pi).first, ompHosts(pi, { topLevel: true }).first]).toEqual([true, false, false]);
	} finally {
		if (saved === undefined) delete counter[runs];
		else counter[runs] = saved;
	}
});
