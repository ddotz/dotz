// The retain nudge: every handover tells the new session to save durable facts to memory, and a finished compaction makes
// the next prompt to that process carry the same line exactly once (no extra turn is started for it).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;

// Own copies of the stateful modules (the query makes a new instance): a static import cannot, and the scenario test
// drives the originals in this same process.
const o: typeof Orchestrator = await import("./orchestrator.ts?retain-nudge");
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

// Keeps whole prompts (the fake in fake-adapter.test.ts cuts them to 40 characters).
class FakeAgent implements AgentProcess {
	pid = 7100;
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
	recentExchanges: () => "user: earlier question\nassistant: earlier answer",
};

const answer = (text: string): AgentEvent => ({ type: "assistant", text, stop: "stop" });
const compacted: AgentEvent = { type: "compaction", state: "done", tokensBefore: 5000 };
const count = (text: string, sub: string) => text.split(sub).length - 1;

const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

test("handover texts carry the nudge once, and only when there are exchanges to retain from", () => {
	const nudge = msg().retainNudge;
	expect(nudge).toContain("retain");
	expect(msg().handover("old.jsonl", "tail")).toContain(nudge);
	expect(msg().laneHandover("old.jsonl", "tail")).toContain(nudge);
	expect(msg().laneHandover("old.jsonl", undefined)).not.toContain(nudge);
});

test("orchestrator: a rotated start carries the nudge in its handover, a compaction nudges the next message once", async () => {
	// A session saved by another runtime makes start() begin a fresh one with a handover.
	const session = join(DATA, "retain-orch-session.jsonl");
	writeFileSync(session, "{}\n");
	writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ sessionFile: session, runtime: "other-runtime" }));
	o.start();
	const { agent } = started.at(-1)!;
	expect(agent.sent).toHaveLength(1);
	expect(agent.sent[0]!.text).toContain("[handover]");
	expect(count(agent.sent[0]!.text, msg().retainNudge)).toBe(1);

	await advance(4000);
	await agent.push({ type: "session", ref: session });
	o.deliver("before compaction");
	expect(agent.sent.at(-1)!.text).toBe("before compaction");

	await agent.push(compacted);
	expect(agent.sent).toHaveLength(2); // the compaction itself sends nothing
	o.deliver("after compaction");
	expect(agent.sent.at(-1)).toEqual({ text: `after compaction\n\n${msg().retainNudge}`, mode: "followUp" });
	o.deliver("later");
	expect(agent.sent.at(-1)!.text).toBe("later");

	o.stop();
	await advance(1000);
	rmSync(join(DATA, "orchestrator.json"), { force: true });
});

test("lane: a rotated session carries the nudge once, a compaction nudges the next prompt once", async () => {
	const cwd = join(DATA, "retain-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "rn"), { recursive: true, force: true });
	const lane = l.launch("rn", cwd, "Build it.\nDone when: tests pass");
	const first = started.at(-1)!.agent;
	await advance(3000);
	const session = join(DATA, "retain-lane-session.jsonl");
	writeFileSync(session, "{}\n");
	await first.push({ type: "session", ref: session });
	await first.push({ type: "alive" }, { type: "turn_start" }, answer("done"), { type: "turn_end" });
	await advance(500);
	expect(lane.status).toBe("idle");
	expect(count(first.sent[0]!.text, msg().retainNudge)).toBe(0);

	await first.push(compacted);
	l.sendToLane("rn", "first after compaction");
	expect(first.sent.at(-1)!.text).toContain(msg().retainNudge);
	expect(count(first.sent.at(-1)!.text, msg().retainNudge)).toBe(1);
	await first.push({ type: "alive" }, { type: "turn_start" }, answer("ok"), { type: "turn_end" });
	await advance(500);
	l.sendToLane("rn", "second");
	expect(first.sent.at(-1)!.text).not.toContain(msg().retainNudge);

	// Rotation: the fresh session's prompt has exactly one nudge, even with a compaction flag pending.
	await first.push({ type: "alive" }, { type: "turn_start" }, answer("ok"), { type: "turn_end" });
	await advance(500);
	await first.push(compacted);
	const rotating = l.rotateLane("rn", "test rotation");
	await rotating;
	const second = started.at(-1)!.agent;
	expect(second).not.toBe(first);
	expect(second.sent).toHaveLength(1);
	expect(second.sent[0]!.text).toContain("[handover]");
	expect(count(second.sent[0]!.text, msg().retainNudge)).toBe(1);

	l.shutdownLanes();
	l.lanes.delete("rn");
});
