// The warm draft process and the provider-readiness check in front of it (hub/model-runner.ts), driven by a fake `omo`:
// it answers `prompt` frames like OmO's rpc mode, answers `new_session`, or exits/hangs on request, and records every
// spawn (argv, pinned account, commands) so reuse and restart are observable. No real model is ever called.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelDeps, callModel } from "./outlang.ts";
import { callWarm, ensureProvider, resetHealthForTest, resetRunnersForTest, lastRunnerForTest, resetClock, runnerDeps, runnerCountForTest, subscriptionHealth, PIN_ENV } from "./model-runner.ts";
import { advance, clock, flush } from "./runtime/test-clock.ts";

const dir = mkdtempSync(join(tmpdir(), "dotz-model-runner-"));
const fake = join(dir, "fake-omo.ts");
const logFile = join(dir, "spawns.log");
const cmdFile = join(dir, "commands.log");
const SONNET = "anthropic/claude-sonnet-5-5";

// The fake: print mode answers one message_end; rpc mode stays up and answers prompts until it is told to leave.
writeFileSync(
	fake,
	`import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv, pin: process.env[${JSON.stringify(PIN_ENV)}] ?? null }) + "\\n");
const mode = process.env.FAKE_OMO_MODE ?? "ok";
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
const args = argv.join(" ");
if (!args.includes("rpc")) {
	out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "print 답" }], stopReason: "stop", usage: { input: 7, output: 1 } } });
} else {
	if (mode === "start-crash") process.exit(3);
	let n = 0;
	for await (const line of console) {
		const c = JSON.parse(line);
		appendFileSync(${JSON.stringify(cmdFile)}, c.type + "\\n");
		if (c.type === "prompt") {
			n++;
			if (mode === "hang") continue;
			if (mode === "crash") process.exit(4);
			if (mode === "limit") {
				out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate_limit_error: usage limit reached" } });
				continue;
			}
			out({ type: "agent_start" });
			out({ type: "message_start", message: { role: "assistant" } });
			out({ type: "message_update", message: { role: "assistant", usage: { input: 5, output: 1 } }, assistantMessageEvent: { type: "text_delta", delta: "답" } });
			out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "warm 답 " + n }], stopReason: "stop", usage: { input: 9, cacheRead: 3, output: 2 } } });
			out({ type: "agent_end" });
			if (mode === "crash-after") process.exit(0);
		} else if (c.type === "new_session") {
			out({ id: c.id, type: "response", command: "new_session", success: true, data: {} });
		}
	}
}
`,
);

const realSpawn = runnerDeps.spawn;
const realModelSpawn = modelDeps.spawn;
const realAgentDir = process.env.OMO_CODING_AGENT_DIR;
let agent = "";
const spawns = (): { argv: string[]; pin: string | null }[] => {
	try {
		return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
	} catch {
		return [];
	}
};
const commands = (): string[] => {
	try {
		return readFileSync(cmdFile, "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
};
const account = (name = "default", access = "a") => ({ name, access, refresh: "r", expires: 1 });
const auth = (accounts: unknown[], pinned = "default") => writeFileSync(join(agent, "auth.json"), JSON.stringify({ "anthropic-subscription": { type: "oauth", pinned, accounts } }));
const usage = (windows: { usedPercent: number; resetsAt: string }[], name = "default") => {
	const file = join(agent, "subscription-usage.json");
	let accounts: Record<string, unknown> = {};
	try {
		accounts = JSON.parse(readFileSync(file, "utf8")).accounts;
	} catch {}
	writeFileSync(file, JSON.stringify({ accounts: { ...accounts, [`anthropic-subscription/${name}`]: { windows } } }));
};
const later = (ms: number) => new Date(clock.now + ms).toISOString();

beforeEach(() => {
	agent = mkdtempSync(join(dir, "agent-"));
	process.env.OMO_CODING_AGENT_DIR = agent;
	writeFileSync(logFile, "");
	writeFileSync(cmdFile, "");
	delete process.env.FAKE_OMO_MODE;
	resetHealthForTest();
	resetRunnersForTest();
	// same argv, the fake script in place of the omo binary the test preload points at
	runnerDeps.spawn = (argv, o) => Bun.spawn([process.execPath, fake, ...argv.slice(1)], { cwd: o.cwd, env: o.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" } as never) as never;
	modelDeps.spawn = (argv, options) => Bun.spawn([process.execPath, fake, ...argv.slice(1)], options as never) as never;
});
afterEach(() => {
	resetRunnersForTest();
	resetHealthForTest();
	runnerDeps.spawn = realSpawn;
	modelDeps.spawn = realModelSpawn;
	process.env.OMO_CODING_AGENT_DIR = realAgentDir;
});

test("a spent subscription fails at once with the reset time and starts nothing", async () => {
	auth([account()]);
	usage([{ usedPercent: 100, resetsAt: later(3_600_000) }]);
	const started = Date.now();
	await expect(callModel("sys", "u", { model: SONNET })).rejects.toThrow(`구독 한도에 걸렸어요 · ${resetClock(clock.now + 3_600_000)}에 풀려요`);
	expect(Date.now() - started).toBe(0);
	expect(spawns()).toEqual([]);
});

test("a spent first account moves to another logged-in one that is not spent, and pins it", async () => {
	auth([account("default"), account("work", "b")]);
	usage([{ usedPercent: 100, resetsAt: later(3_600_000) }]);
	usage([{ usedPercent: 7, resetsAt: later(60_000) }], "work");
	expect(subscriptionHealth()).toEqual({ account: "work" });
	const r = await callModel("sys", "u", { model: SONNET });
	expect(r.text).toBe("warm 답 1");
	expect(spawns().map(s => s.pin)).toEqual(["work"]);
});

test("the first call starts one warm process and later calls reuse it", async () => {
	auth([account()]);
	const first = await callModel("sys", "u", { model: SONNET });
	const second = await callModel("sys", "u", { model: SONNET });
	expect([first.text, second.text]).toEqual(["warm 답 1", "warm 답 2"]);
	expect(first.firstTokenMs).toBeNumber();
	expect(first.inputTokens).toBe(12);
	expect(spawns()).toHaveLength(1);
	expect(spawns()[0].argv).toContain("rpc");
	expect(spawns()[0].argv).toContain("--no-tools");
	expect(runnerCountForTest()).toBe(1);
	// each answer resets the session, so the next prompt starts without the one before it
	await flush();
	expect(commands().filter(c => c === "new_session")).toHaveLength(2);
});

test("the effort suffix of the reply model reaches the warm process", async () => {
	auth([account()]);
	await callModel("sys", "u", { model: `${SONNET}:high` });
	const argv = spawns()[0].argv;
	expect(argv[argv.indexOf("--thinking") + 1]).toBe("high");
});

test("another system prompt or model gets its own warm process", async () => {
	auth([account()]);
	await callModel("sys a", "u", { model: SONNET });
	await callModel("sys b", "u", { model: SONNET });
	await callModel("sys a", "u", { model: "anthropic/claude-opus-5-5" });
	expect(spawns()).toHaveLength(3);
	expect(runnerCountForTest()).toBe(3);
});

test("a crashed warm process is replaced on the next call", async () => {
	auth([account()]);
	process.env.FAKE_OMO_MODE = "crash-after";
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("warm 답 1");
	await lastRunnerForTest()!.whenExited();
	delete process.env.FAKE_OMO_MODE;
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("warm 답 1");
	expect(spawns()).toHaveLength(2);
	expect(runnerCountForTest()).toBe(1);
});

test("a warm process that cannot start falls back to the one-shot spawn path", async () => {
	auth([account()]);
	process.env.FAKE_OMO_MODE = "start-crash";
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("print 답");
	const argv = spawns().map(s => s.argv);
	expect(argv).toHaveLength(2);
	expect(argv[0]).toContain("rpc");
	expect(argv[1]).toContain("-p");
});

test("a turn that never answers times out and stops the process", async () => {
	auth([account()]);
	process.env.FAKE_OMO_MODE = "hang";
	const call = callWarm("sys", "u", { model: "anthropic-subscription/claude-sonnet-5-5", timeoutMs: 45_000 });
	const settled = call.catch((e: Error) => e);
	await flush();
	await advance(46_000);
	expect(String(await settled)).toContain("timed out after 45s");
	await flush();
	expect(runnerCountForTest()).toBe(0);
});

test("an idle process is stopped after the idle window", async () => {
	auth([account()]);
	await callModel("sys", "u", { model: SONNET });
	expect(runnerCountForTest()).toBe(1);
	await advance(runnerDeps.idleMs + 1);
	expect(runnerCountForTest()).toBe(0);
});

test("once the usage window resets the account is usable again", () => {
	auth([account()]);
	usage([{ usedPercent: 100, resetsAt: later(60_000) }]);
	expect(() => ensureProvider("anthropic-subscription/claude-sonnet-5-5")).toThrow("구독 한도");
	clock.now += 61_000;
	resetHealthForTest();
	expect(() => ensureProvider("anthropic-subscription/claude-sonnet-5-5")).not.toThrow();
});

test("a blocked pool slot counts even without a spent usage window", () => {
	auth([account()]);
	writeFileSync(join(agent, "credential-pool-state.json"), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots: { default: { blockReason: "rate_limit", blockedUntil: clock.now + 600_000 } } } } } } }));
	expect(() => ensureProvider("anthropic-subscription/claude-sonnet-5-5")).toThrow("구독 한도에 걸렸어요");
});

test("no subscription login is its own reason, and a non-subscription model is not gated", () => {
	writeFileSync(join(agent, "auth.json"), JSON.stringify({}));
	expect(() => ensureProvider("anthropic-subscription/claude-sonnet-5-5")).toThrow("구독 로그인이 없어요");
	expect(() => ensureProvider("openai/gpt-5")).not.toThrow();
});

test("when the pinned account is spent and readiness moves to another, the next call runs on a process pinned to that one", async () => {
	auth([account("default"), account("work", "b")]);
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("warm 답 1");
	usage([{ usedPercent: 100, resetsAt: later(3_600_000) }]);
	resetHealthForTest();
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("warm 답 1");
	expect(spawns().map(s => s.pin)).toEqual(["default", "work"]);
	// the process pinned to the spent account does not keep a slot
	expect(runnerCountForTest()).toBe(1);
});

test("a spent-limit answer stops the process that gave it, so it is never asked again", async () => {
	auth([account()]);
	process.env.FAKE_OMO_MODE = "limit";
	await expect(callWarm("sys", "u", { model: "anthropic-subscription/claude-sonnet-5-5", timeoutMs: 45_000, account: "default" })).rejects.toThrow("rate_limit");
	await flush();
	expect(runnerCountForTest()).toBe(0);
});

test("a warm turn that times out is not followed by a one-shot call that waits the whole bound again", async () => {
	auth([account()]);
	process.env.FAKE_OMO_MODE = "hang";
	const oneShots: string[][] = [];
	const spawnOneShot = modelDeps.spawn;
	modelDeps.spawn = (argv, options) => (oneShots.push(argv), spawnOneShot(argv, options));
	const call = callModel("sys", "u", { model: SONNET, timeoutMs: 45_000 }).catch((e: Error) => e);
	await flush();
	await advance(46_000);
	expect(String(await call)).toContain("timed out after 45s");
	expect(oneShots).toEqual([]);
});

test("two calls of one prompt shape at once run on two processes; the next call reuses an idle one", async () => {
	auth([account()]);
	const [a, b] = await Promise.all([callModel("sys", "u", { model: SONNET }), callModel("sys", "u", { model: SONNET })]);
	expect([a.text, b.text]).toEqual(["warm 답 1", "warm 답 1"]);
	expect(spawns()).toHaveLength(2);
	expect((await callModel("sys", "u", { model: SONNET })).text).toBe("warm 답 2");
	expect(spawns()).toHaveLength(2);
});

test("a full pool never stops a busy process: a new prompt shape takes the one-shot path instead", async () => {
	auth([account()]);
	const max = runnerDeps.maxRunners;
	runnerDeps.maxRunners = 1;
	try {
		process.env.FAKE_OMO_MODE = "hang";
		const busy = callWarm("sys a", "u", { model: "anthropic-subscription/claude-sonnet-5-5", timeoutMs: 45_000, account: "default" }).catch((e: Error) => e);
		await flush();
		delete process.env.FAKE_OMO_MODE;
		expect((await callModel("sys b", "u", { model: SONNET })).text).toBe("print 답");
		expect(runnerCountForTest()).toBe(1);
		await advance(46_000);
		expect(String(await busy)).toContain("timed out");
	} finally {
		runnerDeps.maxRunners = max;
	}
});
