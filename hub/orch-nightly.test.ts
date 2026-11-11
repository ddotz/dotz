// The nightly fresh start through the real orchestrator and the real prompt queue: the new session's first prompts carry the open requests and the
// last compaction summary, a worker result after the start still answers its message, an owner message during the start is held and delivered.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { REST_QUIET_MS } from "./context.ts";
import { createLedger } from "./open-ledger.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { createPrompts } from "./prompts.ts";
import { ledgerIn, loadLedger } from "./recall-parts.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode } from "./runtime/types.ts";
import { clearTrackedTimers } from "./shutdown.ts";

const mod: typeof Orchestrator = await import("./orchestrator.ts?nightly");

class FakeAgent implements AgentProcess {
	static next = 9600;
	pid = FakeAgent.next++;
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

const SUMMARY = "SUMMARY-OF-THE-LAST-COMPACTION";
const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start: () => {
		const agent = new FakeAgent();
		started.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "IN: before\n\nYOU: after",
	lastCompactionSummary: () => SUMMARY,
};

const savedCfg = { orchestrator: cfg.orchestrator };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
});
afterEach(() => {
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake", nightly_fresh: undefined };
	clearTrackedTimers();
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

const inbox = (id: string, words: string) => `[dotz inbox] web msg=${id} from owner\n${words}`;
let seq = 0;
const dirs: string[] = [];
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "orch-nightly-"));
	dirs.push(dir);
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "{}\n");
	const o = mod.createOrchestrator({ key: "main", stateFile: join(dir, "orch.json"), source: `nightly:${++seq}`, keepalive: false });
	const posts: [string, string, string | undefined][] = [];
	const settling: Promise<unknown>[] = [];
	const ledger = createLedger(ledgerIn(dir), { isAnswered: id => q.isAnswered(id), write: (f, t) => writeFileSync(f, t), log: () => {} });
	const q: ReturnType<typeof createPrompts> = createPrompts({
		deliver: (text, owner) => o.deliver(text, owner),
		steer: text => o.steer(text),
		working: () => o.orch.status === "working",
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: (target, text, replyTo) => {
			posts.push([target, text, replyTo]);
			const sent = Promise.resolve({ delivered: true });
			settling.push(sent);
			return sent;
		},
		clearProgress: () => {},
		persist: open => ledger.sync(open, q.openRequests()),
		interim: target => ledger.interim(target),
		log: () => {},
		answered: [],
		recent: () => [],
	});
	o.setAnswerHandlers(q.onPrompt, q.onAnswer, q.onText);
	o.setWorkerHandlers(q.workersSpawned, q.workersDone, q.workersSteered);
	const agent = () => started.at(-1)!;
	const turn = async (...events: AgentEvent[]) => agent().push({ type: "session", ref: sessionFile }, { type: "turn_start" }, ...events, { type: "turn_end" });
	const quiet = () => advance(REST_QUIET_MS + 1000);
	return { dir, o, q, posts, settling, agent, turn, quiet, ledger: () => loadLedger(ledgerIn(dir)) };
}

/** The owner asks for something that a worker will do: the answer is deferred and the request stays open in the ledger. */
async function deferred(s: Awaited<ReturnType<typeof setup>>, id: string): Promise<void> {
	s.q.deliver(inbox(id, "옮겨 줘"), { target: "web", replyTo: id });
	const text = s.agent().sent.findLast(m => m.text.includes(`msg=${id}`))!.text;
	await s.turn({ type: "user", text }, { type: "workers_spawned", workers: [{ id: "st_move" }] }, { type: "assistant", text: "나중에 알려드릴게요\n\n[later]", stop: "stop" });
	expect(s.ledger().map(e => [e.id, e.state])).toEqual([[id, "deferred"]]);
}

test("a nightly start carries the deferred request into the first prompt, and the worker's result afterwards answers that message", async () => {
	const s = await setup();
	await deferred(s, "m-7f3a");
	const old = s.agent();
	await s.quiet();
	expect(s.o.nightlyHandover(50e6)).toBeDefined();
	await flush();
	const fresh = s.agent();
	expect(fresh).not.toBe(old);
	expect(fresh.sent[0]!.mode).toBe("prompt");
	expect(fresh.sent[0]!.text).toContain("m-7f3a");
	expect(fresh.sent.some(m => m.mode === "steer" && m.text.includes(SUMMARY))).toBe(true);

	await fresh.push({ type: "session", ref: join(s.dir, "session.jsonl") }, { type: "turn_start" }, { type: "workers_done", ids: ["st_move"] }, { type: "assistant", text: "다 옮겼어요", stop: "stop" }, { type: "turn_end" });
	await Promise.all(s.settling);
	expect(s.posts).toEqual([["web", "다 옮겼어요", "m-7f3a"]]);
	expect(s.ledger()).toEqual([]);
	s.o.stop();
	await flush();
});

test("an owner message that arrives while the session is being replaced is held and reaches the new session, not the old one", async () => {
	const s = await setup();
	s.o.deliver("first", true);
	await s.turn();
	const old = s.agent();
	await s.quiet();
	expect(s.o.nightlyHandover(50e6)).toBeDefined();
	s.q.deliver(inbox("m-9b2e", "급한 일"), { target: "web", replyTo: "m-9b2e" });
	expect(s.o.heldCount()).toBe(1);
	await flush();
	const fresh = s.agent();
	expect(fresh).not.toBe(old);
	expect(old.sent.filter(m => m.text.includes("msg=m-9b2e"))).toEqual([]);
	expect(fresh.sent.filter(m => m.text.includes("msg=m-9b2e"))).toHaveLength(1);
	s.o.stop();
	await flush();
});

test("a night that starts while a turn runs waits, then replaces the session on the first tick after the turn has been quiet long enough", async () => {
	const s = await setup();
	s.q.deliver(inbox("m-1c5d", "작업 중"), { target: "web", replyTo: "m-1c5d" });
	const old = s.agent();
	await old.push({ type: "session", ref: join(s.dir, "session.jsonl") }, { type: "turn_start" });
	expect(s.o.nightlyHandover(50e6)).toBeUndefined();
	await advance(30 * 60_000);
	expect(s.agent()).toBe(old);
	await old.push({ type: "turn_end" });
	await advance(REST_QUIET_MS - 60_000);
	expect(s.agent()).toBe(old);
	await advance(2 * 60_000);
	expect(s.agent()).not.toBe(old);
	s.o.stop();
	await flush();
});

test("with orchestrator.nightly_fresh off only a file past the limit starts a fresh session; the default starts one whatever the size", async () => {
	const s = await setup();
	s.o.deliver("first", true);
	await s.turn();
	await s.quiet();
	const first = s.agent();
	cfg.orchestrator = { ...cfg.orchestrator, nightly_fresh: false };
	expect(s.o.nightlyHandover(50e6)).toBeUndefined();
	await flush();
	expect(s.agent()).toBe(first);
	expect(s.o.nightlyHandover(1)).toBeDefined();
	await flush();
	const second = s.agent();
	expect(second).not.toBe(first);

	cfg.orchestrator = { ...cfg.orchestrator, nightly_fresh: undefined };
	await s.turn();
	await s.quiet();
	expect(s.o.nightlyHandover(50e6)).toBeDefined();
	await flush();
	expect(s.agent()).not.toBe(second);
	s.o.stop();
	await flush();
});
