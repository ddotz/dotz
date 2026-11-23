import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../run-limited.ts";
import { withRealProbes } from "./claude-probes.ts";
import { EXTENSION, eventsFromFrame, type Frame, ompArgv } from "./omp.ts";
import { makeOmpProbes, type OmpProbeDeps } from "./omp-probes.ts";
import type { ActivityRow, AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./types.ts";
import { CHECKLIST, checklistFor, type CheckResult, type Probe, verifyRuntime } from "./verify.ts";

let root: string;
let ctx: { cwd: string; model: string; log: (s: string) => void; timeoutMs: number };
let savedAgentDir: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-omp-probes-"));
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	savedHome = process.env.HOME;
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent", "rules"), { recursive: true });
	mkdirSync(join(root, "agent", "skills", "ownerskill"), { recursive: true });
	writeFileSync(join(root, "agent", "RULES.md"), "# Rules\n\nAlways answer in the owner's private house style, never otherwise.\n");
	writeFileSync(join(root, "agent", "AGENTS.md"), "# Agents\n\nThe owner's own agents file says something very particular here.\n");
	writeFileSync(join(root, "agent", "rules", "ownerrule.md"), "---\nalwaysApply: true\n---\nThe owner's rule body that only the owner's folder holds.\n");
	writeFileSync(join(root, "agent", "skills", "ownerskill", "SKILL.md"), "---\nname: ownerskill\ndescription: x\n---\nbody\n");
	mkdirSync(join(root, "work"), { recursive: true });
	ctx = { cwd: join(root, "work"), model: "anthropic/claude-sonnet-5-5", log: () => {}, timeoutMs: 5000 };
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(root, { recursive: true, force: true });
});

const DOTZ_TOOLS = ["dotz_verify", "dotz_merge", "dotz_main", "dotz_recall", "dotz_escalate", "dotz_auth"];
type Loaded = { tools?: string[]; prompt?: string; commands?: string[]; errors?: string[] };

function jsonl({ tools = ["harness_doctor", ...DOTZ_TOOLS], prompt = "", commands = [], errors = [] }: Loaded = {}): string {
	const devices = tools.map(t => `- ${t} — a device`).join("\n");
	const frames = [
		{ type: "ready" },
		...errors.map(error => ({ type: "extension_error", extensionPath: EXTENSION, event: "session_start", error })),
		{ id: "state", type: "response", command: "get_state", success: true, data: { systemPrompt: ["base prompt", `${prompt}\n${devices}`], dumpTools: [{ name: "read" }] } },
		{ id: "commands", type: "response", command: "get_available_commands", success: true, data: { commands: commands.map(name => ({ name })) } },
	];
	return frames.map(f => `${JSON.stringify(f)}\n`).join("");
}

type Call = { argv: string[]; limit: number; cwd?: string; env?: Record<string, string | undefined>; stdin?: string };
function fakeDeps(answer: Partial<Ran> & { stdout?: string }, calls: Call[] = [], argv: OmpProbeDeps["argv"] = ompArgv, forgotten: string[] = []): OmpProbeDeps {
	return {
		argv,
		run: async (cmd, limit, opts) => {
			calls.push({ argv: [...cmd], limit, cwd: opts?.cwd, env: opts?.env, stdin: opts?.stdin });
			return { code: 0, stdout: "", stderr: "", timedOut: false, ...answer };
		},
		forget: cwd => {
			forgotten.push(cwd);
			return [];
		},
	};
}

const adapterStub = { id: "omp", recentExchanges: () => undefined, start: () => { throw new Error("not started"); } } as unknown as RuntimeAdapter;
const probesFor = (loaded: Loaded | string, calls: Call[] = [], argv?: OmpProbeDeps["argv"]) => makeOmpProbes(adapterStub, fakeDeps({ stdout: typeof loaded === "string" ? loaded : jsonl(loaded) }, calls, argv));
const run = (probes: Record<string, Probe>, id: string) => probes[id]!(ctx);

test("guard_extension: a process started by omp.ts's argv with only the dotz extension and its guard tool passes, and the probe stays inside its own folders", async () => {
	const calls: Call[] = [];
	const r = await run(probesFor({}, calls), "guard_extension");
	expect(r.result).toBe("ok");
	const [call] = calls;
	expect(call!.argv).toContain("--no-extensions");
	expect(call!.argv[call!.argv.indexOf("--extension") + 1]).toBe(EXTENSION);
	expect(call!.argv.some(a => a.startsWith("--config="))).toBe(true);
	expect(call!.cwd).toBe(ctx.cwd);
	expect(call!.limit).toBeLessThanOrEqual(ctx.timeoutMs);
	expect(call!.env!.DOTZ_RUNTIME).toBe("omp");
	expect(call!.env!.DOTZ_DIR!.startsWith(ctx.cwd)).toBe(true);
	expect(call!.argv.find(a => a.startsWith("--config="))!.startsWith(`--config=${ctx.cwd}`)).toBe(true);
	expect(call!.stdin).toContain('"get_state"');
});

test("guard_extension: passes when omp 19 lists the guard tool as an on-demand command in backticks", async () => {
	const loaded = jsonl({ tools: [] }).replace("base prompt", "## More commands (help on demand)\\n- `harness_doctor` — Health check of this omp session");
	expect((await run(probesFor(loaded), "guard_extension")).result).toBe("ok");
	const unquoted = jsonl({ tools: [] }).replace("base prompt", "- `harness_doctor — not a tool line");
	expect((await run(probesFor(unquoted), "guard_extension")).result).toBe("fail");
});

test("guard_extension: fails when the guard tool is missing, the extension reports an error, omp times out or answers nothing", async () => {
	const missing = await run(probesFor({ tools: DOTZ_TOOLS }), "guard_extension");
	expect(missing).toMatchObject({ result: "fail" });
	expect(missing.note).toContain("harness_doctor is not registered");
	const broken = await run(probesFor({ errors: ["cannot import guard"] }), "guard_extension");
	expect(broken.result).toBe("fail");
	expect(broken.note).toContain("cannot import guard");
	const slow = await run(makeOmpProbes(adapterStub, fakeDeps({ timedOut: true, code: 124 })), "guard_extension");
	expect(slow.result).toBe("fail");
	expect(slow.note).toContain("did not answer get_state within");
	const dead = await run(makeOmpProbes(adapterStub, fakeDeps({ code: 127, stderr: "no such binary" })), "guard_extension");
	expect(dead.result).toBe("fail");
	expect(dead.note).toContain("no such binary");
});

test("dotz_tools: passes with the lane's tool list, fails naming the tools that are missing", async () => {
	expect((await run(probesFor({}), "dotz_tools")).result).toBe("ok");
	const r = await run(probesFor({ tools: ["harness_doctor", "dotz_verify"] }), "dotz_tools");
	expect(r.result).toBe("fail");
	expect(r.note).toContain("dotz_merge");
	expect(r.note).not.toContain("dotz_verify");
});

test("user_isolation: passes when nothing of the owner's agent folder is in the process, fails for each kind of leak", async () => {
	expect((await run(probesFor({ prompt: "just the repo's own context" }), "user_isolation")).result).toBe("ok");
	const rules = await run(probesFor({ prompt: "# Rules\nAlways answer in the owner's private house style, never otherwise." }), "user_isolation");
	expect(rules.result).toBe("fail");
	expect(rules.note).toContain("RULES.md");
	const agents = await run(probesFor({ prompt: "The owner's own agents file says something very particular here." }), "user_isolation");
	expect(agents.note).toContain("AGENTS.md");
	const rule = await run(probesFor({ prompt: "<generic-rules>\nThe owner's rule body that only the owner's folder holds.\n</generic-rules>" }), "user_isolation");
	expect(rule.note).toContain("rules/ownerrule.md");
	const skillCommand = await run(probesFor({ commands: ["skill:ownerskill", "compact"] }), "user_isolation");
	expect(skillCommand.result).toBe("fail");
	expect(skillCommand.note).toContain("skills/ownerskill");
	const skillListed = await run(probesFor({ prompt: "<skills>\n- ownerskill: description\n</skills>" }), "user_isolation");
	expect(skillListed.note).toContain("skills/ownerskill");
});

test("user_isolation: a rule of ~/.agent/rules or ~/.agents/rules that reaches the prompt fails, named by its folder", async () => {
	for (const dir of [".agent", ".agents"]) mkdirSync(join(root, "home", dir, "rules"), { recursive: true });
	writeFileSync(join(root, "home", ".agent", "rules", "home-one.md"), "---\nalwaysApply: true\n---\nThe first home rule body that only ~/.agent holds.\n");
	writeFileSync(join(root, "home", ".agents", "rules", "home-two.md"), "The second home rule body that only ~/.agents holds.\n");
	expect((await run(probesFor({ prompt: "just the repo's own context" }), "user_isolation")).result).toBe("ok");
	const one = await run(probesFor({ prompt: "<generic-rules>\nThe first home rule body that only ~/.agent holds.\n</generic-rules>" }), "user_isolation");
	expect(one.result).toBe("fail");
	expect(one.note).toContain(".agent/rules/home-one.md");
	const two = await run(probesFor({ prompt: "The second home rule body that only ~/.agents holds." }), "user_isolation");
	expect(two.note).toContain(".agents/rules/home-two.md");
});

test("fallback_chain: the overlay carries the hub's chain and the lane's task chain; an owner key that still reaches the process fails", async () => {
	const ok = await run(probesFor({}), "fallback_chain");
	expect(ok.result).toBe("ok");
	writeFileSync(join(root, "agent", "config.yml"), "retry:\n  fallbackChains:\n    web:\n      - web/parallel\n");
	expect((await run(probesFor({}), "fallback_chain")).result).toBe("ok");
	writeFileSync(join(root, "agent", "config.yml"), 'retry:\n  fallbackChains:\n    default:\n      - openai/gpt-x\n');
	const owner = await run(probesFor({}), "fallback_chain");
	expect(owner.result).toBe("fail");
	expect(owner.note).toContain('"default"');
	writeFileSync(join(root, "agent", "config.yml"), 'retry:\n  fallbackChains:\n    "anthropic/*":\n      - openai/gpt-x\n');
	expect((await run(probesFor({}), "fallback_chain")).note).toContain('"anthropic/*"');
});

test("fallback_chain: fails when the overlay the argv builder wrote has another chain, or none", async () => {
	const rewrite = (yaml: string): OmpProbeDeps["argv"] => (o: SpawnOpts) => {
		const argv = ompArgv(o);
		writeFileSync(argv.find(a => a.startsWith("--config="))!.slice("--config=".length), yaml);
		return argv;
	};
	const wrong = await run(probesFor({}, [], rewrite('retry:\n  modelFallback: true\n  fallbackChains:\n    "anthropic/claude-sonnet-5-5":\n      - owner/model\n    "task": []\n')), "fallback_chain");
	expect(wrong.result).toBe("fail");
	expect(wrong.note).toContain("not the hub's");
	const off = await run(probesFor({}, [], rewrite("retry:\n  fallbackChains: {}\n")), "fallback_chain");
	expect(off.result).toBe("fail");
	expect(off.note).toContain("model fallback");
});

test("every checklist item of omp has a probe of its own, so none answers unknown", () => {
	expect(Object.keys(probesFor({})).sort()).toEqual(checklistFor("omp").map(c => c.id).sort());
});

type Wire = Frame & Record<string, unknown>;
type Sent = { kind: SendMode | "compact" | "abort" | "usage"; text: string };
type React = (sent: Sent) => Wire[];
const CLOSE: Wire = { type: "close" };

class Fake implements AgentProcess {
	pid = 1;
	readonly exited: Promise<number>;
	readonly events: AsyncIterable<AgentEvent>;
	private readonly queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private ended = false;
	private readonly exit = Promise.withResolvers<number>();
	constructor() {
		this.exited = this.exit.promise;
		this.events = this.stream();
	}
	private async *stream(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
			if (this.ended) return;
			await this.wake.promise;
			this.wake = Promise.withResolvers<void>();
		}
	}
	protected push(events: AgentEvent[]): void {
		this.queue.push(...events);
		this.wake.resolve();
	}
	protected finish(): void {
		this.ended = true;
		this.wake.resolve();
	}
	send(_text: string, _mode: SendMode): void {}
	abort(): void {}
	compact(): void {}
	refreshUsage(): void {}
	refreshSession(): void {}
	watchSubagents(): void {}
	kill = () => this.exit.resolve(0);
}

class Scripted extends Fake {
	constructor(private readonly script: (text: string) => AgentEvent[]) {
		super();
	}
	override send(text: string, _mode: SendMode): void {
		this.push(this.script(text));
	}
}

class Framed extends Fake {
	private readonly workers = new Map<string, string>();
	constructor(private readonly react: React) {
		super();
	}
	private feed(sent: Sent): void {
		for (const frame of this.react(sent)) {
			if (frame === CLOSE) return this.finish();
			this.push(eventsFromFrame(frame, this.workers));
		}
	}
	override send(text: string, mode: SendMode): void {
		this.feed({ kind: mode, text });
	}
	override abort(): void {
		this.feed({ kind: "abort", text: "" });
	}
	override compact(): void {
		this.feed({ kind: "compact", text: "" });
	}
	override refreshUsage(): void {
		this.feed({ kind: "usage", text: "" });
	}
}

const turnOf = (text: string, ...rows: ActivityRow[]): AgentEvent[] => [
	{ type: "turn_start" },
	{ type: "user", text: "prompt" },
	...rows.map(row => ({ type: "activity", row }) as AgentEvent),
	{ type: "assistant", text, stop: "stop" },
	{ type: "turn_end" },
];
const call = (tool: string, call_id: string, args = ""): ActivityRow => ({ type: "tool_call", text: "", tool, call_id, args });
const result = (call_id: string, text: string, is_error = false): ActivityRow => ({ type: "tool_result", text, call_id, is_error });

function scripted(script: (text: string) => AgentEvent[]): RuntimeAdapter {
	return { ...adapterStub, start: () => new Scripted(script) } as RuntimeAdapter;
}
const withAdapter = (script: (text: string) => AgentEvent[]) => makeOmpProbes(scripted(script), fakeDeps({}));
const live = <T>(fn: () => Promise<T>) => withRealProbes(fn);

const said = (text: string) => [{ type: "text", text }];
const wire = {
	start: { type: "agent_start" } as Wire,
	end: { type: "agent_end", isTerminal: true, yielded: true } as Wire,
	user: (text: string): Wire => ({ type: "message_end", message: { role: "user", content: said(text) } }),
	assistant: (text: string, tokens = 0, stopReason = "stop"): Wire => ({ type: "message_end", message: { role: "assistant", stopReason, content: said(text), ...(tokens ? { usage: { input: 4, output: 4, cacheRead: 0, cacheWrite: tokens - 8 } } : {}) } }),
	stats: (tokens: number): Wire => ({ type: "response", command: "get_session_stats", success: true, data: { contextUsage: { tokens, contextWindow: 1_000_000 } } }),
	call: (tool: string, id: string, args: object): Wire => ({ type: "tool_execution_start", toolCallId: id, toolName: tool, args }),
	done: (tool: string, id: string, text: string, isError = false): Wire => ({ type: "tool_execution_end", toolCallId: id, toolName: tool, result: { content: said(text) }, isError }),
};
const exchange = (prompt: string, answer: string, tokens: number, ...middle: Wire[]): Wire[] => [wire.start, wire.user(prompt), ...middle, wire.assistant(answer, tokens), wire.end];

const withOmp = (react: (o: SpawnOpts) => React, starts: SpawnOpts[] = []): RuntimeAdapter =>
	({
		...adapterStub,
		start: (o: SpawnOpts) => {
			starts.push(o);
			return new Framed(react(o));
		},
	}) as RuntimeAdapter;
const ompOf = (react: (o: SpawnOpts) => React, starts: SpawnOpts[] = [], calls: Call[] = [], forgotten: string[] = []) => makeOmpProbes(withOmp(react, starts), fakeDeps({}, calls, ompArgv, forgotten));

const FIXED = 11_900;
const PER_LINE = 30;
const speculationLead = (threshold: number) => Math.min(32_000, Math.max(8_192, Math.floor(threshold / 8)));
type Compacting = { own: "inline" | "never" | "refused" | "unannounced" | "skipped"; requested: "done" | "refused" | "silent" };
type Prompt = { held: number; pending: number; compactAt: number };

function ownCompaction(how: Compacting["own"], tokensBefore: number): Wire[] {
	const started: Wire = { type: "auto_compaction_start", reason: "threshold", action: "remote" };
	const ended = (rest: object): Wire => ({ type: "auto_compaction_end", aborted: false, willRetry: false, ...rest });
	return {
		inline: [started, ended({ action: "remote", result: { tokensBefore } })],
		never: [],
		refused: [started, ended({ errorMessage: "Auto-compaction failed: provider overloaded" })],
		unannounced: [ended({ action: "remote", result: { tokensBefore } })],
		skipped: [started, ended({ skipped: true })],
	}[how];
}

const compacting = (how: Compacting, prompts: Prompt[] = []) => (o: SpawnOpts): React => {
	const compactAt = o.lane!.compactAt;
	let held = FIXED;
	return ({ kind, text }) => {
		if (kind === "usage") return [wire.stats(held)];
		if (kind === "compact") return how.requested === "silent" ? [CLOSE] : [{ type: "response", command: "compact", ...(how.requested === "done" ? { success: true, data: { tokensBefore: held } } : { success: false, error: "Compaction failed: provider overloaded" }) }];
		if (kind !== "prompt") return [];
		const lines = text.startsWith("Read this text") ? text.split("\n").length - 2 : 0;
		const pending = lines ? lines * PER_LINE : 20;
		prompts.push({ held, pending, compactAt });
		const before = held + pending >= compactAt + speculationLead(compactAt) ? ownCompaction(how.own, held) : [];
		if (before.length) held = FIXED + 600;
		held += pending + 5;
		return [...before, ...exchange(text, lines ? "hi" : "PONG", held)];
	};
};

type Steering = { steer: "inside" | "after" | "never"; abort: "ends" | "ignored" };
const steering = ({ steer, abort }: Steering) => (): React => ({ kind, text }) => {
	if (kind === "abort") return abort === "ends" ? [wire.assistant("", 0, "aborted"), wire.end] : [CLOSE];
	if (kind === "steer") {
		if (steer === "never") return [CLOSE];
		const finished = wire.done("bash", "c1", "slept");
		return steer === "inside" ? [finished, wire.user(text), wire.assistant("done STEERED"), wire.end] : [finished, wire.assistant("done"), wire.end, wire.user(text)];
	}
	if (text.includes("sleep 5;")) return [wire.start, wire.user(text), wire.call("bash", "c1", { command: "sleep 5; echo slept" })];
	if (text.includes("sleep 60")) return [wire.start, wire.user(text), wire.call("bash", "c2", { command: "sleep 60" })];
	return exchange(text, "PONG", 0);
};

type Isolating = { worker: "patch" | "answer" | "merged" | "failed" | "unused" | "nothing"; apply: "blocked" | "open" | "read-first" | "declined" | "ran" };
const PATCH = "diff --git a/probe.txt b/probe.txt\n--- a/probe.txt\n+++ b/probe.txt\n@@ -1 +1 @@\n-before\n+after\n";
const patchFile = (body = PATCH): string => {
	const file = join(root, "worker.patch");
	writeFileSync(file, body);
	return file;
};

const isolating = (how: Isolating, patch: string) => (o: SpawnOpts): React => ({ text }) => {
	const checkout = join(o.cwd, "probe.txt");
	const apply = wire.call("bash", "g1", { command: `git apply ${patch}` });
	const refusal = `orchestrator-guard: review before apply. Read ${patch} first with the read tool on that same path, check it matches the brief, then apply.`;
	if (text.startsWith("Use the task tool")) {
		if (how.worker === "unused") return exchange(text, "done", 0);
		mkdirSync(join(o.env.OMP_WORKTREE_DIR!, "st_1"), { recursive: true });
		if (how.worker === "merged") writeFileSync(checkout, "after\n");
		const status = how.worker === "failed" ? "failed" : "completed";
		const captured = how.worker === "patch" ? ` changes captured at \`${patch}\`` : "";
		const report = `<task-result id="w" agent="task" status="${status}">${captured}</task-result>`;
		const spawned = [wire.call("task", "t1", { tasks: [{ agent: "task", task: "Replace probe.txt" }] }), wire.done("task", "t1", report)];
		const answer = how.worker === "failed" || how.worker === "nothing" ? "done" : patch;
		return how.worker === "nothing" ? [...exchange(text, answer, 0, ...spawned.slice(0, 1)), CLOSE] : exchange(text, answer, 0, ...spawned);
	}
	if (!text.startsWith("This is a test of the call guard")) return exchange(text, "PONG", 0);
	if (how.apply === "declined") return exchange(text, "I will not run it", 0);
	if (how.apply === "read-first") return exchange(text, "done", 0, wire.call("read", "r1", { path: patch }), wire.done("read", "r1", "1:diff --git"), apply, wire.done("bash", "g1", "(no output, exit code 0)"));
	if (how.apply === "ran") writeFileSync(checkout, "after\n");
	return exchange(text, "done", 0, apply, how.apply === "open" ? wire.done("bash", "g1", "(no output, exit code 0)") : wire.done("bash", "g1", refusal, true));
};

test("turn: a PONG answer with the turn events passes, any other answer fails", async () => {
	expect((await live(() => run(withAdapter(() => turnOf("PONG")), "turn"))).result).toBe("ok");
	const bad = await live(() => run(withAdapter(() => turnOf("hello")), "turn"));
	expect(bad.result).toBe("fail");
	expect(bad.note).toContain("answer was not PONG");
});

test("deny_lines: passes when the extension's hook blocked the command, fails when it ran", async () => {
	const attempt = (blockedText: string, isError: boolean) => (text: string) => (text.includes("DOTZ-DENY-PROBE-1") ? turnOf("done", call("bash", "c1", "echo DOTZ-DENY-PROBE-1"), result("c1", blockedText, isError)) : turnOf("PONG"));
	const blocked = await live(() => run(withAdapter(attempt("Blocked: probe rule, this command is refused", true)), "deny_lines"));
	expect(blocked.result).toBe("ok");
	const ran = await live(() => run(withAdapter(attempt("DOTZ-DENY-PROBE-1", false)), "deny_lines"));
	expect(ran.result).toBe("fail");
	expect(ran.note).toContain("was not blocked");
	const never = await live(() => run(withAdapter(() => turnOf("I will not")), "deny_lines"));
	expect(never.note).toContain("never attempted");
});

test("workers_spawn: passes when a task call's result comes back, fails when no task tool was used", async () => {
	const good = await live(() => run(withAdapter(() => turnOf("from-worker", call("task", "t1"), result("t1", "from-worker"))), "workers_spawn"));
	expect(good.result).toBe("ok");
	const none = await live(() => run(withAdapter(() => turnOf("from-worker")), "workers_spawn"));
	expect(none).toMatchObject({ result: "fail", note: "the task tool was not used" });
	const lost = await live(() => run(withAdapter(() => turnOf("nothing", call("task", "t1"))), "workers_spawn"));
	expect(lost.result).toBe("fail");
});

test("a turn probe outside a requested runtime check starts no process", async () => {
	const r = await run(withAdapter(() => turnOf("PONG")), "turn");
	expect(r.result).toBe("fail");
	expect(r.note).toContain("real runtime probes start only in a requested runtime check");
});

test("compaction_events: compact() and omp's own threshold compaction both raise a compaction event, the second forced by a prompt sized past threshold + lead", async () => {
	const starts: SpawnOpts[] = [];
	const prompts: Prompt[] = [];
	const forgotten: string[] = [];
	const r = await live(() => run(ompOf(compacting({ own: "inline", requested: "done" }, prompts), starts, [], forgotten), "compaction_events"));
	expect(r.result).toBe("ok");
	expect(r.note).toContain("compact() -> one compaction event (was 11925 tokens)");
	expect(r.note).toContain("omp's own compaction (f17888");
	expect(starts.map(s => s.lane!.compactAt)).toEqual([100_000, 17_888]);
	const [first, second] = prompts.filter(p => p.compactAt === 17_888);
	expect(first!.held + first!.pending).toBeLessThan(17_888);
	expect(second!.held + second!.pending).toBeGreaterThanOrEqual(17_888 + 8_192);
	expect(forgotten).toEqual([ctx.cwd]);
});

test("compaction_events: fails with the reason when compact() is refused or silent, or omp never compacts on its own, skips, errors or does not announce it", async () => {
	const cases: [Compacting, string][] = [
		[{ own: "inline", requested: "refused" }, "compact() ended in a compaction error: Compaction failed: provider overloaded"],
		[{ own: "inline", requested: "silent" }, "after compact()"],
		[{ own: "never", requested: "done" }, "raised no compaction event"],
		[{ own: "skipped", requested: "done" }, "raised no compaction event"],
		[{ own: "refused", requested: "done" }, "omp's own compaction ended in an error: Auto-compaction failed: provider overloaded"],
		[{ own: "unannounced", requested: "done" }, "no 'compacting context' start row"],
	];
	for (const [how, note] of cases) {
		const r = await live(() => run(ompOf(compacting(how)), "compaction_events"));
		expect(r.result).toBe("fail");
		expect(r.note).toContain(note);
	}
});

test("steer_abort: a steer enters the running turn and abort() ends the next one as aborted, the session answering afterwards", async () => {
	const r = await live(() => run(ompOf(steering({ steer: "inside", abort: "ends" })), "steer_abort"));
	expect(r.result).toBe("ok");
	expect(r.note).toContain("steer entered the running turn");
	expect(r.note).toContain("followed it");
	expect(r.note).toContain("ended the 60 s command's turn as aborted");
});

test("steer_abort: fails when the steer comes after the turn ended or never, or abort() is ignored", async () => {
	const cases: [Steering, string][] = [
		[{ steer: "after", abort: "ends" }, "the steer arrived only after the turn ended"],
		[{ steer: "never", abort: "ends" }, "never entered the session"],
		[{ steer: "inside", abort: "ignored" }, "abort() did not end the turn of the 60 s command as aborted"],
	];
	for (const [how, note] of cases) {
		const r = await live(() => run(ompOf(steering(how)), "steer_abort"));
		expect(r.result).toBe("fail");
		expect(r.note).toContain(note);
	}
});

test("workers_isolated_patch: an isolated worker returns its change as a patch, the checkout stays untouched, an unread git apply is refused and the probe repo is removed", async () => {
	const patch = patchFile();
	const calls: Call[] = [];
	const forgotten: string[] = [];
	for (const worker of ["patch", "answer"] as const) {
		const r = await live(() => run(ompOf(isolating({ worker, apply: "blocked" }, patch), [], calls, forgotten), "workers_isolated_patch"));
		expect(r.result).toBe("ok");
		expect(r.note).toContain("worker.patch");
		expect(r.note).toContain('unread git apply refused ("review before apply") and not run');
	}
	expect(calls.map(c => c.cwd)).toEqual([join(ctx.cwd, "repo"), join(ctx.cwd, "repo")]);
	expect(calls[0]!.argv.join(" ")).toContain("git init");
	expect(forgotten).toEqual([join(ctx.cwd, "repo"), join(ctx.cwd, "repo")]);
	expect(existsSync(join(ctx.cwd, "repo"))).toBe(false);
	expect(existsSync(join(ctx.cwd, ".dotz-probe-wt"))).toBe(false);
});

test("workers_isolated_patch: fails with the reason for each way the isolation or the patch review can break", async () => {
	const cases: [Isolating, string, string?][] = [
		[{ worker: "unused", apply: "blocked" }, "the task tool was not used"],
		[{ worker: "failed", apply: "blocked" }, 'the worker failed: <task-result id="w" agent="task" status="failed">'],
		[{ worker: "nothing", apply: "blocked" }, "no retained patch came back"],
		[{ worker: "merged", apply: "blocked" }, "merged into the checkout"],
		[{ worker: "patch", apply: "blocked" }, "the reported patch is not there", join(root, "missing.patch")],
		[{ worker: "patch", apply: "blocked" }, "the patch does not hold the change", "wrong"],
		[{ worker: "patch", apply: "open" }, "git apply of an unread patch was not blocked: (no output, exit code 0)"],
		[{ worker: "patch", apply: "read-first" }, "the model read the patch before applying it"],
		[{ worker: "patch", apply: "declined" }, "the model did not attempt git apply"],
		[{ worker: "patch", apply: "ran" }, "the refused git apply changed the checkout anyway"],
	];
	for (const [how, note, patch] of cases) {
		const file = patch === "wrong" ? patchFile("+other\n") : (patch ?? patchFile());
		const r = await live(() => run(ompOf(isolating(how, file)), "workers_isolated_patch"));
		expect(r.result).toBe("fail");
		expect(r.note).toContain(note);
	}
});

test("verify for omp is no blanket ok: a failing probe surfaces in the report and blocks a core failure", async () => {
	const own = ompOf(compacting({ own: "never", requested: "done" }));
	const pass: Probe = async () => ({ result: "ok", note: "ran" });
	const everything = Object.fromEntries(checklistFor("omp").map(c => [c.id, pass]));
	const report = await live(() =>
		verifyRuntime("omp", {
			adapter: scripted(() => turnOf("PONG")),
			probes: { ...everything, compaction_events: own.compaction_events!, guard_extension: async () => ({ result: "fail", note: "harness_doctor is not registered" }), deny_lines: async () => ({ result: "fail", note: "the command was not blocked" }) },
			version: "1",
			persist: false,
			timeoutMs: 3000,
		}),
	);
	const by = Object.fromEntries(report.items.map(i => [i.id, i.result])) as Record<string, CheckResult>;
	expect(by.deny_lines).toBe("fail");
	expect(by.guard_extension).toBe("disabled");
	expect(report.items.find(i => i.id === "guard_extension")!.note).toContain("harness_doctor is not registered");
	expect(by.compaction_events).toBe("adapted");
	expect(report.items.find(i => i.id === "compaction_events")!.note).toContain("raised no compaction event");
	expect(by.turn).toBe("ok");
	expect(report.verdict).toBe("blocked");
	expect(report.items.every(i => i.result === "ok")).toBe(false);
	expect(CHECKLIST.some(c => c.id === "user_isolation" && c.only === "omp")).toBe(true);
});

test("verify for omp with its own probes and no omp binary reports nothing ok that was not run", async () => {
	const report = await verifyRuntime("omp", { adapter: adapterStub, version: "1", persist: false, timeoutMs: 3000 });
	expect(report.items.map(i => i.id)).toEqual(checklistFor("omp").map(c => c.id));
	expect(report.items.filter(i => i.result === "ok").map(i => i.id)).toEqual(["fallback_chain"]);
	expect(report.items.find(i => i.id === "handover")!.result).toBe("adapted");
	expect(report.verdict).toBe("blocked");
});

const answering = (): React => ({ kind, text }) => (kind === "prompt" ? exchange(text, "PONG", 0) : []);
const modelsList = (thinking: string[] | null) => JSON.stringify({ models: [{ provider: "anthropic", id: "claude-opus-5-5", kind: "chat", selector: "anthropic/claude-opus-5-5", thinking }] });

test("model_effort: the runs use the configured model at the lowest and highest level omp lists for it", async () => {
	const starts: SpawnOpts[] = [];
	const calls: Call[] = [];
	const probes = makeOmpProbes(withOmp(answering, starts), fakeDeps({ stdout: modelsList(["off", "high", "minimal", "medium", "xhigh"]) }, calls));
	const r = await live(() => probes.model_effort!({ ...ctx, model: "anthropic/claude-opus-5-5:medium" }));
	expect(r.result).toBe("ok");
	expect(calls.map(c => c.argv.slice(1))).toEqual([["models", "--json"]]);
	expect(starts.map(s => s.model)).toEqual(["anthropic/claude-opus-5-5:minimal", "anthropic/claude-opus-5-5:xhigh"]);
});

test("model_effort: a model with no thinking list, an unknown model or a failed listing falls back to low and high", async () => {
	for (const answer of [{ stdout: modelsList(null) }, { stdout: modelsList([]) }, { stdout: "not json" }, { code: 1, stdout: modelsList(["minimal", "xhigh"]) }]) {
		const starts: SpawnOpts[] = [];
		const probes = makeOmpProbes(withOmp(answering, starts), fakeDeps(answer));
		expect((await live(() => probes.model_effort!({ ...ctx, model: "anthropic/claude-opus-5-5" }))).result).toBe("ok");
		expect(starts.map(s => s.model)).toEqual(["anthropic/claude-opus-5-5:low", "anthropic/claude-opus-5-5:high"]);
	}
	const starts: SpawnOpts[] = [];
	const probes = makeOmpProbes(withOmp(answering, starts), fakeDeps({ stdout: modelsList(["minimal", "xhigh"]) }));
	await live(() => probes.model_effort!({ ...ctx, model: "someone/else" }));
	expect(starts.map(s => s.model)).toEqual(["someone/else:low", "someone/else:high"]);
});

test("a probe's turn runs on the configured model, and so does its worker", async () => {
	const starts: SpawnOpts[] = [];
	const probes = makeOmpProbes(withOmp(answering, starts), fakeDeps({}));
	await live(() => probes.turn!({ ...ctx, model: "anthropic/claude-opus-5-5:medium" }));
	expect(starts.map(s => [s.model, s.lane?.workerModel])).toEqual([["anthropic/claude-opus-5-5:medium", "anthropic/claude-opus-5-5:medium"]]);
});
