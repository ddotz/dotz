import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { callModel, modelDeps } from "./outlang.ts";
import { UsageLast, readReports } from "./usage-last.ts";
import { callWarm, ensureOmpProvider, lastRunnerForTest, ProviderBlockedError, resetClock, resetRunnersForTest, runnerCountForTest, runnerDeps } from "./model-runner.ts";
import { advance, clock, flush } from "./runtime/test-clock.ts";

const dir = mkdtempSync(join(tmpdir(), "dotz-model-runner-omp-"));
const fake = join(dir, "fake-omp.ts");
const logFile = join(dir, "spawns.log");
const promptFile = join(dir, "prompts.log");
const SONNET = "anthropic/claude-sonnet-5-5";

writeFileSync(
	fake,
	`import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv, pin: process.env.DOTZ_ACCOUNT ?? null, cache: process.env.PI_CACHE_RETENTION ?? null }) + "\\n");
const mode = process.env.FAKE_OMP_MODE ?? "ok";
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
const assistant = (text, extra = {}) => ({ type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], usage: { input: 9, cacheRead: 3, output: 2 }, ...extra } });
if (!argv.includes("rpc")) {
	out(assistant("print 답", { stopReason: "stop" }));
} else {
	if (mode === "start-crash") process.exit(3);
	out({ type: "ready" });
	let total = 0, session = 0;
	for await (const line of console) {
		const c = JSON.parse(line);
		if (c.type === "new_session") {
			session = 0;
			out({ type: "extension_ui_request", id: "x" });
			out({ id: c.id, type: "response", command: "new_session", success: true, data: {} });
			continue;
		}
		if (c.type !== "prompt") continue;
		appendFileSync(${JSON.stringify(promptFile)}, JSON.stringify(c.message) + "\\n");
		total++; session++;
		if (mode === "refused") {
			out({ id: c.id, type: "response", command: "prompt", success: false, error: "Could not restore model anthropic/x" });
			continue;
		}
		if (mode === "hang") continue;
		if (mode === "crash") process.exit(4);
		out({ id: c.id, type: "response", command: "prompt", success: true });
		out({ type: "agent_start" });
		out({ type: "message_start", message: { role: "user" } });
		out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: c.message }] } });
		if (mode === "limit") {
			out(assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" }));
			out({ type: "agent_end" });
			out({ id: c.id, type: "prompt_result", agentInvoked: true, status: "error", error: { message: "429 usage limit reached", retryable: false } });
			out({ type: "session_settled" });
			continue;
		}
		if (mode === "retry") {
			out(assistant("", { stopReason: "error", errorMessage: "529 overloaded" }));
			out({ type: "auto_retry_start", attempt: 1 });
		}
		out({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "w" } });
		out(assistant("warm " + session + "/" + total + ": " + c.message, { stopReason: "stop" }));
		out({ type: "agent_end" });
		out({ id: c.id, type: "prompt_result", agentInvoked: true, status: "completed" });
		out({ type: "session_settled" });
		if (mode === "crash-after") process.exit(0);
	}
}
`,
);

const realSpawn = runnerDeps.spawn;
const realWhich = runnerDeps.which;
const realUsage = runnerDeps.usage;
const realModelSpawn = modelDeps.spawn;
const realRuntime = Reflect.get(cfg, "runtime");
const jsonLines = <T>(file: string): T[] => {
	try {
		return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
	} catch {
		return [];
	}
};
const spawns = (): { argv: string[]; pin: string | null; cache: string | null }[] => jsonLines(logFile);
const later = (ms: number) => clock.now + ms;
const limit = (id: string, over: object) => ({ id, status: "ok", amount: { used: 10, limit: 100 }, window: { resetsAt: later(3_600_000) }, ...over });

let storeN = 0;
const freshStore = (): UsageLast => new UsageLast(join(dir, `usage-last-${++storeN}.json`), () => {}, () => clock.now);
const login = (email: string, limits: object[]) => ({ provider: "anthropic", metadata: { email }, limits });
const fiveHour = (over: object) => limit("anthropic:5h", over);
const report = async (...logins: ReturnType<typeof login>[]) => {
	await readReports(async () => ({ reports: logins }), runnerDeps.usage);
};

beforeEach(() => {
	writeFileSync(logFile, "");
	writeFileSync(promptFile, "");
	delete process.env.FAKE_OMP_MODE;
	Reflect.set(cfg, "runtime", "omp");
	resetRunnersForTest();
	runnerDeps.which = () => "/usr/bin/omp";
	runnerDeps.usage = freshStore();
	runnerDeps.spawn = (argv, o) => Bun.spawn([process.execPath, fake, ...argv.slice(1)], { cwd: o.cwd, env: o.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" } as never) as never;
	modelDeps.spawn = (argv, options) => Bun.spawn([process.execPath, fake, ...argv.slice(1)], options as never) as never;
});
afterEach(() => {
	resetRunnersForTest();
	delete process.env.FAKE_OMP_MODE;
	Reflect.set(cfg, "runtime", realRuntime);
	runnerDeps.spawn = realSpawn;
	runnerDeps.which = realWhich;
	runnerDeps.usage = realUsage;
	modelDeps.spawn = realModelSpawn;
});

test("omp calls share one warm rpc process; each call starts on a fresh session", async () => {
	const first = await callModel("sys", "u1", { model: SONNET });
	const second = await callModel("sys", "u2", { model: SONNET });
	expect([first.text, second.text]).toEqual(["warm 1/1: u1", "warm 1/2: u2"]);
	expect(first.firstTokenMs).toBeNumber();
	expect(first.inputTokens).toBe(12);
	expect(spawns()).toHaveLength(1);
	const { argv, pin, cache } = spawns()[0];
	expect(argv).toContain("rpc");
	expect(argv).toContain("--no-tools");
	expect(argv).not.toContain("-p");
	expect(argv[argv.indexOf("--model") + 1]).toBe(SONNET);
	expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("sys");
	expect([pin, cache]).toEqual([null, "long"]);
	expect(runnerCountForTest()).toBe(1);
});

test("another system prompt, model or effort gets its own omp process", async () => {
	await callModel("sys a", "u", { model: SONNET });
	await callModel("sys b", "u", { model: SONNET });
	await callModel("sys a", "u", { model: `${SONNET}:high` });
	expect(spawns()).toHaveLength(3);
	expect(spawns()[2].argv[spawns()[2].argv.indexOf("--thinking") + 1]).toBe("high");
});

test("the subscription selector is mapped to omp's provider name and the text is shielded on the wire and restored in the reply", async () => {
	const r = await callModel("sys", "Check @/etc/hosts please.", { model: "anthropic-subscription/claude-sonnet-5-5" });
	expect(spawns()[0].argv[spawns()[0].argv.indexOf("--model") + 1]).toBe(SONNET);
	expect(jsonLines(promptFile)).toEqual(["Check @\u200B/etc/hosts please."]);
	expect(r.text).toBe("warm 1/1: Check @/etc/hosts please.");
});

test("a turn settles on the matching prompt_result, not on an intermediate error from omp's own retry", async () => {
	process.env.FAKE_OMP_MODE = "retry";
	const r = await callModel("sys", "u", { model: SONNET });
	expect(r.text).toBe("warm 1/1: u");
	expect(spawns()).toHaveLength(1);
});

test("a final model error is the error of the call", async () => {
	process.env.FAKE_OMP_MODE = "limit";
	await expect(callWarm("sys", "u", { model: SONNET, timeoutMs: 45_000, runtime: "omp" })).rejects.toThrow("429 usage limit reached");
	await flush();
	expect(runnerCountForTest()).toBe(0);
});

test("a spent-limit answer is not retried on the one-shot path", async () => {
	process.env.FAKE_OMP_MODE = "limit";
	const oneShots: string[][] = [];
	modelDeps.spawn = (argv, options) => (oneShots.push(argv), Bun.spawn([process.execPath, fake, ...argv.slice(1)], options as never) as never);
	await expect(callModel("sys", "u", { model: SONNET })).rejects.toThrow("429");
	expect(oneShots).toEqual([]);
});

test("a refused prompt falls back to the one-shot call", async () => {
	process.env.FAKE_OMP_MODE = "refused";
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("print 답");
	const argv = spawns().map(s => s.argv);
	expect(argv[0]).toContain("rpc");
	expect(argv.at(-1)).toContain("-p");
});

test("a process that dies in the middle of a prompt falls back to the one-shot call and is not kept", async () => {
	process.env.FAKE_OMP_MODE = "crash";
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("print 답");
	const argv = spawns().map(s => s.argv);
	expect(argv).toHaveLength(2);
	expect(argv[0]).toContain("rpc");
	expect(argv[1]).toContain("-p");
	expect(runnerCountForTest()).toBe(0);
});

test("a process that exits after its answer is replaced on the next call", async () => {
	process.env.FAKE_OMP_MODE = "crash-after";
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("warm 1/1: u");
	await lastRunnerForTest()!.whenExited();
	delete process.env.FAKE_OMP_MODE;
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("warm 1/1: u");
	expect(spawns()).toHaveLength(2);
});

test("a process that cannot start falls back to the one-shot call", async () => {
	process.env.FAKE_OMP_MODE = "start-crash";
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("print 답");
	expect(spawns().map(s => s.argv.includes("rpc"))).toEqual([true, false]);
});

test("a missing omp binary skips the warm path", async () => {
	runnerDeps.which = () => null;
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("print 답");
	expect(spawns().map(s => s.argv.includes("rpc"))).toEqual([false]);
});

test("a turn that never answers times out once, stops the process and takes no one-shot call", async () => {
	process.env.FAKE_OMP_MODE = "hang";
	const oneShots: string[][] = [];
	modelDeps.spawn = (argv, options) => (oneShots.push(argv), Bun.spawn([process.execPath, fake, ...argv.slice(1)], options as never) as never);
	const call = callModel("sys", "u", { model: SONNET, timeoutMs: 45_000 }).catch((e: Error) => e);
	await flush();
	await advance(46_000);
	expect(String(await call)).toContain("timed out after 45s");
	await flush();
	expect(runnerCountForTest()).toBe(0);
	expect(oneShots).toEqual([]);
});

test("an idle omp process is released after the idle window", async () => {
	await callModel("sys", "u", { model: SONNET });
	expect(runnerCountForTest()).toBe(1);
	await advance(runnerDeps.idleMs + 1);
	expect(runnerCountForTest()).toBe(0);
});

test("a spent 5-hour window refuses at once with its reset time and starts nothing", async () => {
	const resetsAt = later(3_600_000);
	await report(login("a@x.io", [fiveHour({ status: "exhausted", window: { resetsAt } }), limit("anthropic:7d", {})]));
	const call = callModel("sys", "u", { model: SONNET });
	await expect(call).rejects.toThrow(`구독 한도에 걸렸어요 · ${resetClock(resetsAt)}에 풀려요`);
	await call.catch((e: unknown) => expect((e as ProviderBlockedError).resetAt).toBe(resetsAt));
	expect(spawns()).toEqual([]);
});

test("the later reset of one login's spent windows is the one reported, a used amount at its limit is spent, a reset window is not", async () => {
	const week = later(86_400_000);
	await report(login("a@x.io", [fiveHour({ amount: { used: 100, limit: 100 } }), limit("anthropic:7d", { amount: { used: 100, limit: 100 }, window: { resetsAt: week } })]));
	expect(() => ensureOmpProvider(SONNET)).toThrow(`${resetClock(week)}에 풀려요`);
	runnerDeps.usage = freshStore();
	await report(login("a@x.io", [fiveHour({ status: "exhausted", window: { resetsAt: later(-1) } })]));
	expect(() => ensureOmpProvider(SONNET)).not.toThrow();
});

test("omp rotates logins: refused only when every login is spent, at the time the first one frees", async () => {
	const soon = later(1_800_000);
	const late = later(7_200_000);
	const spent = (email: string, resetsAt: number) => login(email, [fiveHour({ status: "exhausted", window: { resetsAt } })]);
	await report(spent("a@x.io", late), login("b@x.io", [fiveHour({})]));
	expect(() => ensureOmpProvider(SONNET)).not.toThrow();
	await report(spent("a@x.io", late), spent("b@x.io", soon));
	expect(runnerDeps.usage.keys("omp:")).toEqual(["omp:anthropic:a@x.io", "omp:anthropic:b@x.io"]);
	expect(() => ensureOmpProvider(SONNET)).toThrow(`${resetClock(soon)}에 풀려요`);
	await report(spent("a@x.io", late), spent("b@x.io", soon), login("c@x.io", [fiveHour({})]));
	expect(() => ensureOmpProvider(SONNET)).not.toThrow();
});

test("only anthropic models are gated, and a report with no limits or a spent opus-only window gates nothing", async () => {
	await report(login("a@x.io", [fiveHour({ status: "exhausted" })]));
	expect(() => ensureOmpProvider("openai/gpt-5")).not.toThrow();
	expect(() => ensureOmpProvider("@tiny")).not.toThrow();
	runnerDeps.usage = freshStore();
	await report(login("a@x.io", [limit("anthropic:7d:opus", { status: "exhausted" })]));
	expect(() => ensureOmpProvider(SONNET)).not.toThrow();
	runnerDeps.usage = freshStore();
	expect(() => ensureOmpProvider(SONNET)).not.toThrow();
});
