// Several orchestrator instances side by side (createOrchestrator, hub/convsessions.ts): each keeps its own process, status,
// held prompts and activity source; the module-level exports stay the main session's; only main pings to keep its cache.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cfg } from "./config.ts";
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

function instance(key: string) {
	const conv = key !== "main";
	return mod.createOrchestrator({ key, stateFile: join(DATA, `inst-${key.replace(/\W/g, "_")}.json`), source: conv ? `conv:${key}` : `inst:${key}`, keepalive: !conv, env: conv ? { DOTZ_CONV: key } : undefined, scope: conv ? () => `scope of ${key}` : undefined });
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
