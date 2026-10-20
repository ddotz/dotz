// A lane's [ask] report is a question for the owner that the gateway remembers until it is answered, and that a
// (re)started orchestrator hears in full. Lanes and the orchestrator run on a fake runtime adapter (as claim.test.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pendingAskFile, pendingAsks, pendingAsksBlock } from "./asks.ts";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
import type * as Lanes from "./lanes.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
// Own copies of the stateful modules (the query makes a new instance): the scenario test drives the originals in this process.
const l: typeof Lanes = await import("./lanes.ts?asks");
const o: typeof Orchestrator = await import("./orchestrator.ts?asks");

class FakeAgent implements AgentProcess {
	pid = 7300;
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

const agents: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start() {
		const agent = new FakeAgent();
		agents.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "user: earlier question\nassistant: earlier answer",
};

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

async function turn(agent: FakeAgent, text: string): Promise<void> {
	await agent.push({ type: "alive" }, { type: "turn_start" }, { type: "assistant", text, stop: "stop" }, { type: "turn_end" });
	await advance(500);
}
const laneJson = () => JSON.parse(readFileSync(join(DATA, "lanes", "pa", "lane.json"), "utf8"));
const question = (n: number) => `[ask] Which branch should this go to?\n${"detail ".repeat(Math.ceil(n / 7))}`.slice(0, n);

test("pending ask: an [ask] report is saved whole, gateway notices keep it, the owner's answer or a plain report clears it", async () => {
	const cwd = join(DATA, "asks-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "pa"), { recursive: true, force: true });
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
	const lane = l.launch("pa", cwd, "Build it.\nDone when: tests pass");
	const agent = agents.at(-1)!;
	await advance(3000);

	const ask = question(1800);
	await turn(agent, ask);
	expect(lane.pendingAsk).toMatchObject({ text: ask });
	expect(laneJson().pendingAsk).toMatchObject({ text: ask });
	expect(typeof laneJson().pendingAsk.at).toBe("string");
	expect(readFileSync(pendingAskFile("pa"), "utf8")).toBe(`${ask}\n`);
	expect(l.laneSummary().find(s => s.name === "pa")?.pendingAsk).toMatchObject({ text: ask });
	expect(pendingAsks()).toMatchObject([{ lane: "pa", text: ask }]);

	// A gateway-written lane error is not the lane speaking: the question stays.
	await agent.push({ type: "alive" }, { type: "turn_start" }, { type: "assistant", text: "", stop: "error", error: { text: "boom", kind: undefined, compaction: false } }, { type: "turn_end" });
	await advance(500);
	expect(lane.pendingAsk?.text).toBe(ask);

	// The owner's answer clears it (and removes the file).
	l.sendToLane("pa", "[owner via web] main");
	expect(lane.pendingAsk).toBeUndefined();
	expect(laneJson().pendingAsk).toBeUndefined();
	expect(existsSync(pendingAskFile("pa"))).toBe(false);
	expect(pendingAsks()).toEqual([]);
	expect(pendingAsksBlock()).toBe("");

	// A following non-[ask] report also clears a pending question; a new [ask] sets it again.
	await turn(agent, "[ask] second question?");
	expect(lane.pendingAsk?.text).toBe("[ask] second question?");
	await turn(agent, "[run] still working");
	expect(lane.pendingAsk).toBeUndefined();
	expect(laneJson().pendingAsk).toBeUndefined();

	// lane.json keeps a new question, which is what a restarted gateway reads back (restoreLanes spreads the record).
	await turn(agent, "[ask] third question?");
	expect(laneJson().pendingAsk.text).toBe("[ask] third question?");
	l.sendToLane("pa", "answer");
	l.stopLane("pa");
	await advance(300);
});

test("pending asks block: a >700 char question is whole, a >1500 char one is cut with the file path", () => {
	const lanesDir = join(DATA, "lanes");
	const put = (name: string, text: string) => {
		mkdirSync(join(lanesDir, name), { recursive: true });
		writeFileSync(join(lanesDir, name, "lane.json"), JSON.stringify({ name, pendingAsk: { text, at: "2026-10-19T03:04:00.000Z" } }));
	};
	const mid = question(1000);
	const long = question(1800);
	put("pa-mid", mid);
	put("pa-long", long);
	mkdirSync(join(lanesDir, "pa-stray"), { recursive: true }); // a folder without lane.json is ignored

	const block = pendingAsksBlock();
	expect(block).toContain(msg().pendingAsksHead);
	expect(block).toContain("pa-mid");
	expect(block).toContain(mid); // the old 700 cut would fail here
	expect(block).toContain("12:04"); // 03:04Z is KST afternoon
	expect(block).toContain("pa-long");
	expect(block).toContain(long.slice(0, 1500));
	expect(block).not.toContain(long.slice(0, 1501));
	expect(block).toContain(pendingAskFile("pa-long"));
	expect(block).not.toContain(pendingAskFile("pa-mid"));
	expect(block).not.toContain("pa-stray");

	rmSync(join(lanesDir, "pa-mid"), { recursive: true, force: true });
	rmSync(join(lanesDir, "pa-long"), { recursive: true, force: true });
	rmSync(join(lanesDir, "pa-stray"), { recursive: true, force: true });
	expect(pendingAsksBlock()).toBe("");
});

test("orchestrator: a fresh start carries pending asks in its first prompt, a resumed one on the next owner message once", async () => {
	const lanesDir = join(DATA, "lanes");
	const long = question(1000);
	mkdirSync(join(lanesDir, "pa-orch"), { recursive: true });
	writeFileSync(join(lanesDir, "pa-orch", "lane.json"), JSON.stringify({ name: "pa-orch", pendingAsk: { text: long, at: "2026-10-19T03:04:00.000Z" } }));

	// No saved session: a fresh start.
	rmSync(join(DATA, "orchestrator.json"), { force: true });
	o.start();
	const fresh = agents.at(-1)!;
	expect(fresh.sent).toHaveLength(1);
	expect(fresh.sent[0]!.text).toContain(msg().pendingAsksHead);
	expect(fresh.sent[0]!.text).toContain(long);
	await advance(4000);
	o.stop();
	await advance(1000);

	// A saved session on the same model: resumed, so the first prompt is not re-sent; the next owner message carries the block once.
	const session = join(DATA, "asks-orch-session.jsonl");
	writeFileSync(session, "{}\n");
	writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ sessionFile: session }));
	o.start();
	const resumed = agents.at(-1)!;
	expect(resumed.sent).toHaveLength(0);
	await advance(4000);
	o.deliver("hello");
	expect(resumed.sent.at(-1)!.text).toContain("hello");
	expect(resumed.sent.at(-1)!.text).toContain(long);
	o.deliver("again");
	expect(resumed.sent.at(-1)!.text).toBe("again");

	o.stop();
	await advance(1000);
	rmSync(join(DATA, "orchestrator.json"), { force: true });
	rmSync(join(lanesDir, "pa-orch"), { recursive: true, force: true });
});
