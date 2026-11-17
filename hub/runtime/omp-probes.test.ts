import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../run-limited.ts";
import { withRealProbes } from "./claude-probes.ts";
import { EXTENSION, ompArgv } from "./omp.ts";
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

const UNCOVERED = ["compaction_events", "steer_abort", "workers_isolated_patch"];
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
function fakeDeps(answer: Partial<Ran> & { stdout?: string }, calls: Call[] = [], argv: OmpProbeDeps["argv"] = ompArgv): OmpProbeDeps {
	return {
		argv,
		run: async (cmd, limit, opts) => {
			calls.push({ argv: [...cmd], limit, cwd: opts?.cwd, env: opts?.env, stdin: opts?.stdin });
			return { code: 0, stdout: "", stderr: "", timedOut: false, ...answer };
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

test("an item no omp probe covers answers unknown with a reason, never ok", async () => {
	const probes = probesFor({});
	for (const id of UNCOVERED) {
		const r = await run(probes, id);
		expect(r.result).toBe("unknown");
		expect(r.note).toContain("not probed on omp");
	}
});

class Scripted implements AgentProcess {
	pid = 1;
	readonly exited: Promise<number>;
	readonly events: AsyncIterable<AgentEvent>;
	private readonly queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private readonly exit = Promise.withResolvers<number>();
	constructor(private readonly script: (text: string) => AgentEvent[]) {
		this.exited = this.exit.promise;
		this.events = this.stream();
	}
	private async *stream(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
			await this.wake.promise;
			this.wake = Promise.withResolvers<void>();
		}
	}
	send(text: string, _mode: SendMode): void {
		this.queue.push(...this.script(text));
		this.wake.resolve();
	}
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
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

test("verify for omp is no blanket ok: a failing probe surfaces in the report and blocks a core failure", async () => {
	const own = probesFor({});
	const pass: Probe = async () => ({ result: "ok", note: "ran" });
	const everything = Object.fromEntries(checklistFor("omp").map(c => [c.id, UNCOVERED.includes(c.id) ? own[c.id]! : pass]));
	const report = await live(() =>
		verifyRuntime("omp", {
			adapter: scripted(() => turnOf("PONG")),
			probes: { ...everything, guard_extension: async () => ({ result: "fail", note: "harness_doctor is not registered" }), deny_lines: async () => ({ result: "fail", note: "the command was not blocked" }) },
			version: "1",
			persist: false,
			timeoutMs: 3000,
		}),
	);
	const by = Object.fromEntries(report.items.map(i => [i.id, i.result])) as Record<string, CheckResult>;
	expect(by.deny_lines).toBe("fail");
	expect(by.guard_extension).toBe("disabled");
	expect(report.items.find(i => i.id === "guard_extension")!.note).toContain("harness_doctor is not registered");
	expect(by.compaction_events).toBe("unknown");
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
