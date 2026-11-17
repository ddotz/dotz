import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { emitEventActivity } from "./activity.ts";
import { STALL_IDLE_MS } from "./bgwork.ts";
import { laneBusy, laneJobs, type Lane } from "./lanes.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts, SubagentUpdate } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;

class FakeAgent implements AgentProcess {
	static next = 9300;
	pid = FakeAgent.next++;
	awaiting = false;
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private done = Promise.withResolvers<number>();
	readonly exited = this.done.promise;
	end = (code = 0) => this.done.resolve(code);
	readonly events = this.stream();
	constructor(readonly opts: SpawnOpts) {}
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
	awaitingAsync: (() => boolean) | undefined = () => this.awaiting;
	send = () => {};
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {};
}

const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "live", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent(opts);
		started.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
};
const savedCfg = { orchestrator: cfg.orchestrator };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

const sub = (update: SubagentUpdate): AgentEvent => ({ type: "subagent", update });
const worker = (status: SubagentUpdate["status"]): SubagentUpdate => ({ id: "Scout", description: "survey the repo", status });

test("a session is busy while its omp process has a running subagent or says async work can still wake it, and free with neither", async () => {
	const o = createOrchestrator({ key: "omp-busy", stateFile: join(DATA, "omp-busy.json"), source: "omp-busy:conv", keepalive: false });
	expect(o.liveWorkers()).toBe(0);
	o.deliver("hello", true);
	const agent = started.at(-1)!;
	await agent.push({ type: "session", ref: join(DATA, "omp-busy.jsonl") }, { type: "turn_start" }, { type: "turn_end" });
	expect(o.liveWorkers()).toBe(0);

	agent.awaiting = true;
	expect(o.liveWorkers()).toBe(1);
	agent.awaiting = false;
	expect(o.liveWorkers()).toBe(0);

	await agent.push(sub(worker("running")));
	expect(o.liveWorkers()).toBe(1);
	agent.awaiting = true;
	expect(o.liveWorkers()).toBe(1);
	agent.awaiting = false;
	await agent.push(sub(worker("done")));
	expect(o.liveWorkers()).toBe(0);
});

test("a process that reports no awaitingAsync (OmO, claude) adds nothing", async () => {
	const o = createOrchestrator({ key: "omo-busy", stateFile: join(DATA, "omo-busy.json"), source: "omo-busy:conv", keepalive: false });
	o.deliver("hello", true);
	const agent = started.at(-1)!;
	agent.awaitingAsync = undefined;
	await agent.push({ type: "session", ref: join(DATA, "omo-busy.jsonl") }, { type: "turn_start" }, { type: "turn_end" });
	expect(o.liveWorkers()).toBe(0);
});

test("a process that exits takes its running subagents with it, so no ghost worker holds the restart or the park", async () => {
	const o = createOrchestrator({ key: "omp-exit", stateFile: join(DATA, "omp-exit.json"), source: "omp-exit:conv", keepalive: false });
	o.deliver("hello", true);
	const agent = started.at(-1)!;
	await agent.push({ type: "session", ref: join(DATA, "omp-exit.jsonl") }, { type: "turn_start" }, { type: "turn_end" }, sub(worker("running")));
	expect(o.liveWorkers()).toBe(1);
	agent.end();
	await flush();
	expect(o.liveWorkers()).toBe(0);
});

test("a lane's frame-fed subagent is a quiet job once its last progress is older than the stall bound, and progress clears it", async () => {
	const source = "lane:omp-quiet";
	const lane = { name: "omp-quiet", runtime: "omp" } as Lane;
	expect(laneJobs(lane)).toEqual([]);
	emitEventActivity(source, sub(worker("running")));
	expect(laneBusy({ name: "omp-quiet" } as Lane)).toBe(true);
	await advance(STALL_IDLE_MS - 1000);
	expect(laneJobs(lane)).toEqual([]);
	await advance(1000);
	const jobs = laneJobs(lane);
	expect(jobs.map(j => j.what)).toEqual(["survey the repo"]);
	expect(Date.now() - jobs[0]!.since).toBe(STALL_IDLE_MS);

	emitEventActivity(source, sub({ ...worker("running"), tool: "read" }));
	expect(laneJobs(lane)).toEqual([]);
	await advance(STALL_IDLE_MS);
	expect(laneJobs(lane)).toHaveLength(1);
	emitEventActivity(source, sub(worker("done")));
	expect(laneJobs(lane)).toEqual([]);
});
