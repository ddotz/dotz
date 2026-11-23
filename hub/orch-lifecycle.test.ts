import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, DATA_DIR } from "./config.ts";
import { REST_QUIET_MS } from "./context.ts";
import { COMPACT_ABORT_GRACE_MS, COMPACT_DEADLINE_MS } from "./orch-compaction.ts";
import { startedIndex } from "./orchestrator-parts.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode } from "./runtime/types.ts";
import { clearTrackedTimers } from "./shutdown.ts";
import { setCpuSampler } from "./stuck.ts";
const realSampler = setCpuSampler(async () => undefined);

const mod: typeof Orchestrator = await import("./orchestrator.ts?lifecycle");

class FakeAgent implements AgentProcess {
	static next = 7600;
	pid = FakeAgent.next++;
	sent: { text: string; mode: SendMode }[] = [];
	models: string[] = [];
	aborts: unknown[] = [];
	cancels = 0;
	killed = 0;
	forced = 0;
	slowKill = false;
	asyncJobs = false;
	abortCompaction?: () => void;
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
	setModel(selector: string): void {
		this.models.push(selector);
	}
	abort = (clearQueue?: boolean) => void this.aborts.push(clearQueue);
	awaitingAsync = () => this.asyncJobs;
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = (force?: boolean) => {
		if (force) this.forced++;
		else this.killed++;
		if (force || !this.slowKill) this.exit.resolve(0);
	};
	die = (code: number) => this.exit.resolve(code);
}

const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "live", contextNumbers: "exact", compact: "rpc", sessionTranscript: true, promptCacheKeepalive: true, contextLimit: "compact", extension: true },
	start: () => {
		const a = new FakeAgent();
		started.push(a);
		return a;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "IN: before\n\nYOU: after",
	lastCompactionSummary: () => "SUMMARY",
	summaryStale: () => false,
};
const savedCfg = { orchestrator: cfg.orchestrator, models: cfg.models };
const CONFIG = join(DATA_DIR, "config.json");
const originalConfig = readFileSync(CONFIG, "utf8");
const setGuard = (guard: Record<string, unknown>): void => {
	const doc = JSON.parse(originalConfig) as { guard?: Record<string, unknown> };
	writeFileSync(CONFIG, JSON.stringify({ ...doc, guard: { ...doc.guard, ...guard } }));
};
const useModel = (model: Record<string, unknown>): void => void (cfg.models = { ...savedCfg.models, orchestrator: model } as typeof cfg.models);
const OPUS = (thinking: string, fallback?: string[]) => ({ model: "anthropic/claude-opus-5-5", thinking, ...(fallback ? { fallback } : {}) });
const SONNET = { model: "anthropic/claude-sonnet-5-5", thinking: "high" };
const CHAINED = ["anthropic/claude-sonnet-5-5:low"];
const sub = (id: string, status: "running" | "done" = "running"): AgentEvent => ({ type: "subagent", update: { id, status } });
const longTurn = (tokens: number): AgentEvent[] => [{ type: "turn_start" }, { type: "usage", tokens }, { type: "assistant", text: "ok", stop: "stop" }, { type: "turn_end" }];

const instances: Orchestrator.Orchestrator[] = [];
beforeAll(() => {
	adapters.lifecycle = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "lifecycle" };
});
afterEach(() => {
	for (const o of instances.splice(0)) o.stop();
	cfg.models = savedCfg.models;
	writeFileSync(CONFIG, originalConfig);
	clearTrackedTimers();
});
afterAll(() => {
	delete adapters.lifecycle;
	Object.assign(cfg, savedCfg);
	setCpuSampler(realSampler);
});

let seq = 0;
const dirs: string[] = [];
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "orch-lifecycle-"));
	dirs.push(dir);
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "{}\n");
	const o = mod.createOrchestrator({ key: "main", stateFile: join(dir, "orch.json"), source: `lifecycle:${++seq}`, keepalive: false });
	instances.push(o);
	const agent = () => started.at(-1)!;
	const turn = async (...events: AgentEvent[]) => agent().push({ type: "session", ref: sessionFile }, { type: "turn_start" }, ...events, { type: "turn_end" });
	return { dir, sessionFile, o, agent, turn };
}

test("startedIndex names the owed prompt a recorded user message carries", () => {
	const owed = [{ text: "first question" }, { text: "" }, { text: "second question" }];
	expect(startedIndex(owed, "[running now: none]\nsecond question\n\nretain nudge")).toBe(2);
	expect(startedIndex(owed, "an unrelated note")).toBe(-1);
	expect(startedIndex([], "second question")).toBe(-1);
	// The runtime records the user text trimmed: a prompt sent with a trailing newline is still the one it started.
	expect(startedIndex([{ text: "handed back\n" }], "handed back")).toBe(0);
	expect(startedIndex([{ text: "\n" }], "anything")).toBe(-1);
});

test("F2-01 a compaction nobody answers is given up at the deadline: the process is replaced and the held owner message reaches the new one", async () => {
	const s = setup();
	s.o.deliver("t1", true);
	await s.turn();
	const a = s.agent();
	await a.push(...longTurn(400_000));
	expect(s.o.orch.ctx.compaction.state).toBe("compacting");
	await advance(COMPACT_DEADLINE_MS - 2 * 60_000);
	s.o.deliver("owner message", true);
	expect(s.o.heldCount()).toBe(1);
	expect(a.killed).toBe(0);
	await advance(4 * 60_000);
	expect(a.killed).toBe(1);
	const b = s.agent();
	expect(b).not.toBe(a);
	expect(b.sent.some(m => m.text.includes("owner message"))).toBe(true);
	expect(s.o.orch.ctx.compaction.state).toBeUndefined();
});

test("F2-01 a compaction that ends in time is left alone", async () => {
	const s = setup();
	s.o.deliver("t1", true);
	await s.turn();
	const a = s.agent();
	await a.push(...longTurn(400_000));
	await advance(10 * 60_000);
	await a.push({ type: "compaction", state: "done", tokensBefore: 400_000 }, { type: "usage", tokens: 20_000 });
	await advance(COMPACT_DEADLINE_MS * 2);
	expect(a.killed).toBe(0);
	expect(started.at(-1)).toBe(a);
});

test("F2-01 a runtime that can cancel a compaction is asked to first, and the session restarts when it still does not answer after the grace", async () => {
	const s = setup();
	s.o.deliver("t1", true);
	await s.turn();
	const a = s.agent();
	a.abortCompaction = () => void a.cancels++;
	s.o.compact();
	expect(s.o.orch.ctx.compaction.state).toBe("compacting");
	for (let minutes = 0; minutes < 40 && a.cancels === 0; minutes++) await advance(60_000);
	expect(a.cancels).toBe(1);
	expect(a.killed).toBe(0);
	await advance(COMPACT_ABORT_GRACE_MS + 60_000);
	expect(a.killed).toBe(1);
	expect(started.at(-1)).not.toBe(a);
});

test("F2-02 a stop that lands while a restart is killing the process leaves no flag behind: the next message starts a process and goes to it", async () => {
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const old = s.agent();
	old.slowKill = true;
	s.o.restart("model or effort change");
	s.o.stop();
	old.die(0);
	await flush();
	expect(s.o.orch.status).toBe("stopped");
	const before = started.length;
	s.o.deliver("second", true);
	await flush();
	expect(started.length).toBe(before + 1);
	expect(s.agent().sent.some(m => m.text.includes("second"))).toBe(true);
});

test("F2-02 the same after a stop during a rotation", async () => {
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const old = s.agent();
	old.slowKill = true;
	await old.push(...longTurn(400_000));
	await old.push({ type: "compaction", state: "error", error: "boom", requested: true });
	expect(old.killed).toBe(1);
	s.o.stop();
	old.die(0);
	await flush();
	const before = started.length;
	s.o.deliver("second", true);
	await flush();
	expect(started.length).toBe(before + 1);
	expect(s.agent().sent.some(m => m.text.includes("second"))).toBe(true);
});

test("F4-03 a park that lands while a restart is killing the process is refused and the restart goes on", async () => {
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const old = s.agent();
	old.slowKill = true;
	s.o.restart("model or effort change");
	expect(s.o.park()).toBe(false);
	old.die(0);
	await flush();
	expect(s.agent()).not.toBe(old);
	await s.turn();
	s.o.deliver("second", true);
	expect(s.agent().sent.some(m => m.text.includes("second"))).toBe(true);
});

test("F2-05 a follow-up the running turn consumed is no longer owed to the process: nothing stays held and a restart does not send it again", async () => {
	const s = setup();
	s.o.deliver("A-first", true);
	const a = s.agent();
	await a.push({ type: "session", ref: s.sessionFile }, { type: "turn_start" });
	s.o.deliver("B-midturn", true);
	expect(s.o.heldCount()).toBe(1);
	await a.push({ type: "user", text: "A-first" }, { type: "assistant", text: "answer A", stop: "stop" }, { type: "user", text: "B-midturn" }, { type: "assistant", text: "answer B", stop: "stop" }, { type: "turn_end" });
	expect(s.o.heldCount()).toBe(0);
	s.o.restart("model or effort change");
	await flush();
	expect(s.agent()).not.toBe(a);
	expect(s.agent().sent.filter(m => m.text.includes("B-midturn"))).toHaveLength(0);
});

test("F4-04 a model change on an idle omp session with a plain fallback chain waits for the background workers instead of cutting them", async () => {
	useModel(OPUS("medium", CHAINED));
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const old = s.agent();
	await old.push(sub("w1"));
	expect(s.o.liveWorkers()).toBe(1);
	useModel(OPUS("high", CHAINED));
	expect(s.o.applyModelChange()).toBe("next-start");
	await flush();
	expect(old.killed).toBe(0);
	await old.push(sub("w1", "done"));
	await advance(6_000);
	expect(old.killed).toBe(1);
	expect(s.agent()).not.toBe(old);
});

test("F4-04 a model change on an idle omp session with no worker restarts at once", async () => {
	useModel(OPUS("medium", CHAINED));
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const old = s.agent();
	useModel(OPUS("high", CHAINED));
	expect(s.o.applyModelChange()).toBe("restarted");
	await flush();
	expect(old.killed).toBe(1);
});

test("F4-04 a fallback chain change on an idle omp session waits for the background workers too", async () => {
	useModel(OPUS("medium", CHAINED));
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const old = s.agent();
	await old.push(sub("w3"));
	useModel(OPUS("medium", ["anthropic/claude-haiku-5-5:low"]));
	expect(s.o.applyChainChange()).toBe("after-turn");
	await flush();
	expect(old.killed).toBe(0);
	await old.push(sub("w3", "done"));
	await advance(6_000);
	expect(old.killed).toBe(1);
});

test("F4-05 an omp model change that would move the task workers restarts when free; an effort change switches in place", async () => {
	useModel(OPUS("medium"));
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const first = s.agent();
	useModel(OPUS("high"));
	expect(s.o.applyModelChange()).toBe("live");
	expect(first.models).toEqual(["anthropic/claude-opus-5-5:high"]);
	useModel(SONNET);
	expect(s.o.applyModelChange()).toBe("restarted");
	await flush();
	expect(first.models).toHaveLength(1);
	expect(first.killed).toBe(1);
	expect(s.agent()).not.toBe(first);
});

test("F4-05 a model change that leaves the task workers where they are (an expensive model's workers use models.workers) stays in place", async () => {
	setGuard({ ask_before_expensive: true, expensive_models: ["opus", "fable"] });
	useModel(OPUS("medium"));
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const first = s.agent();
	useModel({ model: "anthropic/claude-fable-5-2", thinking: "medium" });
	expect(s.o.applyModelChange()).toBe("live");
	expect(first.models).toEqual(["anthropic/claude-fable-5-2:medium"]);
	expect(first.killed).toBe(0);
});

test("F2-07 a silent turn is aborted at the stuck limit, except one that waits in a wait call for a worker that runs; a queued compaction excuses nothing", async () => {
	const silent = async (turn: { worker: boolean; waits: boolean; compaction?: boolean }) => {
		const s = setup();
		s.o.deliver("go", true);
		const a = s.agent();
		await a.push({ type: "session", ref: s.sessionFile }, { type: "turn_start" });
		if (turn.worker) await a.push(sub(`w-${seq}`));
		if (turn.waits) await a.push({ type: "activity", row: { type: "tool_call", tool: "wait", call_id: "wait1", text: "wait" } });
		if (turn.compaction) s.o.compact();
		await advance(3 * 3_600_000);
		return a.aborts.length;
	};
	expect(await silent({ worker: true, waits: false })).toBeGreaterThan(0);
	expect(await silent({ worker: true, waits: true })).toBe(0);
	expect(await silent({ worker: false, waits: true, compaction: true })).toBeGreaterThan(0);
});

test("F2-09 a job only awaitingAsync reports does not keep the nightly start waiting for rest; a running task worker does", async () => {
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const a = s.agent();
	await a.push(sub("w4"));
	await advance(REST_QUIET_MS + 1000);
	expect(s.o.nightlyHandover(50e6)).toBeUndefined();
	await a.push(sub("w4", "done"));
	a.asyncJobs = true;
	await advance(REST_QUIET_MS + 1000);
	expect(s.o.nightlyHandover(50e6)).toBeDefined();
	expect(a.killed).toBe(0);
	a.asyncJobs = false;
	await advance(6_000);
	expect(a.killed).toBe(1);
});

test("F2-10 a worker hold that ends while a turn runs leaves the turn alone and restarts after it", async () => {
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const old = s.agent();
	await old.push(sub("w2"));
	s.o.resumeAfterError();
	await advance(6_000);
	expect(old.killed).toBe(0);
	s.o.deliver("next", true);
	await old.push({ type: "turn_start" });
	expect(s.o.orch.status).toBe("working");
	await old.push(sub("w2", "done"));
	await advance(6_000);
	expect(old.killed).toBe(0);
	await old.push({ type: "turn_end" });
	await flush();
	expect(old.killed).toBe(1);
});

test("F4-12 a process that ignores the park's SIGTERM is killed for good after 10 s", async () => {
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const a = s.agent();
	a.slowKill = true;
	expect(s.o.park()).toBe(true);
	await advance(9_000);
	expect(a.forced).toBe(0);
	await advance(2_000);
	expect(a.forced).toBe(1);
});

test("F2-12 a restart asked for during a turn does not outlive a crash: the new process is not restarted after its first turn", async () => {
	useModel(OPUS("medium", CHAINED));
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	const a = s.agent();
	await a.push({ type: "turn_start" });
	expect(s.o.applyChainChange()).toBe("after-turn");
	a.die(1);
	await advance(10_500);
	const b = s.agent();
	expect(b).not.toBe(a);
	await b.push({ type: "session", ref: s.sessionFile }, { type: "turn_start" }, { type: "turn_end" });
	await advance(6_000);
	expect(b.killed).toBe(0);
});

test("F2-14 a stop during the crash backoff is not undone by the backoff timer", async () => {
	const s = setup();
	s.o.deliver("first", true);
	await s.turn();
	s.agent().die(1);
	await flush();
	expect(s.o.orch.status).toBe("stopped");
	const before = started.length;
	s.o.stop();
	await advance(11_000);
	expect(started.length).toBe(before);
});

test("F4-07 a session holds no timer while it has no process", async () => {
	const open = new Set<unknown>();
	const { setInterval: set, clearInterval: clear } = globalThis;
	globalThis.setInterval = ((fn: () => void, ms?: number) => {
		const handle = set(fn, ms);
		open.add(handle);
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
		open.delete(handle);
		clear(handle);
	}) as typeof clearInterval;
	try {
		const s = setup();
		expect(open.size).toBe(0);
		s.o.deliver("first", true);
		await s.turn();
		expect(open.size).toBeGreaterThan(0);
		s.o.stop();
		await flush();
		expect(open.size).toBe(0);
	} finally {
		globalThis.setInterval = set;
		globalThis.clearInterval = clear;
	}
});
