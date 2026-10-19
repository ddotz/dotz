// The orchestrator and lane state machines driven through a fake runtime adapter (registered under config `runtime`): the
// hub must reach idle -> working -> final answer -> idle, and pause on a rate-limit error, with exactly the calls on the
// process the omp-bound code used to make. Also pins how the registry picks a runtime.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "../lanes.ts";
import type * as Orchestrator from "../orchestrator.ts";
import { cfg } from "../config.ts";
import { adapters, runtimeFor } from "./index.ts";
import { omp } from "./omp.ts";
import { advance, flush } from "./test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./types.ts";

const DATA = process.env.DOTZ_DIR!;

// Separate copies of the two stateful modules (the query makes a new instance): the scenario test drives the originals in
// this same process and must not inherit status, timers or held messages from this file. Static import cannot do that.
const o: typeof Orchestrator = await import("../orchestrator.ts?fake-adapter");
const l: typeof Lanes = await import("../lanes.ts?fake-adapter");

class FakeAgent implements AgentProcess {
	pid = 7000;
	calls: string[] = [];
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = this.stream();
	private async *stream(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
			await this.wake.promise;
			this.wake = Promise.withResolvers<void>();
		}
	}
	async push(...events: AgentEvent[]): Promise<void> {
		this.queue.push(...events);
		this.wake.resolve();
		await flush();
	}
	send(text: string, mode: SendMode): void {
		this.calls.push(`send:${mode}:${text.slice(0, 40)}`);
	}
	abort = () => void this.calls.push("abort");
	compact = () => void this.calls.push("compact");
	refreshUsage = () => void this.calls.push("refreshUsage");
	refreshSession = () => void this.calls.push("refreshSession");
	watchSubagents = () => void this.calls.push("watchSubagents");
	// Killing the fake ends it, as a real process exits: the hub's exit handling then runs.
	kill = (force?: boolean) => {
		this.calls.push(force ? "kill:force" : "kill");
		this.exit.resolve(0);
	};
}

const started: { opts: SpawnOpts; agent: FakeAgent }[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent();
		started.push({ opts, agent });
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => undefined,
};

const turn = (...mid: AgentEvent[]): AgentEvent[] => [{ type: "alive" }, { type: "turn_start" }, ...mid, { type: "turn_end" }];
const answer = (text: string): AgentEvent => ({ type: "assistant", text, stop: "stop" });
const limit: AgentEvent = { type: "assistant", text: "", stop: "error", error: { text: "429 usage limit reached", kind: "rate", compaction: false } };

// providers.rateLimitDelay asks `omp usage`; an empty report makes the retry delay the plain default.
const patchable = Bun as unknown as { spawn: unknown };
const realSpawn = Bun.spawn;
const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes, runtime: cfg.runtime };

beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { model: "anthropic/test-orch", thinking: "low", ...cfg.orchestrator, runtime: "fake" };
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
	patchable.spawn = (args: string[]) => {
		if (args[1] === "usage") return { stdout: new Response('{"reports":[]}').body, exited: Promise.resolve(0), kill() {} };
		throw new Error(`unexpected spawn in a test: ${args.join(" ")}`);
	};
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
	patchable.spawn = realSpawn;
});

test("config picks the runtime: lanes/orchestrator section, then global, unknown falls back to omp", () => {
	expect(runtimeFor("orchestrator")).toBe(fake);
	expect(runtimeFor("lane")).toBe(fake);
	cfg.orchestrator = { ...cfg.orchestrator!, runtime: undefined };
	cfg.runtime = "fake";
	expect(runtimeFor("orchestrator")).toBe(fake);
	cfg.runtime = "no-such-runtime";
	expect(runtimeFor("orchestrator")).toBe(omp);
	cfg.runtime = "toString";
	expect(runtimeFor("orchestrator")).toBe(omp);
	cfg.runtime = undefined;
	expect(runtimeFor("orchestrator")).toBe(omp);
	cfg.orchestrator = { ...cfg.orchestrator!, runtime: "fake" };
});

test("orchestrator: idle -> working -> final -> idle, then a rate limit pauses and resumes", async () => {
	rmSync(join(DATA, "orchestrator.json"), { force: true });
	const seen: string[] = [];
	o.setAlertHandler(t => seen.push(`alert:${t.slice(0, 20)}`));
	o.setIdleHandler(() => seen.push("idle"));
	o.setAnswerHandlers(
		t => seen.push(`prompt:${t}`),
		t => seen.push(`answer:${t}`),
	);

	o.start();
	const { opts, agent } = started.at(-1)!;
	expect(opts).toMatchObject({ role: "orchestrator", cwd: DATA, model: "anthropic/test-orch:low", resume: undefined, env: { DOTZ_ORCHESTRATOR: "1" } });
	expect(o.orch.status).toBe("starting");
	await advance(4000);
	await agent.push({ type: "session", ref: join(DATA, "fake-session.jsonl") });
	expect(o.orch.status).toBe("idle");
	expect(agent.calls).toEqual([expect.stringMatching(/^send:prompt:\[dotz gateway\]/), "watchSubagents", "refreshSession"]);

	agent.calls.length = 0;
	o.deliver("hello");
	await agent.push({ type: "alive" }, { type: "turn_start" });
	expect(o.orch.status).toBe("working");
	await agent.push({ type: "user", text: "hello" }, { type: "usage", tokens: 1234 }, answer("hi there"), { type: "turn_end" });
	await advance(300);
	expect(o.orch.status).toBe("idle");
	expect(o.orch.lastText).toBe("hi there");
	expect(o.orch.ctx.tokens).toBe(1234);
	expect(seen).toEqual(["prompt:hello", "answer:hi there", "idle"]);
	expect(agent.calls).toEqual(["send:followUp:hello", "refreshUsage"]);

	// steer only reaches a running turn; compaction waits for idle.
	agent.calls.length = 0;
	o.steer("ignored while idle");
	o.deliver("long job");
	await agent.push(...turn().slice(0, 2));
	o.steer("mid-turn note");
	expect(o.compact().state).toBe("queued");
	o.abort();
	await agent.push({ type: "turn_end" });
	expect(agent.calls).toEqual(["send:followUp:long job", "send:steer:mid-turn note", "abort", "refreshUsage", "compact"]);
	await agent.push({ type: "compaction", state: "done", tokensBefore: 5000 }, { type: "usage", tokens: 900 });
	expect(o.orch.ctx.compaction.state).toBe("done");
	expect(agent.calls.at(-1)).toBe("refreshUsage");

	// A rate limit pauses: further messages are held, then one probe goes in after the delay and the held ones follow its success.
	agent.calls.length = 0;
	o.deliver("before limit");
	await agent.push(...turn(limit));
	expect(o.orch.status).toBe("rate-limited");
	o.deliver("held one");
	expect(agent.calls).toEqual(["send:followUp:before limit"]);
	await advance(11 * 60_000 + 1000);
	expect(o.orch.status).toBe("idle");
	expect(agent.calls).toHaveLength(2);
	expect(agent.calls[1]).toMatch(/^send:followUp:/);
	await agent.push(...turn(answer("back")));
	expect(agent.calls.slice(2)).toEqual(["send:followUp:held one"]);
	expect(seen.filter(s => s.startsWith("alert:"))).toHaveLength(1);

	o.stop();
	expect(agent.calls.at(-1)).toBe("kill");
	await advance(300);
});

test("lane: launch -> working -> report -> idle, then a rate limit holds owner messages", async () => {
	const cwd = join(DATA, "fake-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "fk"), { recursive: true, force: true });
	const reports: string[] = [];
	l.setReportHandler((lane, text) => reports.push(`${lane.name}:${text.slice(0, 40)}`));
	l.setIdleHandler(() => {});

	const lane = l.launch("fk", cwd, "Build it.\nDone when: tests pass");
	const { opts, agent } = started.at(-1)!;
	expect(opts).toMatchObject({ role: "lane", cwd, model: "anthropic/test-lane:medium", resume: undefined, env: { DOTZ_LANE: "fk" }, lane: { name: "fk", workerModel: "anthropic/test-worker:high", compactAt: 300000, keepRecent: 30000 } });
	expect(agent.calls).toEqual(["watchSubagents", expect.stringMatching(/^send:prompt:Build it\./)]);
	await advance(3000);
	await agent.push({ type: "session", ref: join(DATA, "fake-lane-session.jsonl") });
	expect(lane.sessionFile).toBe(join(DATA, "fake-lane-session.jsonl"));
	expect(agent.calls.at(-1)).toBe("refreshSession");

	await agent.push({ type: "alive" }, { type: "turn_start" });
	expect(lane.status).toBe("working");
	await agent.push(answer("all green"), { type: "turn_end" });
	await advance(500);
	expect(lane.status).toBe("idle");
	expect(reports).toEqual(["fk:all green"]);
	expect(agent.calls.at(-1)).toBe("refreshUsage");

	agent.calls.length = 0;
	l.sendToLane("fk", "go on");
	await agent.push(...turn(limit));
	expect(lane.status).toBe("rate-limited");
	l.sendToLane("fk", "while paused");
	expect(lane.held).toEqual(["while paused"]);
	expect(agent.calls).toHaveLength(1);
	expect(reports).toHaveLength(2);
	await advance(11 * 60_000 + 1000);
	expect(lane.status).toBe("idle");
	expect(agent.calls).toHaveLength(2);
	expect(agent.calls[1]).toMatch(/^send:prompt:/);

	l.shutdownLanes();
	l.lanes.delete("fk");
});
