import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, paths } from "./config.ts";
import { abortAhead, compactDue, newCtx, noteEvent, REST_FRACTION, REST_QUIET_MS, requestAhead, requestCompact, restDue, restGuard } from "./context.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { omo } from "./runtime/omo.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode } from "./runtime/types.ts";

const AT = 300_000;
const calm = { busy: false, quietMs: REST_QUIET_MS };

test("at rest past the lower point a compaction is due; below it, too soon, or at the normal point it is not", () => {
	const c = newCtx();
	c.tokens = AT * REST_FRACTION;
	expect(restDue(c, AT, calm)).toBe(true);
	c.tokens -= 1;
	expect(restDue(c, AT, calm)).toBe(false);
	c.tokens = AT * REST_FRACTION;
	expect(restDue(c, AT, { busy: false, quietMs: REST_QUIET_MS - 1 })).toBe(false);
	expect(restDue(c, AT, { busy: true, quietMs: REST_QUIET_MS })).toBe(false);
	c.tokens = AT;
	expect(restDue(c, AT, calm)).toBe(false);
	expect(compactDue(c, AT)).toBe(true);
});

test("a compaction already queued, running or failed is not started again at rest", () => {
	for (const state of ["queued", "compacting", "error"] as const) {
		const c = newCtx();
		c.tokens = AT * REST_FRACTION;
		c.compaction = { state };
		expect(restDue(c, AT, calm)).toBe(false);
	}
});

test("an ahead-of-time compaction needs a process that is idle and can abort", () => {
	const calls: string[] = [];
	const port = { idle: () => true, compact: () => calls.push("compact"), refreshUsage: () => {}, abort: () => calls.push("abort") };
	const c = newCtx();
	expect(requestAhead(c, { ...port, abort: undefined }, "orch", "at rest")).toBe(false);
	expect(requestAhead(c, { ...port, idle: () => false }, "orch", "at rest")).toBe(false);
	expect(calls).toEqual([]);
	expect(requestAhead(c, port, "orch", "at rest")).toBe(true);
	expect(c.compaction.state).toBe("compacting");
	expect(calls).toEqual(["compact"]);
});

test("an owner message aborts an ahead-of-time compaction once; the abort ends without a failure", () => {
	const calls: string[] = [];
	const port = { idle: () => true, compact: () => {}, refreshUsage: () => {}, abort: () => calls.push("abort") };
	const c = newCtx();
	requestAhead(c, port, "orch", "at rest");
	expect(abortAhead(c, port)).toBe(true);
	expect(abortAhead(c, port)).toBe(false);
	expect(calls).toEqual(["abort"]);
	noteEvent(c, { type: "compaction", state: "error", error: "Compaction cancelled", requested: true }, port);
	expect(c.compaction).toEqual({});
	expect(c.ahead).toBeUndefined();
});

test("the normal compaction is never aborted, and it still runs from the normal point", () => {
	const calls: string[] = [];
	const port = { idle: () => true, compact: () => calls.push("compact"), refreshUsage: () => {}, abort: () => calls.push("abort") };
	const c = newCtx();
	c.tokens = AT;
	requestCompact(c, port);
	expect(abortAhead(c, port)).toBe(false);
	expect(calls).toEqual(["compact"]);
});

test("only OmO is asked to compact ahead of time: it is the engine whose compaction was shown to abort cleanly", () => {
	expect(omo.caps.abortCompact).toBe(true);
	expect(omp.caps.abortCompact).toBeUndefined();
});

const DATA = process.env.DOTZ_DIR!;
const o: typeof Orchestrator = await import("./orchestrator.ts?rest-compact");

class FakeAgent implements AgentProcess {
	pid = 7400;
	sent: { text: string; mode: SendMode }[] = [];
	compacts = 0;
	aborts = 0;
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
	setModel = () => {};
	abort = () => {};
	abortCompaction = () => void this.aborts++;
	compact = () => void this.compacts++;
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}

const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "exact", compact: "rpc", sessionTranscript: false, promptCacheKeepalive: false, contextLimit: "compact", abortCompact: true },
	start() {
		const agent = new FakeAgent();
		started.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
};

const savedCfg = { orchestrator: cfg.orchestrator };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake", rotate_tokens: AT };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

// A started orchestrator whose context holds `tokens`, `quietMin` minutes after its last turn.
async function atRest(tokens: number, quietMin: number): Promise<FakeAgent> {
	const session = join(DATA, "rest-compact-session.jsonl");
	writeFileSync(session, "{}\n");
	writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ sessionFile: session, runtime: "omp" }));
	started.length = 0;
	restGuard.blocked = () => false;
	o.start();
	const agent = started.at(-1)!;
	await advance(4000);
	await agent.push({ type: "session", ref: session }, { type: "usage", tokens, window: 1_000_000 });
	expect(o.orch.status).toBe("idle");
	await advance(quietMin * 60_000);
	return agent;
}
async function finish(): Promise<void> {
	o.stop();
	await advance(1000);
	rmSync(join(DATA, "orchestrator.json"), { force: true });
}

test("the orchestrator starts a compaction only after the quiet period, once, and logs it", async () => {
	const agent = await atRest(AT * REST_FRACTION + 1000, 9);
	expect(agent.compacts).toBe(0);
	await advance(2 * 60_000);
	expect(agent.compacts).toBe(1);
	await advance(5 * 60_000);
	expect(agent.compacts).toBe(1);
	await agent.push({ type: "compaction", state: "done", tokensBefore: AT * REST_FRACTION + 1000 }, { type: "usage", tokens: 95_000, window: 1_000_000 });
	expect(readFileSync(paths.log, "utf8")).toMatch(/ahead-of-time compaction done: 181000 tokens before, at rest for \d+ min, \d+ s/);
	await finish();
});

test("the orchestrator leaves a context under the lower point alone", async () => {
	const low = await atRest(AT * REST_FRACTION - 1000, 30);
	expect(low.compacts).toBe(0);
	await finish();
});

test("the orchestrator waits while a prompt is queued or deferred", async () => {
	const agent = await atRest(AT * REST_FRACTION + 1000, 0);
	restGuard.blocked = () => true;
	await advance(20 * 60_000);
	expect(agent.compacts).toBe(0);
	restGuard.blocked = () => false;
	await advance(60_000);
	expect(agent.compacts).toBe(1);
	await finish();
});

test("an owner message during an ahead-of-time compaction aborts it and is delivered at once, without a fresh session", async () => {
	const agent = await atRest(AT * REST_FRACTION + 1000, 11);
	expect(agent.compacts).toBe(1);
	o.deliver("hello", true);
	expect(agent.aborts).toBe(1);
	expect(agent.sent).toEqual([]);
	await agent.push({ type: "compaction", state: "error", error: "Compaction cancelled", requested: true });
	expect(agent.sent.map(s => s.text.includes("hello"))).toEqual([true]);
	expect(o.orch.ctx.compaction).toEqual({});
	expect(started.length).toBe(1);
	expect(readFileSync(paths.log, "utf8")).toMatch(/ahead-of-time compaction aborted: 181000 tokens before/);
	await finish();
});
