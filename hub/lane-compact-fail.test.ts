// A failed lane compaction (one requeueRefused does not take) is tried again once at the next idle point; only a second failure in a row
// restarts the lane on its session (recover), and a finished compaction in between gives the next failure its retry back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7500;
	compacts = 0;
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
	send(_text: string, _mode: SendMode): void {}
	abort = () => {};
	compact = () => void this.compacts++;
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
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

const turn: AgentEvent[] = [{ type: "alive" }, { type: "turn_start" }, { type: "assistant", text: "ok", stop: "stop" }, { type: "turn_end" }];
const failed: AgentEvent = { type: "compaction", state: "error", error: "Compaction failed: provider stream timed out", requested: true };
const compacted: AgentEvent = { type: "compaction", state: "done", tokensBefore: 5000 };

const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	adapters.fake = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

// A lane that finished its first turn and sits idle, with a session on disk (recover needs one).
async function idleLane(name: string): Promise<{ lane: Lanes.Lane; agent: FakeAgent }> {
	const cwd = join(DATA, "compact-fail-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Build it.\nDone when: tests pass");
	const agent = started.at(-1)!.agent;
	await advance(3000);
	const session = join(DATA, `compact-fail-${name}.jsonl`);
	writeFileSync(session, "{}\n");
	await agent.push({ type: "session", ref: session });
	await agent.push(...turn);
	await advance(500);
	expect(lane.status).toBe("idle");
	return { lane, agent };
}

test("the first compaction failure is retried at the idle point instead of restarting the lane; after a finished compaction the next failure is retried again", async () => {
	const { lane, agent } = await idleLane("cf-retry");
	await agent.push(failed);
	expect(agent.compacts).toBe(1);
	expect(lane.ctx.compaction.state).toBe("compacting");
	expect(lane.recoveries ?? []).toHaveLength(0);
	expect(lane.proc).toBe(agent);

	await agent.push(compacted);
	await agent.push(failed);
	expect(agent.compacts).toBe(2);
	expect(lane.recoveries ?? []).toHaveLength(0);
	l.stopLane("cf-retry");
	await advance(300);
});

test("a second compaction failure in a row restarts the lane on its session", async () => {
	const { lane, agent } = await idleLane("cf-recover");
	await agent.push(failed);
	expect(lane.recoveries ?? []).toHaveLength(0);
	await agent.push(failed);
	expect(agent.compacts).toBe(1);
	expect(lane.recoveries).toHaveLength(1);
	l.stopLane("cf-recover");
	await advance(300);
});
