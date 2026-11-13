// After a compaction the lane's footer (identity and rules) must reach the lane again: the extension queues it in the lane's process when the
// runtime loads it (cleared at the next turn start); a respawn or a runtime without the hook loses that, and the next gateway prompt carries it once.
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
	pid = 7400;
	sent: { text: string; mode: SendMode }[] = [];
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
		this.sent.push({ text, mode });
	}
	abort = () => {};
	compact = () => {};
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
const compacted: AgentEvent = { type: "compaction", state: "done", tokensBefore: 5000 };
const count = (text: string, sub: string) => text.split(sub).length - 1;

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

// A lane that finished its first turn and sits idle, with a session on disk.
async function idleLane(name: string): Promise<{ lane: Lanes.Lane; agent: FakeAgent }> {
	const cwd = join(DATA, "due-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Build it.\nDone when: tests pass");
	const agent = started.at(-1)!.agent;
	await advance(3000);
	const session = join(DATA, `due-${name}.jsonl`);
	writeFileSync(session, "{}\n");
	await agent.push({ type: "session", ref: session });
	await agent.push(...turn);
	await advance(500);
	expect(lane.status).toBe("idle");
	return { lane, agent };
}

test("a compaction, then a respawn with resume: the next gateway prompt carries the lane footer once", async () => {
	fake.caps.extension = true;
	const { lane, agent } = await idleLane("due-resume");
	await agent.push(compacted);
	expect(lane.contractDue).toBe(true);
	l.stopLane("due-resume");
	await advance(300);
	expect(lane.proc).toBeUndefined();

	l.sendToLane("due-resume", "after the restart");
	const resumed = started.at(-1)!.agent;
	expect(resumed).not.toBe(agent);
	expect(count(resumed.sent.at(-1)!.text, "[dotz lane due-resume]")).toBe(1);
	expect(lane.contractDue).toBeUndefined();
	await resumed.push(...turn);
	await advance(500);
	l.sendToLane("due-resume", "later");
	expect(resumed.sent.at(-1)!.text).not.toContain("[dotz lane due-resume]");
	l.stopLane("due-resume");
	await advance(300);
});

test("a compaction, then a turn in the same process: the extension delivered the footer, the gateway prompt does not repeat it", async () => {
	fake.caps.extension = true;
	const { lane, agent } = await idleLane("due-live");
	await agent.push(compacted);
	expect(lane.contractDue).toBe(true);
	await agent.push(...turn); // the turn the extension's next-turn message went into
	await advance(500);
	expect(lane.contractDue).toBeUndefined();
	l.sendToLane("due-live", "next");
	expect(agent.sent.at(-1)!.text).not.toContain("[dotz lane due-live]");
	l.stopLane("due-live");
	await advance(300);
});

test("a runtime that does not load the extension: the first gateway prompt after a compaction carries the footer, once", async () => {
	fake.caps.extension = false;
	const { lane, agent } = await idleLane("due-nohook");
	await agent.push(compacted);
	l.sendToLane("due-nohook", "first");
	expect(count(agent.sent.at(-1)!.text, "[dotz lane due-nohook]")).toBe(1);
	expect(lane.contractDue).toBeUndefined();
	await agent.push(...turn);
	await advance(500);
	l.sendToLane("due-nohook", "second");
	expect(agent.sent.at(-1)!.text).not.toContain("[dotz lane due-nohook]");
	l.stopLane("due-nohook");
	await advance(300);
});
