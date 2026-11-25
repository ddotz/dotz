import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS, installedOriginal, statePath } from "./guard-config.ts";
import { payloadWorkerRunning } from "./guard-dotz.ts";
import { CODING_HARNESS_ENV } from "./harness-gate.ts";
import { installGuard } from "./guard.ts";

let root: string;
let payload: string;
let agent: string;
const NAMES = ["orchestrator-guard", "harness-tools", "done-gate"];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-guard-coding-"));
	payload = join(root, "payload");
	agent = join(root, "agent");
	mkdirSync(join(payload, "extensions"), { recursive: true });
	mkdirSync(agent, { recursive: true });
	for (const name of NAMES) writeFileSync(join(payload, "extensions", `${name}.ts`), "export default () => {};\n");
});

afterEach(() => {
	delete process.env[CODING_HARNESS_ENV];
	rmSync(root, { recursive: true, force: true });
});

const agentPi = () => ({ pi: { getAgentDir: () => agent } });

const CHILD = `
import { installGuard, installSubagentGuard } from ${JSON.stringify(join(import.meta.dir, "guard.ts"))};
import { installHarnessTools } from ${JSON.stringify(join(import.meta.dir, "harness-tools.ts"))};
import { installSubagentBrief } from ${JSON.stringify(join(import.meta.dir, "subagent-brief.ts"))};
const handlers = {}, commands = [], tools = [];
const pi = {
	pi: { getAgentDir: () => process.env.TEST_AGENT_DIR },
	zod: new Proxy({}, { get: () => () => pi.zod }),
	logger: { warn: () => {} },
	on: (name, fn) => (handlers[name] ??= []).push(fn),
	registerCommand: name => commands.push(name),
	registerTool: tool => tools.push(tool.name),
	sendMessage: () => {},
	sendUserMessage: () => {},
};
installGuard(pi);
installSubagentGuard(pi);
installSubagentBrief(pi);
installHarnessTools(pi);
console.log(JSON.stringify({ handlers: Object.fromEntries(Object.entries(handlers).map(([k, v]) => [k, v.length])), commands, tools }));
`;

function installInFreshProcess(marker: string | undefined): { handlers: Record<string, number>; commands: string[]; tools: string[] } {
	const env: Record<string, string | undefined> = { ...process.env, TEST_AGENT_DIR: agent, [CODING_HARNESS_ENV]: marker };
	const r = Bun.spawnSync([process.execPath, "-e", CHILD], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
}

test("the marker with the payload's extension present: harness tools stand down and the guard drops every hook only its generic checks use", () => {
	const run = installInFreshProcess(payload);
	expect(run.tools).toEqual([]);
	expect(run.handlers.tool_call).toBeGreaterThan(0);
	for (const generic of ["session_start", "context", "input", "tool_result", "agent_end", "session_compact"]) expect(run.handlers[generic]).toBeUndefined();
	process.env[CODING_HARNESS_ENV] = payload;
	expect(installedOriginal(agentPi(), "orchestrator-guard")).toBe(join(payload, "extensions", "orchestrator-guard.ts"));
	expect(installedOriginal(agentPi(), "harness-tools")).toBe(join(payload, "extensions", "harness-tools.ts"));
});

test("the restart hold sees a worker as running from the payload guard's own state file", () => {
	const cwd = join(root, "repo");
	const state = join(payload, "orchestrator-state");
	mkdirSync(state, { recursive: true });
	process.env.DOTZ_LANE = "lane1";
	const running = payloadWorkerRunning(payload);
	expect(running({ cwd }, "w1")).toBe(false);
	writeFileSync(statePath(state, cwd, "lane1"), JSON.stringify({ workers: { w1: { status: "running" }, w2: { status: "done" } } }));
	expect(running({ cwd }, "w1")).toBe(true);
	expect(running({ cwd }, "w2")).toBe(false);
	delete process.env.DOTZ_LANE;
});

test("the marker counts under --no-extensions, which hides every agent-dir original", () => {
	process.env[CODING_HARNESS_ENV] = payload;
	const argv = process.argv;
	process.argv = [...argv, "--no-extensions"];
	try {
		expect(installedOriginal(agentPi(), "orchestrator-guard")).toBe(join(payload, "extensions", "orchestrator-guard.ts"));
	} finally {
		process.argv = argv;
	}
});

test("defer_to_installed=false still runs the guard in a coding session", () => {
	process.env[CODING_HARNESS_ENV] = payload;
	const handlers: Record<string, number> = {};
	const pi = { ...agentPi(), logger: { warn: () => {} }, on: (name: string) => (handlers[name] = (handlers[name] ?? 0) + 1), registerCommand: () => {}, registerTool: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
	installGuard(pi, { ...GUARD_DEFAULTS, defer_to_installed: false });
	expect(handlers.tool_call).toBe(1);
});

test("the marker with the payload's extension missing registers the copies as without a marker", () => {
	process.env[CODING_HARNESS_ENV] = join(root, "nowhere");
	expect(installedOriginal(agentPi(), "orchestrator-guard")).toBeUndefined();
	const run = installInFreshProcess(join(root, "nowhere"));
	expect(run.handlers.tool_call).toBeGreaterThan(0);
	expect(run.handlers.before_subagent_spawn).toBeGreaterThan(0);
	expect(run.commands.length + run.tools.length).toBeGreaterThan(0);
});

test("a payload with another extension present only stands down that name", () => {
	process.env[CODING_HARNESS_ENV] = payload;
	rmSync(join(payload, "extensions", "harness-tools.ts"));
	expect(installedOriginal(agentPi(), "harness-tools")).toBeUndefined();
	expect(installedOriginal(agentPi(), "orchestrator-guard")).toBeDefined();
});
