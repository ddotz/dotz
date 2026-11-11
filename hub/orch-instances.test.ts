// Several orchestrator instances side by side (createOrchestrator, hub/convsessions.ts): each keeps its own process, status,
// held prompts and activity source; the module-level exports stay the main session's; only main pings to keep its cache.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, orchestratorModel, paths, selectorOf } from "./config.ts";
import { activityItems } from "./events.ts";
import { msg } from "./i18n.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const mod: typeof Orchestrator = await import("./orchestrator.ts?instances");

class FakeAgent implements AgentProcess {
	static next = 8100;
	pid = FakeAgent.next++;
	sent: { text: string; mode: SendMode }[] = [];
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

const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: true },
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

function instance(key: string, asks?: boolean) {
	const conv = key !== "main";
	return mod.createOrchestrator({ key, stateFile: join(DATA, `inst-${key.replace(/\W/g, "_")}.json`), source: conv ? `conv:${key}` : `inst:${key}`, keepalive: !conv, env: conv ? { DOTZ_CONV: key } : undefined, scope: conv ? () => `scope of ${key}` : undefined, asks: asks ?? (conv ? false : undefined) });
}
const ofKey = (key: string) => started.filter(a => a.opts.env?.DOTZ_CONV === key);

test("two instances keep their own process, status and held prompts", async () => {
	const a = instance("mail:a");
	const b = instance("ch:b");
	a.deliver("[dotz inbox] mail question", true);
	const pa = ofKey("mail:a")[0]!;
	expect(pa.opts.env).toMatchObject({ DOTZ_ORCHESTRATOR: "1", DOTZ_CONV: "mail:a" });
	expect(pa.sent[0]!.text).toContain("scope of mail:a");
	await pa.push({ type: "session", ref: join(DATA, "inst-a.jsonl") }, { type: "turn_start" });
	expect(a.orch.status).toBe("working");
	expect(b.orch.status).toBe("stopped");
	expect(b.orchestratorPid()).toBeUndefined();
	// A delivery to B while A works spawns B's own process; nothing is steered into A.
	const before = pa.sent.length;
	b.deliver("[dotz inbox] project question", true);
	const pb = ofKey("ch:b")[0]!;
	expect(pb).toBeDefined();
	expect(pb.pid).not.toBe(pa.pid);
	expect(pa.sent.length).toBe(before);
	expect(pb.sent.some(s => s.text.includes("project question"))).toBe(true);
	// Held prompts are per instance: a parked A holds nothing of B's.
	expect(a.heldCount()).toBe(0);
	expect(b.heldCount()).toBe(1);
	await pb.push({ type: "session", ref: join(DATA, "inst-b.jsonl") }, { type: "turn_start" });
	expect(b.heldCount()).toBe(0);
	a.stop();
	b.stop();
	await advance(1000);
});

test("the module-level exports are the main session's", () => {
	expect(mod.orch).toBe(mod.main.orch);
	expect(mod.deliver).toBe(mod.main.deliver);
	expect(mod.start).toBe(mod.main.start);
	expect(mod.main.key).toBe("main");
	expect(mod.main.source).toBe("orchestrator");
});

test("the activity of a conversation session is under conv:<key>", async () => {
	const c = instance("settings:x");
	c.deliver("hello", true);
	const p = ofKey("settings:x")[0]!;
	await p.push({ type: "session", ref: join(DATA, "inst-x.jsonl") }, { type: "turn_start" }, { type: "assistant", text: "hi there", stop: "stop" } as AgentEvent, { type: "turn_end" });
	expect(activityItems("conv:settings:x").length).toBeGreaterThan(0);
	c.stop();
	await advance(1000);
});

test("park ends the process without marking an owner stop, and the next delivery resumes it", async () => {
	const c = instance("th:park");
	c.deliver("first", true);
	const p1 = ofKey("th:park")[0]!;
	await p1.push({ type: "session", ref: join(DATA, "inst-park.jsonl") }, { type: "turn_start" }, { type: "turn_end" });
	expect(c.park()).toBe(true);
	await advance(10);
	expect(c.orch.status).toBe("stopped");
	expect(c.orch.stoppedBy).toBe("");
	await advance(60_000);
	expect(ofKey("th:park")).toHaveLength(1); // a parked session is not restarted by the crash rule
	c.deliver("second", true);
	expect(ofKey("th:park")).toHaveLength(2);
	c.stop();
	await advance(1000);
});

test("only an instance with keepalive pings an idle session", async () => {
	const m = instance("main");
	const c = instance("mail:quiet");
	m.deliver("x", true);
	c.deliver("y", true);
	const pm = started.filter(a => !a.opts.env?.DOTZ_CONV).at(-1)!;
	const pc = ofKey("mail:quiet")[0]!;
	for (const p of [pm, pc]) await p.push({ type: "session", ref: join(DATA, `inst-ka-${p.pid}.jsonl`) }, { type: "turn_start" }, { type: "turn_end" });
	await advance(55 * 60_000);
	const pings = (p: FakeAgent) => p.sent.filter(s => s.text === msg().keepalive).length;
	expect(pings(pm)).toBeGreaterThan(0);
	expect(pings(pc)).toBe(0);
	m.stop();
	c.stop();
	await advance(1000);
});

// Owner 2026-11-03 (his friend's install): a window answered out of another one's context - a conversation's session was handed
// the lane questions waiting in other conversations. Main oversees the lanes and carries them; a conversation answers only here.
test("a conversation's session is never handed another conversation's pending question", async () => {
	const marker = "ASK-MARKER-9c1f 세션 질문 확인";
	const laneDir = join(paths.lanes, "asks-fixture");
	mkdirSync(laneDir, { recursive: true });
	writeFileSync(join(laneDir, "lane.json"), JSON.stringify({ name: "asks-fixture", status: "idle", pendingAsk: { text: marker, at: new Date(0).toISOString() } }));
	try {
		const m = instance("main");
		m.deliver("[dotz inbox] main question", true);
		const pm = started.filter(a => !a.opts.env?.DOTZ_CONV).at(-1)!;
		const conv = instance("mail:asks");
		conv.deliver("[dotz inbox] mail question", true);
		const pc = ofKey("mail:asks")[0]!;
		expect(pm.sent.map(s => s.text).join("\n")).toContain(marker);
		expect(pc.sent.map(s => s.text).join("\n")).not.toContain(marker);
		m.stop();
		conv.stop();
		await advance(1000);
	} finally {
		rmSync(laneDir, { recursive: true, force: true });
	}
});

test("a conversation on its own model: a change takes a fresh session with a handover after the running turn, the same model resumes", async () => {
	const key = "ch:own", ref = join(DATA, "inst-own.jsonl");
	writeFileSync(ref, "{}\n");
	let own = "anthropic/claude-sonnet-5-5:low";
	const c = mod.createOrchestrator({ key, stateFile: join(DATA, "inst-own.json"), source: `conv:${key}`, keepalive: false, env: { DOTZ_CONV: key }, model: () => own });
	c.deliver("[dotz inbox] first", true);
	const p1 = ofKey(key)[0]!;
	expect(p1.opts.model).toBe(own);
	expect(p1.opts.workers).toBe(selectorOf(orchestratorModel()));
	await p1.push({ type: "session", ref }, { type: "turn_start" }, { type: "turn_end" });
	c.park();
	await advance(1000);
	c.deliver("[dotz inbox] same model", true);
	const p2 = ofKey(key)[1]!;
	expect(p2.opts.resume).toBe(ref);
	await p2.push({ type: "session", ref }, { type: "turn_start" });
	// Busy: nothing is killed until its turn ends.
	own = "anthropic/claude-haiku-5-5:medium";
	expect(c.applyModelChange()).toBe("next-start");
	await advance(1000);
	expect(ofKey(key).length).toBe(2);
	await p2.push({ type: "turn_end" });
	await advance(1000);
	const p3 = ofKey(key)[2]!;
	expect(p3.opts.model).toBe(own);
	expect(p3.opts.resume).toBeUndefined();
	expect(p3.sent.some(s => s.mode === "steer" && s.text.includes("[handover]"))).toBe(true);
	c.stop();
	await advance(1000);
});
