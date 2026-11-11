// After a network failure the lane comes back by itself: one laneTransient turn when the model host answers again, parked or live,
// also across a gateway restart (2026-11-06: note-merge sat parked after the network returned, until a message reached it).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
import { startResumeWatch } from "./orch-error.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const l: typeof Lanes = await import("./lanes.ts");
const { interruptedLanes } = await import("./lanereconnect.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7600;
	private queue: AgentEvent[] = [];
	private wake?: () => void;
	private closed = false;
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events: AsyncIterable<AgentEvent> = {
		[Symbol.asyncIterator]: async function* (this: FakeAgent) {
			for (;;) {
				while (this.queue.length) yield this.queue.shift()!;
				if (this.closed) return;
				await new Promise<void>(r => (this.wake = r));
			}
		}.bind(this),
	};
	push(...evs: AgentEvent[]): void {
		this.queue.push(...evs);
		this.wake?.();
	}
	sent: string[] = [];
	send = (text: string) => void this.sent.push(text);
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {
		this.closed = true;
		this.wake?.();
		this.exit.resolve(137);
	};
}
const spawns: { opts: SpawnOpts; agent: FakeAgent }[] = [];
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent();
		spawns.push({ opts, agent });
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};
const savedCfg = { lanes: cfg.lanes };
let reachable = false;
let watch: ReturnType<typeof setInterval>;
beforeAll(() => {
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	l.setReportHandler(() => {});
	l.setNoticeHandler(() => {});
	l.setIdleHandler(() => {});
	watch = startResumeWatch({ interrupted: interruptedLanes, reachable: async () => reachable, log: () => {}, every: 1_000 });
});
afterAll(() => {
	clearInterval(watch);
	delete adapters.fakeomo;
	Object.assign(cfg, savedCfg);
});

const TIMED_OUT: AgentEvent = { type: "assistant", text: "", stop: "error", error: { text: "Provider stream start timed out after 300000ms", kind: "transient", compaction: false } };
const OK: AgentEvent = { type: "assistant", text: "[run] 이어서 합니다", stop: "stop" };
const resumes = (a: FakeAgent) => a.sent.filter(t => t.startsWith(msg().laneTransient));
const ticks = async (n = 3) => {
	for (let i = 0; i < n; i++) {
		await advance(1_000);
		await flush();
	}
};

async function idle(name: string): Promise<{ lane: Lanes.Lane; agent: FakeAgent }> {
	const cwd = join(DATA, "reconnect-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Polish the theme.\nDone when: owner approves");
	const agent = spawns.at(-1)!.agent;
	const session = join(DATA, `${name}.jsonl`);
	writeFileSync(session, "");
	lane.sessionFile = session;
	agent.push({ type: "alive" }, { type: "turn_start" }, OK, { type: "turn_end" });
	await flush();
	await advance(5_000);
	await flush();
	expect(lane.status).toBe("idle");
	return { lane, agent };
}

// The whole retry budget on a dead network, down to the lane error.
async function spendRetries(agent: FakeAgent, lane: Lanes.Lane): Promise<void> {
	for (let i = 0; i < 5; i++) {
		agent.push({ type: "turn_start" }, TIMED_OUT, { type: "turn_end" });
		await flush();
		// Only up to the retry itself: past that the prompt watchdog would take the silence for a hung process.
		for (let wait = 0; lane.transientTimer && wait < 200; wait++) await advance(1_000);
		await flush();
	}
	expect(lane.lastText).toStartWith("[lane error]");
	expect(lane.transientTimer).toBeUndefined();
}

test("retries spent: nothing while the host is down, one resume when it answers, and an answered turn clears the mark", async () => {
	reachable = false;
	const { lane, agent } = await idle("lost-retries");
	await spendRetries(agent, lane);
	const sent = agent.sent.length;
	await ticks();
	expect(agent.sent.length).toBe(sent);
	reachable = true;
	await ticks();
	expect(agent.sent.length).toBe(sent + 1);
	expect(agent.sent.at(-1)).toStartWith(msg().laneTransient);
	agent.push({ type: "turn_start" }, OK, { type: "turn_end" });
	await flush();
	await ticks();
	expect(lane.interrupted).toBeUndefined();
	expect(agent.sent.length).toBe(sent + 1);
	l.stopLane("lost-retries");
	await advance(300);
});

test("the resume also fails on a second outage: the next answer gives one more resume, not two", async () => {
	reachable = true;
	const { lane, agent } = await idle("second-outage");
	await spendRetries(agent, lane);
	await ticks();
	expect(resumes(agent).length).toBe(5);
	reachable = false;
	await spendRetries(agent, lane);
	await ticks();
	const before = resumes(agent).length;
	reachable = true;
	await ticks(6);
	expect(resumes(agent).length).toBe(before + 1);
	l.stopLane("second-outage");
	await advance(300);
});

test("a parked lane cut off by the network comes back through a gateway restart once the host answers; a truly idle parked lane stays parked", async () => {
	reachable = false;
	const cut = await idle("restart-cut");
	const quiet = await idle("restart-quiet");
	await spendRetries(cut.agent, cut.lane);
	expect(l.parkLane(cut.lane)).toBe(true);
	expect(l.parkLane(quiet.lane)).toBe(true);
	await advance(300);
	await flush();
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "restart-cut", "lane.json"), "utf8")).interrupted).toEqual({});
	l.lanes.delete("restart-cut");
	l.lanes.delete("restart-quiet");
	const before = spawns.length;
	l.restoreLanes();
	await ticks();
	expect(spawns.length).toBe(before);
	reachable = true;
	await ticks();
	expect(spawns.length).toBe(before + 1);
	expect(spawns.at(-1)!.opts.resume).toBe(cut.lane.sessionFile);
	expect(spawns.at(-1)!.agent.sent.filter(t => t.startsWith(msg().laneTransient))).toHaveLength(1);
	expect(l.lanes.get("restart-quiet")!.proc).toBeUndefined();
	l.stopLane("restart-cut");
	l.stopLane("restart-quiet");
	await advance(300);
});

test("an owner-stopped lane, a lane on a usage limit and a finished lane are left as they are", async () => {
	reachable = false;
	const stopped = await idle("left-stopped");
	const limited = await idle("left-limited");
	const finished = await idle("left-finished");
	for (const { lane, agent } of [stopped, limited, finished]) await spendRetries(agent, lane);
	l.stopLane("left-stopped");
	await advance(300);
	await flush();
	limited.lane.status = "rate-limited";
	finished.lane.claim = { state: "verified", at: new Date().toISOString(), evidence: "ok" };
	finished.lane.unreported = undefined;
	const counts = [limited.agent.sent.length, finished.agent.sent.length];
	const before = spawns.length;
	reachable = true;
	await ticks();
	expect(spawns.length).toBe(before);
	expect([limited.agent.sent.length, finished.agent.sent.length]).toEqual(counts);
	expect(limited.lane.held).toBeUndefined();
	expect(stopped.lane.status).toBe("exited");
	expect(finished.lane.interrupted).toBeUndefined();
	limited.lane.status = "idle";
	limited.lane.interrupted = undefined;
	l.stopLane("left-limited");
	l.stopLane("left-finished");
	await advance(300);
});

// A task worker of the lane, last heard on a provider error (hub/bgwork.ts stallOf).
function erroredWorker(lane: Lanes.Lane, message: string): void {
	const root = "01a1a711-4db3-7aa6-8fd6-bd53b48fb0f1", agent = join(DATA, `agent-${lane.name}`), store = join(agent, "projects", "p", "senpi-task");
	mkdirSync(join(agent, "sessions", "s"), { recursive: true });
	mkdirSync(join(store, "tasks"), { recursive: true });
	mkdirSync(join(store, "logs"), { recursive: true });
	lane.sessionFile = join(agent, "sessions", "s", `2026-11-04T14-58-11-507Z_${root}.jsonl`);
	writeFileSync(lane.sessionFile, "");
	writeFileSync(join(store, "tasks", "st_cut.json"), JSON.stringify({ task_id: "st_cut", status: "running", pid: process.pid, root_session_id: root, description: "주석 통합", started_at: new Date(Date.now() - 60 * 60_000).toISOString() }));
	const log = join(store, "logs", "st_cut.jsonl");
	writeFileSync(log, `${JSON.stringify({ type: "child_error", payload: { message, stop_reason: "error" } })}\n`);
	const at = (Date.now() - 10 * 60_000) / 1000;
	utimesSync(log, at, at);
}

test("a lane idle on a worker lost to the network gets one resume, and the same worker does not earn a second one", async () => {
	reachable = true;
	const { lane, agent } = await idle("worker-lost");
	const sent = agent.sent.length;
	erroredWorker(lane, "Provider stream start timed out after 300000ms");
	await ticks();
	expect(agent.sent.length).toBe(sent + 1);
	expect(agent.sent.at(-1)).toStartWith(msg().laneTransient);
	agent.push({ type: "turn_start" }, OK, { type: "turn_end" });
	await flush();
	await ticks();
	expect(agent.sent.length).toBe(sent + 1);
	l.stopLane("worker-lost");
	await advance(300);
});
