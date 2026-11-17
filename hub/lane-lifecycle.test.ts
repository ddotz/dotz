import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import { WORKER_HOLD_MS } from "./worker-hold.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts, SubagentUpdate } from "./runtime/types.ts";

const WORKER_HOLD_STEP_MS = 5_000;
const DATA = process.env.DOTZ_DIR!;
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	static next = 7400;
	pid = FakeAgent.next++;
	sent: { text: string; mode: SendMode }[] = [];
	aborts: (boolean | undefined)[] = [];
	kills: (boolean | undefined)[] = [];
	compacts = 0;
	awaiting = false;
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
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
	end = async (code = 0): Promise<void> => {
		this.exit.resolve(code);
		await flush();
	};
	awaitingAsync = () => this.awaiting;
	send = (text: string, mode: SendMode) => void this.sent.push({ text, mode });
	abort = (clearQueue?: boolean) => void this.aborts.push(clearQueue);
	compact = () => void this.compacts++;
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = (force?: boolean) => void this.kills.push(force);
}

const spawns: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "live", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent(opts);
		spawns.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};
const savedCfg = { lanes: cfg.lanes };
const notices: string[] = [];
beforeAll(() => {
	adapters.fakeomp = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomp" };
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
	l.setNoticeHandler((_lane, text) => void notices.push(text));
});
afterAll(() => {
	delete adapters.fakeomp;
	Object.assign(cfg, savedCfg);
});

const CWD = join(DATA, "lc-work");
const owner = (text: string) => `[owner via web] ${text}`;
const sentTo = (a: FakeAgent) => a.sent.map(s => s.text);

async function idleLane(name: string): Promise<{ lane: Lanes.Lane; agent: FakeAgent }> {
	mkdirSync(CWD, { recursive: true });
	const lane = l.launch(name, CWD, "Build it.\nDone when: it builds");
	const agent = spawns.at(-1)!;
	const session = join(DATA, `${name}.jsonl`);
	writeFileSync(session, "");
	lane.sessionFile = session;
	await agent.push({ type: "turn_start" }, { type: "assistant", text: "ready", stop: "stop" }, { type: "turn_end" });
	expect(lane.status).toBe("idle");
	return { lane, agent };
}
const spawnedSince = (n: number) => spawns.slice(n);

test("L-01: an extension command such as /budget-ok is sent as a prompt that starts no turn, so the owner's message behind it is not steered into an idle process", async () => {
	const { lane, agent } = await idleLane("lc-cmd");
	expect(l.sendToLane("lc-cmd", "/budget-ok")).toBe("received");
	expect(agent.sent.at(-1)).toEqual({ text: "/budget-ok", mode: "prompt" });
	expect(lane.prompted).toBeUndefined();
	expect(lane.startingOn).toBeUndefined();
	expect(lane.status).toBe("idle");
	await advance(130_000);
	expect(agent.kills).not.toContain(true);
	l.sendToLane("lc-cmd", owner("ㄱ"));
	const reply = agent.sent.at(-1)!;
	expect(reply.mode).toBe("prompt");
	expect(reply.text).toContain(owner("ㄱ"));
	l.stopLane("lc-cmd");
	await agent.end();
});

test("L-02: a message sent while a parked lane's process is stopping goes to the process that resumes the lane, not into the dying one", async () => {
	const { lane, agent } = await idleLane("lc-park");
	expect(l.parkLane(lane)).toBe(true);
	expect(agent.kills).toEqual([undefined]);
	const before = spawns.length;
	expect(l.sendToLane("lc-park", owner("지금 해줘"))).toBe("resumed");
	expect(sentTo(agent).some(t => t.includes("지금 해줘"))).toBe(false);
	expect(spawns.length).toBe(before);
	await agent.end(143);
	const next = spawnedSince(before);
	expect(next).toHaveLength(1);
	expect(next[0].opts.resume).toBe(lane.sessionFile);
	expect(sentTo(next[0]).filter(t => t.includes("지금 해줘"))).toHaveLength(1);
	expect(lane.proc).toBe(next[0]);
	l.stopLane("lc-park");
	await next[0].end();
});

test("L-02: a message sent while an owner restart waits for the old process goes to the new one exactly once", async () => {
	const { lane, agent } = await idleLane("lc-restart-msg");
	const before = spawns.length;
	const restart = l.restartLane("lc-restart-msg");
	expect(l.sendToLane("lc-restart-msg", owner("방금 말한 거"))).toBe("resumed");
	expect(sentTo(agent).some(t => t.includes("방금 말한 거"))).toBe(false);
	await agent.end();
	await restart;
	await flush();
	const next = spawnedSince(before);
	expect(next).toHaveLength(1);
	expect(sentTo(next[0]).filter(t => t.includes("방금 말한 거"))).toHaveLength(1);
	expect(lane.proc).toBe(next[0]);
	l.stopLane("lc-restart-msg");
	await next[0].end();
});

test("L-02: a process that ignores the stop is killed outright after the grace, and the waiting message is still delivered", async () => {
	const { lane, agent } = await idleLane("lc-force");
	l.parkLane(lane);
	l.sendToLane("lc-force", owner("아직 있어?"));
	await advance(16_000);
	expect(agent.kills).toEqual([undefined, true]);
	const before = spawns.length;
	await agent.end(137);
	const next = spawnedSince(before);
	expect(next).toHaveLength(1);
	expect(sentTo(next[0]).some(t => t.includes("아직 있어?"))).toBe(true);
	l.stopLane("lc-force");
	await next[0].end();
});

test("L-03: two restarts at once share one: one new process, the old one stopped once, both callers settle", async () => {
	const { lane, agent } = await idleLane("lc-dup");
	const before = spawns.length;
	const first = l.restartLane("lc-dup");
	const second = l.restartLane("lc-dup");
	await agent.end();
	await Promise.all([first, second]);
	expect(agent.kills).toHaveLength(1);
	const next = spawnedSince(before);
	expect(next).toHaveLength(1);
	expect(lane.proc).toBe(next[0]);
	expect(lane.restarting).toBeUndefined();
	const third = l.restartLane("lc-dup");
	await next[0].end();
	await third;
	expect(spawnedSince(before)).toHaveLength(2);
	l.stopLane("lc-dup");
	await spawns.at(-1)!.end();
});

test("L-03: a rotation and a restart at once also share one respawn", async () => {
	const { agent } = await idleLane("lc-rot");
	const before = spawns.length;
	const rotating = l.rotateLane("lc-rot", "nightly");
	const restarting = l.restartLane("lc-rot");
	await agent.end();
	await Promise.all([rotating, restarting]);
	expect(spawnedSince(before)).toHaveLength(1);
	l.stopLane("lc-rot");
	await spawns.at(-1)!.end();
});

test("L-03: a stop while a restart waits for the old process is not undone: no new process, the lane stays stopped", async () => {
	const { lane, agent } = await idleLane("lc-stop");
	const before = spawns.length;
	const restart = l.restartLane("lc-stop");
	l.stopLane("lc-stop");
	await agent.end();
	await restart;
	await flush();
	expect(spawns.length).toBe(before);
	expect(lane.proc).toBeUndefined();
	expect(lane.status).toBe("exited");
});

test("L-07: stopping an omp lane takes back the owner message it had steered instead of letting omp start a turn from it; the next message carries it", async () => {
	const { lane, agent } = await idleLane("lc-abort");
	await agent.push({ type: "turn_start" });
	expect(l.sendToLane("lc-abort", owner("이것도 해줘"))).toBe("steered");
	expect(lane.steered).toHaveLength(1);
	l.abortLane("lc-abort");
	expect(agent.aborts).toEqual([true]);
	expect(lane.steered).toBeUndefined();
	await agent.push({ type: "turn_end" });
	l.sendToLane("lc-abort", owner("그럼 다시"));
	const text = agent.sent.at(-1)!.text;
	expect(text).toContain("이것도 해줘");
	expect(text).toContain("그럼 다시");
	expect(lane.restored).toBeUndefined();
	l.stopLane("lc-abort");
	await agent.end();
});

test("L-07: a steered message the session echoed back as a user message is no longer resent after a recovery", async () => {
	const { lane, agent } = await idleLane("lc-echo");
	await agent.push({ type: "turn_start" });
	l.sendToLane("lc-echo", owner("한 줄 더"));
	expect(lane.steered).toHaveLength(1);
	await agent.push({ type: "user", text: owner("한 줄 더") });
	expect(lane.steered).toEqual([]);
	l.stopLane("lc-echo");
	await agent.end();
});

test("L-06: after omp's own compaction the old token count is gone, so the turn end does not ask for a second one", async () => {
	const { lane, agent } = await idleLane("lc-compact");
	await agent.push({ type: "turn_start" }, { type: "usage", tokens: 990_000, window: 1_000_000 });
	await agent.push({ type: "compaction", state: "done", tokensBefore: 990_000 }, { type: "turn_end" });
	expect(lane.ctx.tokens ?? 0).toBe(0);
	expect(agent.compacts).toBe(0);
	l.stopLane("lc-compact");
	await agent.end();
});

test("L-15: an errored message that kept some text is handled as the error it is, not reported as the lane's answer", async () => {
	const { lane, agent } = await idleLane("lc-err");
	await agent.push({ type: "turn_start" });
	await agent.push({ type: "assistant", text: "partial answ", stop: "error", error: { text: "You have hit your usage limit", kind: "rate", compaction: false } });
	await advance(100);
	expect(lane.lastText).not.toContain("partial answ");
	expect(lane.status).toBe("rate-limited");
	l.stopLane("lc-err");
	await agent.end();
});

test("L-08: an omp lane that reported [done] is not busy because a dev server still runs; one that has not reported is", async () => {
	const { lane, agent } = await idleLane("lc-busy");
	agent.awaiting = true;
	lane.lastText = "[done] shipped";
	expect(l.laneBusy(lane)).toBe(false);
	lane.lastText = "waiting on the build";
	expect(l.laneBusy(lane)).toBe(true);
	expect(l.laneBusy(lane, false)).toBe(false);
	agent.awaiting = false;
	expect(l.laneBusy(lane)).toBe(false);
	l.stopLane("lc-busy");
	await agent.end();
});

test("L-17: what keeps an omp lane up is listed as a job, so the owner is told what it waits on; nothing once it has reported done", async () => {
	const { lane, agent } = await idleLane("lc-jobs");
	expect(l.laneJobs(lane)).toEqual([]);
	agent.awaiting = true;
	lane.lastText = "waiting on the build";
	expect(l.laneJobs(lane)).toHaveLength(1);
	expect(l.parkLane(lane)).toBe(false);
	lane.lastText = "[done] shipped";
	expect(l.laneJobs(lane)).toEqual([]);
	l.stopLane("lc-jobs");
	await agent.end();
});

test("L-10: a worker-model change on an omp lane is not told to a process that cannot take it; the lane restarts to apply it", async () => {
	const { lane, agent } = await idleLane("lc-wm");
	const before = spawns.length;
	const was = lane.activeWorkerModel;
	expect(l.setLaneWorkerModel("lc-wm", "anthropic/claude-haiku-4-5", false)).toBe("next-start");
	expect(agent.sent.filter(s => s.mode === "steer")).toEqual([]);
	expect(lane.activeWorkerModel).toBe(was);
	await agent.end();
	await flush();
	const next = spawnedSince(before);
	expect(next).toHaveLength(1);
	expect(next[0].opts.lane?.workerModel).toContain("haiku");
	l.stopLane("lc-wm");
	await next[0].end();
});

test("L-10: a lane that is working applies the worker-model change at its next idle moment", async () => {
	const { lane, agent } = await idleLane("lc-wm2");
	await agent.push({ type: "turn_start" });
	expect(l.setLaneWorkerModel("lc-wm2", "anthropic/claude-haiku-4-5", false)).toBe("next-start");
	expect(lane.accountStale).toBe(true);
	expect(agent.kills).toEqual([]);
	l.stopLane("lc-wm2");
	await agent.end();
});

const scout: SubagentUpdate = { id: "Scout", description: "survey the repo", status: "running" };

test("L-16: an owner restart of an omp lane with a running subagent is refused, naming it, and cuts nothing", async () => {
	const { lane, agent } = await idleLane("lc-workers-owner");
	await agent.push({ type: "subagent", update: scout });
	const before = spawns.length;
	await expect(l.restartLane("lc-workers-owner", undefined, true)).rejects.toThrow("survey the repo");
	await expect(l.rotateLane("lc-workers-owner", "nightly")).rejects.toThrow("survey the repo");
	expect(agent.kills).toEqual([]);
	expect(spawns.length).toBe(before);
	expect(lane.proc).toBe(agent);
	await agent.push({ type: "subagent", update: { ...scout, status: "done" } });
	l.stopLane("lc-workers-owner");
	await agent.end();
});

test("L-16: another restart (the memory guard's) of an omp lane waits for the subagent, then goes ahead", async () => {
	const { lane, agent } = await idleLane("lc-workers-hold");
	await agent.push({ type: "subagent", update: scout });
	const before = spawns.length;
	await l.restartLane("lc-workers-hold", "메모리 가드");
	await advance(10 * 60_000);
	expect(agent.kills).toEqual([]);
	expect(spawns.length).toBe(before);
	await agent.push({ type: "subagent", update: { ...scout, status: "done" } });
	await advance(WORKER_HOLD_STEP_MS + 1000);
	expect(agent.kills).toHaveLength(1);
	await agent.end();
	const next = spawnedSince(before);
	expect(next).toHaveLength(1);
	expect(lane.proc).toBe(next[0]);
	l.stopLane("lc-workers-hold");
	await next[0].end();
});

test("L-16: a subagent that never ends holds the restart only for the bound, then the restart goes ahead and names it in the resume note", async () => {
	const { lane, agent } = await idleLane("lc-workers");
	await agent.push({ type: "subagent", update: scout });
	const before = spawns.length;
	await l.restartLane("lc-workers");
	await advance(WORKER_HOLD_MS - 60_000);
	expect(agent.kills).toEqual([]);
	await advance(2 * 60_000);
	expect(agent.kills).toHaveLength(1);
	await agent.end();
	const next = spawnedSince(before);
	expect(next).toHaveLength(1);
	expect(sentTo(next[0]).some(t => t.includes("survey the repo"))).toBe(true);
	expect(lane.proc).toBe(next[0]);
	l.stopLane("lc-workers");
	await next[0].end();
});

test("L-13: a lane left working on a runtime the config no longer names is told to the owner once, not only logged", () => {
	mkdirSync(join(DATA, "lanes", "lc-old"), { recursive: true });
	const session = join(DATA, "lc-old.jsonl");
	writeFileSync(session, "");
	writeFileSync(join(DATA, "lanes", "lc-old", "lane.json"), JSON.stringify({ name: "lc-old", cwd: CWD, model: "m", status: "working", startedAt: "2026-11-01T00:00:00.000Z", reports: 0, sessionFile: session, runtime: "omo" }));
	notices.length = 0;
	l.restoreLanes();
	const lane = l.lanes.get("lc-old")!;
	expect(lane.status).toBe("exited");
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("handover");
});
