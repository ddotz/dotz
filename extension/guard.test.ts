// The worker guard and its config: brief checks, output trimming, external-action list, the personal expensive-model
// gate (off by default), budget gate, repeat/cycle block, deferral to an installed original, and the config defaults.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS, guardConfigFrom, installedOriginal, loadGuardConfig } from "./guard-config.ts";
import { budgetLine, budgetProblem, checkOmoTaskInput, checkTaskInput, estimateFrom, expensiveModel, expensiveTaskModel, externalAction, installGuard, relativizeRoots, settleFromText, shouldIsolate, shellText, trimWaitOutput } from "./guard.ts";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-guard-"));
	process.env.ORCH_GUARD_STATE_DIR = join(dir, "state");
});
afterAll(() => {
	delete process.env.ORCH_GUARD_STATE_DIR;
	rmSync(dir, { recursive: true, force: true });
});

// A minimal omp `pi`: records handlers and commands; `agent` is the agent directory the install detection looks in.
function fakePi(agent: string) {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const commands: string[] = [];
	const logs: string[] = [];
	const pi = {
		pi: { getAgentDir: () => agent },
		logger: { warn: (m: string) => logs.push(m) },
		on: (name: string, fn: (event: any, ctx: any) => any) => (handlers[name] ??= []).push(fn),
		registerCommand: (name: string) => commands.push(name),
		registerTool: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	return { pi, handlers, commands, logs };
}

const noGate = { ...GUARD_DEFAULTS, budget_gate: false };
const brief = (task: string) => ({ tasks: [{ agent: "task", task }] });

test("config: every key optional, defaults are the generic behaviour, bad values fall back", () => {
	expect(loadGuardConfig(join(dir, "no-such-dir"))).toEqual(GUARD_DEFAULTS);
	expect(GUARD_DEFAULTS).toMatchObject({ enabled: true, max_brief_chars: 8000, max_fence_lines: 40, budget_gate: true, ask_before_expensive: false, expensive_models: [] });
	const c = guardConfigFrom({ max_brief_chars: 100, max_fence_lines: -5, enabled: "yes", expensive_models: ["fable", 3, " "], external_commands: ["foo"] });
	expect(c.max_brief_chars).toBe(100);
	expect(c.max_fence_lines).toBe(40);
	expect(c.enabled).toBe(true);
	expect(c.expensive_models).toEqual(["fable"]);
	expect(c.external_commands).toEqual(["foo"]);
	mkdirSync(join(dir, "cfg"), { recursive: true });
	writeFileSync(join(dir, "cfg", "config.json"), JSON.stringify({ guard: { enabled: false, worker_answer_chars: 300 } }));
	expect(loadGuardConfig(join(dir, "cfg"))).toMatchObject({ enabled: false, worker_answer_chars: 300, max_brief_chars: 8000 });
});

test("brief: done-condition required, size and fence caps, budget line appended once, limits configurable", () => {
	const noDone = checkTaskInput(brief("do the thing"));
	expect("reason" in noDone && noDone.reason).toContain("done-condition");
	const ok = checkTaskInput(brief("do the thing\nAcceptance: tests pass"));
	expect("input" in ok).toBe(true);
	if (!("input" in ok)) return;
	expect(ok.input.tasks[0].task).toEndWith(budgetLine());
	expect(ok.input.tasks[0].isolated).toBe(true);
	const again = checkTaskInput(ok.input);
	expect("input" in again && again.input.tasks[0].task.match(/\[orchestrator-guard\]/g)?.length).toBe(1);
	expect(budgetLine({ ...GUARD_DEFAULTS, worker_answer_chars: 300, worker_context_tokens: 200_000 })).toContain("at most 300 characters");
	const big = checkTaskInput(brief(`Acceptance: x\n${"y".repeat(9000)}`));
	expect("reason" in big && big.reason).toContain("limit 8000");
	const small = checkTaskInput(brief(`Acceptance: x\n${"y".repeat(200)}`), true, [], { ...GUARD_DEFAULTS, max_brief_chars: 100 });
	expect("reason" in small && small.reason).toContain("limit 100");
	const fence = `\`\`\`\n${"line\n".repeat(41)}\`\`\``;
	const fenced = checkTaskInput(brief(`Acceptance: x\n${fence}`));
	expect("reason" in fenced && fenced.reason).toContain("code block over 40 lines");
	expect("input" in checkTaskInput(brief(`Acceptance: x\n${fence}`), true, [], { ...GUARD_DEFAULTS, max_fence_lines: 60 })).toBe(true);
});

test("brief: checkout roots become cwd-relative in isolated briefs", () => {
	expect(relativizeRoots("edit /a/repo/src/x.ts and /a/repo", ["/a/repo"])).toBe("edit src/x.ts and .");
	const verdict = checkTaskInput(brief("edit /a/repo/src/x.ts\nAcceptance: ok"), true, ["/a/repo"]);
	expect("input" in verdict && verdict.input.tasks[0].task).toContain("edit src/x.ts");
});

test("worker output trimming follows max_output_chars", () => {
	const text = `<task-result id="w1" status="done">\n<output>\n${"z".repeat(3000)}\n</output>\n</task-result>`;
	expect(trimWaitOutput(text)).toContain("output trimmed from 3000 chars; full text at history://w1");
	expect(trimWaitOutput(text, { ...GUARD_DEFAULTS, max_output_chars: 5000 })).toBe(text);
});

test("external actions: built-in list plus configured patterns, no owner-specific default", () => {
	expect(externalAction("git push origin main")).toBe("git push");
	expect(externalAction("gh pr merge 3")).toBe("gh write");
	expect(externalAction("ssh host ls")).toBe("remote host");
	expect(externalAction("curl -X POST https://x.test")).toBe("outbound HTTP write");
	expect(externalAction("curl -X POST http://localhost:1/a")).toBeUndefined();
	expect(externalAction("ls -la")).toBeUndefined();
	expect(externalAction("notify-owner --text hi", [])).toBeUndefined();
	expect(externalAction("notify-owner --text hi", ["^notify-owner\\b"])).toContain("configured pattern");
});

test("expensive-model gate is off by default and matches the configured list when on", () => {
	expect(expensiveModel("anthropic/claude-fable-1")).toBeUndefined();
	expect(expensiveTaskModel({ model: "anthropic/fable:max", tasks: [] })).toBeUndefined();
	const on = { ...GUARD_DEFAULTS, ask_before_expensive: true, expensive_models: ["fable", ":max", ":xhigh"] };
	expect(expensiveModel("anthropic/claude-Fable-1", on)).toBeDefined();
	expect(expensiveModel("anthropic/claude-opus:max", on)).toBeDefined();
	expect(expensiveModel(["x", ":xhigh"], on)).toBeDefined();
	expect(expensiveModel("anthropic/claude-opus:maximal", on)).toBeUndefined();
	expect(expensiveModel("anthropic/claude-sonnet:high", on)).toBeUndefined();
	expect(expensiveTaskModel({ tasks: [{ model: "x/fable" }] }, on)).toBe("x/fable");
	// a list without the switch gates nothing
	expect(expensiveModel("fable", { ...GUARD_DEFAULTS, expensive_models: ["fable"] })).toBeUndefined();
});

test("budget gate: 5h only, margin and estimate configurable, silent without 5h data", () => {
	const limits = [{ id: "anthropic:5h", amount: { remaining: 20 } }, { id: "anthropic:7d", amount: { remaining: 3 } }];
	expect(budgetProblem(limits, 2, 15, 10)).toContain("5h window 20% left");
	expect(budgetProblem(limits, 2, 5, 10)).toBeUndefined();
	expect(budgetProblem(limits, 2, 15, 3)).toBeUndefined();
	expect(budgetProblem([{ id: "anthropic:7d", amount: { remaining: 1 } }], 1)).toBeUndefined();
	expect(budgetProblem([], 1)).toBeUndefined();
	expect(estimateFrom(brief("Estimate: 30%\nAcceptance: x"))).toBe(30);
	expect(estimateFrom(brief("Acceptance: x"), { ...GUARD_DEFAULTS, budget_default_estimate_percent: 22 })).toBe(22);
});

test("hooks: a brief without a done-condition is blocked, one with it passes and is rewritten", async () => {
	const { pi, handlers, commands } = fakePi(join(dir, "agent-empty"));
	installGuard(pi, noGate);
	expect(commands).toContain("compact-switch");
	expect(commands).not.toContain("budget-ok");
	expect(commands).not.toContain("fable-ok");
	const ctx = { agent: { kind: "main" }, cwd: dir, sessionManager: { getSessionId: () => "s1" } };
	const [toolCall] = handlers.tool_call;
	const blocked = await toolCall({ toolName: "task", input: brief("do it") }, ctx);
	expect(blocked.block).toBe(true);
	expect(blocked.reason).toContain("done-condition");
	const passed = await toolCall({ toolName: "task", input: brief("do it\nDone when: file exists") }, ctx);
	expect(passed.input.tasks[0].task).toContain(budgetLine(noGate));
});

test("hooks: the owner rule registers /fable-ok and blocks an expensive task model; DOTZ_OWNER_ASKED_FABLE lifts it", async () => {
	const { pi, handlers, commands } = fakePi(join(dir, "agent-empty"));
	installGuard(pi, { ...noGate, ask_before_expensive: true, expensive_models: ["fable"] });
	expect(commands).toContain("fable-ok");
	expect(handlers.before_subagent_spawn?.length).toBe(1);
	const ctx = { agent: { kind: "main" }, cwd: dir, sessionManager: { getSessionId: () => "s2" } };
	const input = { model: "anthropic/fable", tasks: [{ agent: "task", task: "x\nAcceptance: y" }] };
	const blocked = await handlers.tool_call[0]({ toolName: "task", input }, ctx);
	expect(blocked.reason).toContain("expensive model");
	expect(handlers.before_subagent_spawn[0]({ agent: "task", patterns: ["anthropic/fable"] })).toMatchObject({ block: true });
	process.env.DOTZ_OWNER_ASKED_FABLE = "1";
	try {
		expect((await handlers.tool_call[0]({ toolName: "task", input }, ctx)).block).toBeUndefined();
	} finally {
		delete process.env.DOTZ_OWNER_ASKED_FABLE;
	}
});

test("hooks: an identical call repeated in a loop is blocked", async () => {
	const { pi, handlers } = fakePi(join(dir, "agent-empty"));
	installGuard(pi, noGate);
	const ctx = { agent: { kind: "sub", id: "w1" }, hasUI: false, sessionManager: { getSessionId: () => "loop" } };
	const call = (id: string) => handlers.tool_call[0]({ toolName: "read", toolCallId: id, input: { path: "same.txt" } }, ctx);
	const verdicts = [];
	for (let i = 0; i < 9; i++) verdicts.push(await call(`c${i}`));
	expect(verdicts.slice(0, 7).every(v => v === undefined)).toBe(true);
	expect(verdicts[7]?.block).toBe(true);
	expect(verdicts[7]?.reason).toContain("repeat guard");
	// a different call is let through again
	expect(await handlers.tool_call[0]({ toolName: "read", toolCallId: "d", input: { path: "other.txt" } }, ctx)).toBeUndefined();
});

test("hooks: workers cannot run external-impact commands and a second compaction stops them", async () => {
	const { pi, handlers } = fakePi(join(dir, "agent-empty"));
	installGuard(pi, { ...noGate, external_commands: ["^deploy-tool\\b"] });
	const ctx = { agent: { kind: "sub", id: "w2" }, sessionManager: { getSessionId: () => "ext" } };
	const push = await handlers.tool_call[0]({ toolName: "bash", input: { command: "git push origin x" } }, ctx);
	expect(push.reason).toContain("External actions needed");
	const own = await handlers.tool_call[0]({ toolName: "bash", input: { command: "deploy-tool prod" } }, ctx);
	expect(own.block).toBe(true);
	handlers.session_compact[0]({}, ctx);
	handlers.session_compact[0]({}, ctx);
	const stopped = await handlers.tool_call[0]({ toolName: "bash", input: { command: "echo hi" } }, ctx);
	expect(stopped.reason).toContain("compacted twice");
});

test("hooks: patch apply needs a read first", async () => {
	const { pi, handlers } = fakePi(join(dir, "agent-empty"));
	installGuard(pi, noGate);
	const ctx = { agent: { kind: "main" }, cwd: dir, sessionManager: { getSessionId: () => "apply" } };
	const apply = { toolName: "bash", input: { command: "git apply /tmp/w1.patch" } };
	expect((await handlers.tool_call[0](apply, ctx)).reason).toContain("review before apply");
	await handlers.tool_call[0]({ toolName: "read", input: { path: "/tmp/w1.patch" } }, ctx);
	expect(await handlers.tool_call[0](apply, ctx)).toBeUndefined();
});

test("install: enabled=false registers nothing; an installed original defers this copy and logs once", () => {
	const off = fakePi(join(dir, "agent-empty"));
	installGuard(off.pi, { ...GUARD_DEFAULTS, enabled: false });
	expect(Object.keys(off.handlers)).toEqual([]);

	const agent = join(dir, "agent-with-original");
	mkdirSync(join(agent, "extensions"), { recursive: true });
	writeFileSync(join(agent, "extensions", "orchestrator-guard.ts"), "export default () => {};\n");
	const a = fakePi(agent);
	installGuard(a.pi);
	installGuard(a.pi);
	expect(Object.keys(a.handlers)).toEqual([]);
	expect(a.commands).toEqual([]);
	expect(a.logs.length).toBe(1);
	expect(a.logs[0]).toContain("orchestrator-guard.ts");

	const forced = fakePi(agent);
	installGuard(forced.pi, { ...GUARD_DEFAULTS, defer_to_installed: false });
	expect(forced.handlers.tool_call?.length).toBe(1);
});

test("install detection: file in the agent dir, not --no-extensions, not disabledExtensions", () => {
	const agent = join(dir, "agent-detect");
	mkdirSync(join(agent, "extensions", "harness-tools"), { recursive: true });
	const pi = fakePi(agent).pi;
	expect(installedOriginal(pi, "harness-tools")).toBeUndefined();
	writeFileSync(join(agent, "extensions", "harness-tools", "index.ts"), "");
	expect(installedOriginal(pi, "harness-tools")).toEndWith("harness-tools/index.ts");
	writeFileSync(join(agent, "config.yml"), "disabledExtensions:\n  - extension-module:harness-tools\n");
	expect(installedOriginal(pi, "harness-tools")).toBeUndefined();
	writeFileSync(join(agent, "config.yml"), "");
	const argv = process.argv;
	process.argv = [...argv, "--no-extensions"];
	try {
		expect(installedOriginal(pi, "harness-tools")).toBeUndefined();
	} finally {
		process.argv = argv;
	}
});

test("OmO task input: brief rules, writers isolated with apply:false in place, read-only agents untouched", () => {
	expect("reason" in checkOmoTaskInput({ category: "quick", prompt: "do the thing" })).toBe(true);
	const one = { category: "quick", prompt: "do the thing\nAcceptance: tests pass" };
	const r = checkOmoTaskInput(one);
	expect("input" in r && r.input).toBe(one);
	expect(one).toMatchObject({ isolated: true, apply: false, merge: "patch" });
	expect(one.prompt).toEndWith(budgetLine());
	const batch = { tasks: [{ subagent_type: "explore", prompt: "find x\nDone when: listed" }, { category: "deep-low", prompt: "fix y\nAcceptance: green" }] };
	checkOmoTaskInput(batch);
	expect(batch.tasks[0]).not.toHaveProperty("isolated");
	expect(batch.tasks[1]).toMatchObject({ isolated: true, apply: false });
	// In place is said explicitly, overriding the orchestrator's own isolation request and any omo.json default.
	const inPlace = { category: "quick", prompt: "x\nAcceptance: y", isolated: true, apply: false, merge: "patch" };
	checkOmoTaskInput(inPlace, false);
	expect(inPlace.isolated).toBe(false);
	expect(inPlace).not.toHaveProperty("apply");
	expect(inPlace).not.toHaveProperty("merge");
	const reader = { subagent_type: "explore", prompt: "x\nDone when: y" };
	checkOmoTaskInput(reader, false);
	expect(reader).not.toHaveProperty("isolated");
});

test("isolation: real repos and lane worktrees yes; no repo, the dotz data folder and an OmO refusal no", () => {
	const home = mkdtempSync(join(tmpdir(), "dotz-home-"));
	try {
		expect(shouldIsolate("/Users/x/Code/proj", false, home)).toBe(true);
		expect(shouldIsolate(join(home, "lanes", "a", "worktree"), false, home)).toBe(true);
		expect(shouldIsolate("", false, home)).toBe(false);
		expect(shouldIsolate(home, false, home)).toBe(false);
		expect(shouldIsolate(`${home}/`, false, home)).toBe(false);
		expect(shouldIsolate("/Users/x/Code/proj", true, home)).toBe(false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("OmO task completion settles the worker and keeps its retained patch; eval code counts as shell text", () => {
	const captured = join(dir, "root.patch");
	writeFileSync(captured, "diff --git a/f b/f\n");
	const state = { cwd: dir, workers: { st_01aa: { brief: "b", spawnedAt: 0, status: "running" } } } as any;
	const text = `task completion name:st_01aa id:st_01aa category:quick(anthropic-subscription/claude-sonnet-5-5:low) status:completed duration:9s\nresult:"done"\nisolation: retained via git-worktree -> ${captured}`;
	expect(settleFromText(state, text)).toBe(true);
	expect(state.workers.st_01aa.status).toBe("completed");
	expect(state.workers.st_01aa.patch).toEndWith("st_01aa.patch");
	expect(shellText({ code: "await tool.bash({ command: 'git apply x.patch' })" })).toContain("git apply x.patch");
});
