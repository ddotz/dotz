// omp walks its own fallback chain after a refusal or a failed request and never comes back: the gateway tells the owner (the
// alert channel for the orchestrator, the lane's channel for a lane) and switches the process back to its configured model with
// an RPC set_model, before the next turn for a refusal / provider error and after the reset for a usage limit. A scripted "omp"
// (mocked Bun.spawn, as in hub/runtime/scenario.ts) is fed the retry_fallback_applied frame and its stdin is recorded.
// FALLBACK_REVERT_TRACE=<file> also writes the trace (frames the hub wrote, notices) of each case.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { resetFallbackState } from "./fallback.ts";
import type * as Lanes from "./lanes.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
// Separate copies of the modules (a query string makes a new instance): a static import would share timers and state with the other test files.
const o: typeof Orchestrator = await import("./orchestrator.ts?fallback-revert");
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

type Frame = Record<string, unknown> & { type: string };
class FakeProc {
	static all: FakeProc[] = [];
	pid = 8100 + FakeProc.all.length;
	frames: Frame[] = [];
	private ctl!: ReadableStreamDefaultController<Uint8Array>;
	stdout = new ReadableStream<Uint8Array>({ start: c => void (this.ctl = c) });
	stderr = new ReadableStream<Uint8Array>();
	private done!: (code: number) => void;
	exited = new Promise<number>(r => void (this.done = r));
	stdin = {
		write: (s: string) => {
			for (const line of s.split("\n").filter(Boolean)) {
				const { id: _id, ...f } = JSON.parse(line);
				this.frames.push(f);
				trace(`  stdin ${JSON.stringify(typeof f.message === "string" ? { ...f, message: f.message.slice(0, 40) } : f)}`);
			}
			return s.length;
		},
		flush: () => 0,
	};
	constructor(readonly args: string[]) {
		FakeProc.all.push(this);
	}
	kill() {
		this.ctl.close();
		this.done(0);
	}
	async push(f: unknown) {
		this.ctl.enqueue(new TextEncoder().encode(`${JSON.stringify(f)}\n`));
		await flush();
	}
	// The frame types written since `from`, e.g. ["set_model", "set_thinking_level", "prompt"].
	types = (from = 0) => this.frames.slice(from).map(f => f.type);
}

const patchable = Bun as unknown as { spawn: unknown };
const realSpawn = Bun.spawn;
const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes, models: cfg.models };
const orchModel = { model: "anthropic/test-orch", thinking: "low" };
const alerts: string[] = [];
const notices: string[] = [];
const laneNotices: string[] = [];
const trace = (line: string) => {
	if (process.env.FALLBACK_REVERT_TRACE) appendFileSync(process.env.FALLBACK_REVERT_TRACE, `${line}\n`);
};
const proc = () => FakeProc.all.at(-1)!;

const agentStart = { type: "agent_start" };
const agentEnd = { type: "agent_end" };
const stateResp = (sessionFile: string) => ({ type: "response", command: "get_state", success: true, data: { sessionFile, contextUsage: { tokens: 1500, contextWindow: 200_000 } } });
const fallbackFrame = (reason: string, to = "anthropic/test-fallback") => ({ type: "retry_fallback_applied", from: "anthropic/test-orch", to, role: "default", reason });

beforeAll(() => {
	patchable.spawn = (args: string[]) => {
		if (args.includes("rpc")) return new FakeProc(args);
		if (args[1] === "usage") return { stdout: new Response('{"reports":[]}').body, exited: Promise.resolve(0), kill() {} };
		throw new Error(`unexpected spawn in a test: ${args.join(" ")}`);
	};
	o.setNoticeHandler(t => notices.push(t));
	o.setAlertHandler(t => {
		alerts.push(t);
		trace(`  alert  ${t}`);
	});
	o.setAnswerHandlers(() => {}, () => {});
	o.setIdleHandler(() => {});
	l.setNoticeHandler((lane, t) => {
		laneNotices.push(`${lane.name}: ${t}`);
		trace(`  lane notice  ${lane.name}: ${t}`);
	});
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
	patchable.spawn = realSpawn;
});

// Starts the orchestrator on a saved session and gets it idle.
async function startOrchestrator(): Promise<void> {
	const session = join(DATA, "revert-session.jsonl");
	writeFileSync(session, "");
	writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ sessionFile: session, model: "anthropic/test-orch:low" }));
	resetFallbackState();
	cfg.orchestrator = { runtime: "omp" };
	cfg.models = { ...savedCfg.models, orchestrator: orchModel };
	o.start();
	await advance(4000);
	await proc().push(stateResp(session));
	expect(o.orch.status).toBe("idle");
	expect(o.orch.activeModel).toBe("anthropic/test-orch:low");
}
async function stopOrchestrator(): Promise<void> {
	o.stop();
	await advance(300);
}
// One whole turn that omp finishes on a fallback model.
async function turnWithFallback(p: FakeProc, reason: string): Promise<void> {
	await p.push(agentStart);
	await p.push(fallbackFrame(reason));
	await p.push(agentEnd);
}

test("orchestrator: a refusal alerts the owner and goes back to the configured model before the next prompt", async () => {
	trace("# orchestrator, refusal");
	await startOrchestrator();
	const p = proc();
	alerts.length = 0;
	o.deliver("first question");
	await advance(1000);
	await turnWithFallback(p, "Refusal (cyber): the request was declined");
	// The fallback is one plain alert line; the worklog notice channel stays quiet; nothing is switched mid-turn or at its end.
	expect(alerts).toHaveLength(1);
	expect(alerts[0]).toContain("Model fallback: anthropic/test-orch → anthropic/test-fallback (Refusal (cyber): the request was declined)");
	expect(notices).toEqual([]);
	expect(o.orch.activeModel).toBe("anthropic/test-fallback");
	expect(p.types()).not.toContain("set_model");
	await advance(30 * 60_000);
	expect(p.types()).not.toContain("set_model");

	// The next owner message: set_model (and the thinking level) go in ahead of the prompt.
	const before = p.frames.length;
	o.deliver("second question");
	expect(p.types(before)).toEqual(["set_model", "set_thinking_level", "prompt"]);
	expect(p.frames[before]).toEqual({ type: "set_model", provider: "anthropic", modelId: "test-orch" });
	expect(p.frames[before + 1]).toEqual({ type: "set_thinking_level", level: "low" });
	expect(o.orch.activeModel).toBe("anthropic/test-orch:low");
	expect(alerts).toHaveLength(2);
	expect(alerts[1]).toContain("Back on the original model (anthropic/test-orch)");

	// It falls back again inside that turn: the alert repeats, nothing switches mid-turn, and it is undone again before the
	// next prompt (a refusal is about one request; a process left on the fallback until restart is the bug being fixed).
	await p.push(agentStart);
	await p.push(fallbackFrame("Refusal (cyber): the request was declined"));
	await p.push(agentEnd);
	expect(alerts).toHaveLength(3);
	const after = p.frames.length;
	o.deliver("third question");
	expect(p.types(after)).toEqual(["set_model", "set_thinking_level", "prompt"]);
	await stopOrchestrator();
});

test("orchestrator: a usage limit goes back only after the reset (15 minutes without a reported one)", async () => {
	trace("# orchestrator, usage limit");
	await startOrchestrator();
	const p = proc();
	alerts.length = 0;
	o.deliver("question");
	await advance(1000);
	await turnWithFallback(p, "429 usage limit reached");
	expect(alerts).toHaveLength(1);
	expect(alerts[0]).toContain("anthropic/test-orch → anthropic/test-fallback");

	// A prompt before the reset stays on the fallback.
	await advance(10 * 60_000);
	const early = p.frames.length;
	o.deliver("question while limited");
	expect(p.types(early)).toEqual(["prompt"]);
	await p.push(agentStart);
	await p.push(agentEnd);
	await advance(3 * 60_000);
	expect(p.types()).not.toContain("set_model");
	expect(o.orch.activeModel).toBe("anthropic/test-fallback");

	// Past the reset an idle process is switched back without waiting for a message.
	await advance(3 * 60_000);
	expect(p.types()).toContain("set_model");
	expect(p.frames.find(f => f.type === "set_model")).toEqual({ type: "set_model", provider: "anthropic", modelId: "test-orch" });
	expect(o.orch.activeModel).toBe("anthropic/test-orch:low");
	expect(alerts.at(-1)).toContain("Back on the original model (anthropic/test-orch)");
	expect(alerts).toHaveLength(2);
	await stopOrchestrator();
});

test("orchestrator: a retry-after in the usage limit sets the reset; a prompt after it switches back first", async () => {
	trace("# orchestrator, usage limit with retry-after");
	await startOrchestrator();
	const p = proc();
	alerts.length = 0;
	o.deliver("question");
	await advance(1000);
	await turnWithFallback(p, "429 usage limit reached retry-after-ms: 120000");
	expect(alerts).toHaveLength(1);
	// 120 s plus the one-minute margin of the existing rate-limit pause; the idle check runs once a minute.
	await advance(2 * 60_000);
	expect(p.types()).not.toContain("set_model");
	const before = p.frames.length;
	await advance(5 * 60_000);
	expect(p.types(before)).toEqual(["set_model", "set_thinking_level"]);
	await stopOrchestrator();
});

test("orchestrator on a runtime that cannot switch models: the alert says it stays on the fallback", async () => {
	trace("# orchestrator, runtime without setModel");
	const started: SpawnOpts[] = [];
	const agents: Array<{ push: (...e: AgentEvent[]) => Promise<void> }> = [];
	const fake: RuntimeAdapter = {
		id: "fake" as RuntimeAdapter["id"],
		caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
		start(opts) {
			started.push(opts);
			const queue: AgentEvent[] = [];
			let wake = Promise.withResolvers<void>();
			const exit = Promise.withResolvers<number>();
			const agent: AgentProcess & { push: (...e: AgentEvent[]) => Promise<void> } = {
				pid: 8200,
				exited: exit.promise,
				events: (async function* () {
					for (;;) {
						while (queue.length) yield queue.shift()!;
						await wake.promise;
						wake = Promise.withResolvers<void>();
					}
				})(),
				send() {},
				abort() {},
				compact() {},
				refreshUsage() {},
				refreshSession() {},
				watchSubagents() {},
				kill: () => exit.resolve(0),
				push: async (...e) => {
					queue.push(...e);
					wake.resolve();
					await flush();
				},
			};
			agents.push(agent);
			return agent;
		},
		classifyError: () => undefined,
		recentExchanges: () => undefined,
		detect: async () => ({ installed: true }),
	};
	adapters.fake = fake;
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	cfg.orchestrator = { runtime: "fake" };
	cfg.models = { ...savedCfg.models, orchestrator: orchModel };
	alerts.length = 0;
	o.start();
	await advance(4000);
	await agents[0].push({ type: "session", ref: join(DATA, "revert-session.jsonl") }, { type: "alive" }, { type: "turn_start" }, { type: "fallback", from: "anthropic/test-orch", to: "anthropic/test-fallback", reason: "Refusal (cyber): declined" }, { type: "turn_end" });
	expect(alerts).toHaveLength(1);
	expect(alerts[0]).toContain("Model fallback: anthropic/test-orch → anthropic/test-fallback");
	expect(alerts[0]).toContain("cannot switch models");
	await stopOrchestrator();
	delete adapters.fake;
});

test("lane: a refusal posts to the lane channel and goes back before the next prompt", async () => {
	trace("# lane, refusal");
	resetFallbackState();
	cfg.lanes = { ...savedCfg.lanes!, runtime: "omp" };
	const cwd = join(DATA, "revert-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "rv"), { recursive: true, force: true });
	laneNotices.length = 0;
	alerts.length = 0;
	const lane = l.launch("rv", cwd, "Build it.\nDone when: tests pass");
	const p = proc();
	expect(lane.activeModel).toBe("anthropic/test-lane:medium");
	await advance(3000);
	await p.push(stateResp(join(DATA, "revert-lane-session.jsonl")));
	await p.push(agentStart);
	await p.push({ ...fallbackFrame("Refusal (cyber): declined"), from: "anthropic/test-lane", to: "anthropic/test-lane-fallback" });
	await p.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
	await p.push(agentEnd);
	await advance(500);
	expect(lane.status).toBe("idle");
	expect(laneNotices).toEqual(["rv: Model fallback: anthropic/test-lane → anthropic/test-lane-fallback (Refusal (cyber): declined)"]);
	expect(alerts).toEqual([]);
	expect(lane.activeModel).toBe("anthropic/test-lane-fallback");
	expect(p.types()).not.toContain("set_model");

	const before = p.frames.length;
	l.sendToLane("rv", "next task");
	expect(p.types(before)).toEqual(["set_model", "set_thinking_level", "prompt"]);
	expect(p.frames[before]).toEqual({ type: "set_model", provider: "anthropic", modelId: "test-lane" });
	expect(p.frames[before + 1]).toEqual({ type: "set_thinking_level", level: "medium" });
	expect(lane.activeModel).toBe("anthropic/test-lane:medium");
	expect(laneNotices.at(-1)).toBe("rv: Back on the original model (anthropic/test-lane)");
	expect(laneNotices).toHaveLength(2);
	l.shutdownLanes();
	l.lanes.delete("rv");
});
