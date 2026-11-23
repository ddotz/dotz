import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS } from "./guard-config.ts";
import { installGuard, installSubagentGuard } from "./guard.ts";
import { CODING_HARNESS_ENV } from "./harness-gate.ts";
import { difficultyOf, forgetRoutes } from "./worker-route.ts";

const ENV_KEYS = ["DOTZ_DIR", "DOTZ_CONV", "DOTZ_LANE", "DOTZ_ORCHESTRATOR", "DOTZ_OWNER_ASKED_FABLE", "DOTZ_RUNTIME", "DOTZ_WORKER_ROUTES_FILE", "ORCH_GUARD_STATE_DIR"];
let saved: Record<string, string | undefined>;
let dir: string;
let routesFile: string;
beforeEach(() => {
	forgetRoutes();
	saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
	dir = mkdtempSync(join(tmpdir(), "dotz-worker-route-"));
	mkdirSync(join(dir, "state"), { recursive: true });
	process.env.DOTZ_DIR = dir;
	process.env.ORCH_GUARD_STATE_DIR = join(dir, "orch");
	for (const k of ["DOTZ_CONV", "DOTZ_LANE", "DOTZ_ORCHESTRATOR", "DOTZ_OWNER_ASKED_FABLE"]) delete process.env[k];
	routesFile = join(dir, "omp-routes.json");
	process.env.DOTZ_WORKER_ROUTES_FILE = routesFile;
});
afterEach(() => {
	for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
	rmSync(dir, { recursive: true, force: true });
});

const ROUTES = {
	light: { selector: "anthropic/claude-sonnet-5-5:high", basis: "benchmark", score: 41.52, cost: 1.64 },
	standard: { selector: "anthropic/claude-opus-5-5:medium", basis: "configured", score: 48.21, cost: 2.45 },
	hard: { selector: "anthropic/claude-opus-5-5:high", basis: "benchmark", score: 51.84, cost: 3.46 },
};
const writeRoutes = (routes: unknown = ROUTES) => writeFileSync(routesFile, JSON.stringify(routes));

function setup(config = { ...GUARD_DEFAULTS, budget_gate: false }, sessionFile?: string) {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const pi: any = {
		pi: { getAgentDir: () => join(dir, "agent") },
		logger: { warn: () => {} },
		on: (name: string, fn: any) => (handlers[name] ??= []).push(fn),
		registerCommand: () => {},
		registerTool: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	installGuard(pi, config);
	const ctx = { agent: { kind: "main" }, cwd: dir, hasUI: true, sessionManager: { getSessionId: () => "s", getSessionFile: () => sessionFile } };
	const task = async (input: any) => (await handlers.tool_call[0]({ toolName: "task", input }, ctx)).input;
	const spawn = (agent: string, spawnKey: string, patterns: string[] = [ROUTES.standard.selector]) => handlers.before_subagent_spawn[0]({ agent, spawnKey, invocationKind: "task", patterns });
	return { task, spawn, handlers };
}
const item = (extra: object) => ({ agent: "task", task: "do it\nAcceptance: reported", ...extra });
const call = (...tasks: object[]) => ({ context: "shared background", tasks });

test("difficultyOf: lo is light, hi is hard, an omitted or any other value is standard", () => {
	expect([difficultyOf("lo"), difficultyOf("hi"), difficultyOf("med"), difficultyOf(undefined), difficultyOf(null), difficultyOf("HI"), difficultyOf(3)]).toEqual(["light", "hard", "standard", "standard", "standard", "standard", "standard"]);
});

test("a batch of two named items and one unnamed: names are kept or added, effort is gone from every item, and a scout item is not routed", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	const out = await task(call(item({ name: "AlphaHard", effort: "hi" }), { agent: "scout", name: "BetaScout", task: "find it\nAcceptance: reported", effort: "hi" }, item({ effort: "lo" })));
	const names: string[] = out.tasks.map((t: { name: string }) => t.name);
	expect(names.slice(0, 2)).toEqual(["AlphaHard", "BetaScout"]);
	expect(names[2]).toBeString();
	expect(new Set(names.map(n => n.toLowerCase())).size).toBe(3);
	expect(out.tasks.some((t: object) => "effort" in t)).toBe(false);

	expect(spawn("task", "AlphaHard")).toEqual({ model: "anthropic/claude-opus-5-5:high", note: "hard: claude-opus-5-5 high (51.84 / $3.46)" });
	expect(spawn("scout", "BetaScout")).toBeUndefined();
	expect(spawn("task", names[2]!)).toEqual({ model: "anthropic/claude-sonnet-5-5:high", note: "light: claude-sonnet-5-5 high (41.52 / $1.64)" });
});

test("a flat call is named and loses effort too", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	const out = await task({ ...item({ effort: "hi" }), context: undefined });
	expect(out.effort).toBeUndefined();
	expect(out.name).toBeString();
	expect(spawn("task", out.name)?.model).toBe("anthropic/claude-opus-5-5:high");
});

test("a standard item (effort omitted or med) is left on the configured worker level, an unknown spawn key and a second event for the same key route nothing", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	await task(call(item({ name: "OmittedOne" }), item({ name: "MediumOne", effort: "med" }), item({ name: "HardOne", effort: "hi" })));
	expect(spawn("task", "OmittedOne")).toBeUndefined();
	expect(spawn("task", "MediumOne")).toBeUndefined();
	expect(spawn("task", "NobodyKnowsThis")).toBeUndefined();
	expect(spawn("task", "HardOne")?.model).toBe("anthropic/claude-opus-5-5:high");
	expect(spawn("task", "HardOne")).toBeUndefined();
});

test("a route without a benchmark row names only the model and level; a route equal to the standard one routes nothing", async () => {
	writeRoutes({ ...ROUTES, hard: { selector: "acme/new-model:high", basis: "ladder" }, light: ROUTES.standard });
	const { task, spawn } = setup();
	await task(call(item({ name: "LadderHard", effort: "hi" }), item({ name: "SameLight", effort: "lo" })));
	expect(spawn("task", "LadderHard")).toEqual({ model: "acme/new-model:high", note: "hard: new-model high" });
	expect(spawn("task", "SameLight")).toBeUndefined();
});

test("without a table no spawn is routed and no name is added, but effort is gone: no file, a malformed file, or a file read again after it was fixed", async () => {
	const { task, spawn } = setup();
	const original = () => call(item({ name: "KeepMe", effort: "hi" }), item({ effort: "lo" }));
	for (const state of ["missing", "malformed", "incomplete"]) {
		if (state === "malformed") writeFileSync(routesFile, "{not json");
		if (state === "incomplete") writeRoutes({ hard: ROUTES.hard });
		const out = await task(original());
		expect(out.tasks.some((t: object) => "effort" in t)).toBe(false);
		expect(out.tasks[0].name).toBe("KeepMe");
		expect(out.tasks[1].name).toBeUndefined();
		expect(spawn("task", "KeepMe")).toBeUndefined();
	}
	writeRoutes();
	const fixed = await task(call(item({ name: "KeepMe", effort: "hi" })));
	expect(fixed.tasks[0].effort).toBeUndefined();
	expect(spawn("task", "KeepMe")?.model).toBe("anthropic/claude-opus-5-5:high");
});

test("under the OmO runtime the task input is left alone; under omp an item that also carries a prompt still loses effort", async () => {
	writeRoutes();
	const { task } = setup();
	process.env.DOTZ_RUNTIME = "omo";
	const omo = await task({ prompt: "check it\nDone when: reported", effort: "hi" });
	expect(omo.effort).toBe("hi");
	expect(omo.name).toBeUndefined();
	process.env.DOTZ_RUNTIME = "omp";
	const omp = await task(call(item({ name: "Stray", effort: "hi", prompt: "x\nAcceptance: reported" })));
	expect(omp.tasks[0]).not.toHaveProperty("effort");
});

test("a route the expensive-model gate refuses right now is not returned; the owner's ask lifts it", async () => {
	writeRoutes({ ...ROUTES, hard: { selector: "anthropic/claude-opus-5-5:max", basis: "benchmark", score: 59.11, cost: 10.04 } });
	const { task, spawn } = setup({ ...GUARD_DEFAULTS, budget_gate: false, ask_before_expensive: true, expensive_models: ["fable", ":xhigh", ":max"] });
	await task(call(item({ name: "DearOne", effort: "hi" }), item({ name: "DearTwo", effort: "hi" })));
	expect(spawn("task", "DearOne")).toBeUndefined();
	process.env.DOTZ_OWNER_ASKED_FABLE = "1";
	expect(spawn("task", "DearTwo")?.model).toBe("anthropic/claude-opus-5-5:max");
});

test("omp's allocated ids: a repeated name arrives as Name-2 and still gets its own difficulty", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	await task(call(item({ name: "Fix", effort: "lo" })));
	expect(spawn("task", "Fix")?.model).toBe("anthropic/claude-sonnet-5-5:high");
	await task(call(item({ name: "Fix", effort: "hi" })));
	expect(spawn("task", "Fix-2")?.model).toBe("anthropic/claude-opus-5-5:high");
	expect(spawn("task", "Fix-2")).toBeUndefined();
});

test("names are unique inside one call too: a repeat is renamed after the names already let through, and each item keeps its own difficulty", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	const out = await task(call(item({ name: "Fix", effort: "lo" }), item({ name: "Fix-2", effort: "hi" }), item({ name: "Fix", effort: "hi" })));
	expect(out.tasks.map((t: { name: string }) => t.name)).toEqual(["Fix", "Fix-2", "Fix-3"]);
	expect(spawn("task", "Fix")?.model).toBe("anthropic/claude-sonnet-5-5:high");
	expect(spawn("task", "Fix-2")?.model).toBe("anthropic/claude-opus-5-5:high");
	expect(spawn("task", "Fix-3")?.model).toBe("anthropic/claude-opus-5-5:high");
});

test("a name with spaces around it is remembered under the trimmed name omp allocates from", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	await task(call(item({ name: "  Spaced  ", effort: "hi" }), item({ name: "   ", effort: "lo" })));
	expect(spawn("task", "Spaced")?.model).toBe("anthropic/claude-opus-5-5:high");
});

test("a name let through before, in any case, is renamed with the smallest free suffix; an unnamed item still gets a name no other item has", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	await task(call(item({ name: "Take", effort: "lo" })));
	const out = await task(call(item({ name: "take", effort: "hi" }), item({ name: "Take-2", effort: "lo" }), item({ name: "TAKE", effort: "hi" }), item({ effort: "lo" })));
	const names: string[] = out.tasks.map((t: { name: string }) => t.name);
	expect(names.slice(0, 3)).toEqual(["take-2", "Take-2-2", "TAKE-3"]);
	expect(new Set(names.map(n => n.toLowerCase())).size).toBe(4);
	expect(spawn("task", "take-2")?.model).toBe("anthropic/claude-opus-5-5:high");
	expect(spawn("task", "Take-2-2")?.model).toBe("anthropic/claude-sonnet-5-5:high");
	expect(spawn("task", "TAKE-3")?.model).toBe("anthropic/claude-opus-5-5:high");
});

test("a spawn the expensive gate refuses still takes its entry, so a later spawn of that name is not routed by it", async () => {
	writeRoutes();
	const { task, spawn } = setup({ ...GUARD_DEFAULTS, budget_gate: false, ask_before_expensive: true, expensive_models: ["fable"] });
	await task(call(item({ name: "Gated", effort: "hi" })));
	expect(spawn("task", "Gated", ["anthropic/claude-fable-5-2"])).toMatchObject({ block: true });
	expect(spawn("task", "Gated")).toBeUndefined();
});

test("a queued spawn keeps its difficulty: a later call with the same name is renamed, so each spawn finds its own entry", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	await task(call(item({ name: "Fix", effort: "hi" })));
	const later = await task(call(item({ name: "Fix", effort: "lo" })));
	expect(later.tasks[0].name).toBe("Fix-2");
	expect(spawn("task", "Fix")?.model).toBe("anthropic/claude-opus-5-5:high");
	expect(spawn("task", "Fix-2")?.model).toBe("anthropic/claude-sonnet-5-5:high");
});

test("an entry left by a call that never spawned does not bind a later item of that name", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	await task(call(item({ name: "Fix", effort: "hi" })));
	const later = await task(call(item({ name: "Fix", effort: "lo" })));
	expect(later.tasks[0].name).toBe("Fix-2");
	expect(spawn("task", "Fix-2")?.model).toBe("anthropic/claude-sonnet-5-5:high");
});

test("after a restart nothing is let through yet, so a spawn keyed Fix-2 (omp's suffix for an id from before the restart) takes the pending Fix", async () => {
	writeRoutes();
	const { task, spawn } = setup();
	const out = await task(call(item({ name: "Fix", effort: "hi" })));
	expect(out.tasks[0].name).toBe("Fix");
	expect(spawn("task", "Fix-2")?.model).toBe("anthropic/claude-opus-5-5:high");
});

test("an eval-started spawn does not take a task call's entry", async () => {
	writeRoutes();
	const { task, handlers } = setup();
	await task(call(item({ name: "Mine", effort: "hi" })));
	expect(handlers.before_subagent_spawn[0]({ agent: "task", spawnKey: "Mine", invocationKind: "eval", patterns: [ROUTES.standard.selector] })).toMatchObject({ block: true });
	expect(handlers.before_subagent_spawn[0]({ agent: "task", spawnKey: "Mine", invocationKind: "task", patterns: [ROUTES.standard.selector] })?.model).toBe("anthropic/claude-opus-5-5:high");
});

test("a subagent's own task call loses effort, whether or not a routes table is loaded, and remembers nothing for a main-agent spawn of that name", async () => {
	for (const table of [false, true]) {
		if (table) writeRoutes();
		const { spawn } = setup();
		const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
		installSubagentGuard({ on: (name: string, fn: any) => void (handlers[name] ??= []).push(fn) }, { ...GUARD_DEFAULTS, budget_gate: false, defer_to_installed: false });
		const ctx = { agent: { kind: "sub", id: "w", depth: 1 }, cwd: dir };
		const input = call(item({ name: "Nested", effort: "hi" }));
		const result = await handlers.tool_call[0]({ toolName: "task", input }, ctx);
		expect(result?.block).toBeUndefined();
		expect((result?.input ?? input).tasks[0]).not.toHaveProperty("effort");
		expect(spawn("task", "Nested")).toBeUndefined();
	}
});

const PAYLOAD_CHILD = `
import { installGuard, installSubagentGuard } from ${JSON.stringify(join(import.meta.dir, "guard.ts"))};
const host = () => { const handlers = {}; return { handlers, pi: { pi: { getAgentDir: () => process.env.TEST_AGENT_DIR }, zod: new Proxy({}, { get: () => () => host.zod }), logger: { warn() {}, info() {} }, on: (n, f) => (handlers[n] ??= []).push(f), registerCommand() {}, registerTool() {}, sendMessage() {}, sendUserMessage() {}, getThinkingLevel: () => "low" } }; };
const main = host(), sub = host();
installGuard(main.pi);
installSubagentGuard(sub.pi);
const mainCtx = { agent: { kind: "main", id: "main", depth: 0 }, cwd: process.env.DOTZ_DIR, hasUI: false, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } };
const subCtx = { ...mainCtx, agent: { kind: "sub", id: "w", depth: 1 } };
const items = name => ({ context: "c", tasks: [{ agent: "task", task: "x\\nAcceptance: reported", name, effort: "hi" }] });
const run = async (h, input, ctx) => { let last = input; for (const f of h.handlers.tool_call) { const r = await f({ toolName: "task", input }, ctx); if (r?.block) return { blocked: true }; if (r?.input) last = r.input; } return { input: last }; };
const mainCall = await run(main, items("PayloadHard"), mainCtx);
const subCall = await run(sub, items("SubHard"), subCtx);
const spawn = key => main.handlers.before_subagent_spawn.map(f => f({ agent: "task", spawnKey: key, invocationKind: "task", patterns: [] })).find(Boolean);
console.log(JSON.stringify({ mainEffort: "effort" in mainCall.input.tasks[0], subEffort: "effort" in subCall.input.tasks[0], routed: spawn("PayloadHard")?.model ?? null, subRouted: spawn("SubHard")?.model ?? null }));
`;

test("a coding lane's payload path strips effort in main and subagent task calls, routes the main session's remembered item and nothing a subagent named", () => {
	const payload = join(dir, "payload");
	mkdirSync(join(payload, "extensions"), { recursive: true });
	mkdirSync(join(dir, "agent"), { recursive: true });
	mkdirSync(join(dir, "data", "memory"), { recursive: true });
	for (const name of ["orchestrator-guard", "harness-tools", "done-gate"]) writeFileSync(join(payload, "extensions", `${name}.ts`), "export default () => {};\n");
	writeRoutes();
	const env = { ...process.env, TEST_AGENT_DIR: join(dir, "agent"), DOTZ_DIR: join(dir, "data"), DOTZ_LANE: "lane1", DOTZ_RUNTIME: "omp", DOTZ_WORKER_ROUTES_FILE: routesFile, [CODING_HARNESS_ENV]: payload };
	const r = Bun.spawnSync([process.execPath, "-e", PAYLOAD_CHILD], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	expect(JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!)).toEqual({ mainEffort: false, subEffort: false, routed: "anthropic/claude-opus-5-5:high", subRouted: null });
});

test("with the guard switched off effort still never reaches omp: the main and the subagent handler strip it, name nothing, route nothing and leave other tools alone", async () => {
	writeRoutes();
	const off = { ...GUARD_DEFAULTS, enabled: false };
	const main = setup(off);
	expect(main.handlers.before_subagent_spawn).toBeUndefined();
	const mainOut = await main.task(call(item({ name: "OffMain", effort: "hi" }), item({ effort: "lo" })));
	expect(mainOut.tasks.some((t: object) => "effort" in t)).toBe(false);
	expect(mainOut.tasks.map((t: { name?: string }) => t.name)).toEqual(["OffMain", undefined]);
	expect(await main.handlers.tool_call[0]({ toolName: "bash", input: { command: "ls" } }, { agent: { kind: "main" }, cwd: dir })).toBeUndefined();

	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	installSubagentGuard({ on: (name: string, fn: any) => void (handlers[name] ??= []).push(fn) }, off);
	const input = call(item({ name: "OffSub", effort: "hi" }));
	const result = await handlers.tool_call[0]({ toolName: "task", input }, { agent: { kind: "sub", id: "w", depth: 1 }, cwd: dir });
	expect((result?.input ?? input).tasks[0]).not.toHaveProperty("effort");
	expect(handlers.before_subagent_spawn).toBeUndefined();
});

test("a resumed session: a name its earlier run left on disk is renamed like any repeat, so two items reusing it each get their own difficulty", async () => {
	writeRoutes();
	const sessionFile = join(dir, "session-1.jsonl");
	mkdirSync(join(dir, "session-1"), { recursive: true });
	for (const file of ["Fix.md", "Fix.jsonl", "notes.txt"]) writeFileSync(join(dir, "session-1", file), "");
	const { task, spawn } = setup(undefined, sessionFile);
	const out = await task(call(item({ name: "Fix", effort: "hi" }), item({ name: "Fix", effort: "lo" }), item({ name: "notes", effort: "hi" })));
	expect(out.tasks.map((t: { name: string }) => t.name)).toEqual(["Fix-2", "Fix-3", "notes"]);
	expect(spawn("task", "Fix-2")?.model).toBe("anthropic/claude-opus-5-5:high");
	expect(spawn("task", "Fix-3")?.model).toBe("anthropic/claude-sonnet-5-5:high");
});
