// The quick chat's start: a lean first prompt (size is a number), the owner's first message riding the start turn instead of waiting
// behind a context-only turn, and the short coalesce wait. The orchestrator runs against a fake agent, as in orch-instances.test.ts.
// New exports are read through namespaces so a missing one fails its own test and not the whole file.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import * as budget from "./prompt-budget.ts";
import * as quick from "./quick-chat.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { recallText } from "./orchestrator-parts.ts";
import { createPrompts } from "./prompts.ts";
import { seedText } from "./convsessions.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const REPO = join(import.meta.dir, "..");
const mod: typeof Orchestrator = await import("./orchestrator.ts?quick-start");

class FakeAgent implements AgentProcess {
	static next = 8700;
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
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
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

let seq = 0;
function session(key: string, light: boolean, seeds: boolean[]) {
	const n = ++seq;
	const opts = { key, stateFile: join(DATA, `quick-start-${n}.json`), source: `conv:${key}:${n}`, keepalive: false, asks: false, env: { DOTZ_CONV: `${key}:${n}` }, scope: () => `scope of ${key}`, seed: (joined?: boolean) => (seeds.push(Boolean(joined)), "seed text"), light };
	return mod.createOrchestrator(opts as Parameters<typeof mod.createOrchestrator>[0]);
}
const agentOf = (o: ReturnType<typeof session>) => started.find(a => a.pid === o.orchestratorPid())!;

test("the quick chat's contract is cut to a size budget, in both shipped languages", () => {
	const quickMode = (quick as unknown as { quickMode: (mode: string) => string }).quickMode;
	const max = (budget as unknown as { QUICK_MODE_MAX_BYTES: number }).QUICK_MODE_MAX_BYTES;
	expect(typeof max).toBe("number");
	for (const file of ["MODE.md", "MODE.ko.md"]) {
		const full = readFileSync(join(REPO, file), "utf8");
		const lean = quickMode(full);
		expect(Buffer.byteLength(lean)).toBeLessThanOrEqual(max);
		expect(Buffer.byteLength(lean)).toBeLessThan(Buffer.byteLength(full) / 2);
		// What a light chat needs stays: the message layout it must follow and the gates it must ask at.
		for (const heading of ["## Mail and calendar", "## Message layout", "## Confirmation gates", "## Memory, rules, lessons"]) expect(lean).toContain(heading);
		// What only launches sessions or runs the orchestrator's own machinery goes.
		for (const heading of ["## Sessions and subagents", "## Routing", "## Monitoring", "## State", "## Reporting"]) expect(lean).not.toContain(heading);
	}
});

test("the lean start prompt leaves out the channel setups and state.json, and keeps identity, rules and the scope", () => {
	const full = recallText("the scope", "");
	const lean = (recallText as unknown as (scope: string, ledger: string, light: boolean) => string)("the scope", "", true);
	expect(lean.length).toBeLessThan(full.length);
	expect(lean).toContain("the scope");
	expect(lean).toContain(DATA); // the owner rules / memory paths it must read
	for (const marker of ["Current state.json:", "현재 state.json:", "Work channel setups", "작업 채널 설정"]) expect(lean).not.toContain(marker);
	expect(full).toContain("Current state.json:");
});

test("a fresh light session started by the owner's message answers it in the start turn, with no context-only turn first", async () => {
	const seeds: boolean[] = [];
	const o = session("quick", true, seeds);
	o.deliver("[dotz inbox] web:quick hello", true);
	const a = agentOf(o);
	expect(a.sent.map(s => s.mode)).toEqual(["prompt", "steer", "steer"]);
	expect(a.sent[2]!.text).toContain("hello");
	expect(seeds).toEqual([true]);
	await a.push({ type: "session", ref: join(DATA, "quick-start-ref-1.jsonl") }, { type: "turn_start" });
	expect(o.heldCount()).toBe(0);
	o.stop();
	await advance(1000);
});

test("a light session started with no message to carry still gets the context-only seed", async () => {
	const seeds: boolean[] = [];
	const o = session("quick", true, seeds);
	o.start();
	expect(agentOf(o).sent.map(s => s.mode)).toEqual(["prompt", "steer"]);
	expect(seeds).toEqual([false]);
	o.stop();
	await advance(1000);
});

test("other conversation sessions keep the old order: the owner's message is its own turn after the start", async () => {
	const seeds: boolean[] = [];
	const o = session("mail:a", false, seeds);
	o.deliver("[dotz inbox] mail:a hello", true);
	expect(agentOf(o).sent.map(s => s.mode)).toEqual(["prompt", "steer", "followUp"]);
	expect(seeds).toEqual([false]);
	o.stop();
	await advance(1000);
});

test("a second message to a running light session is not steered into the start turn", async () => {
	const seeds: boolean[] = [];
	const o = session("quick", true, seeds);
	o.deliver("[dotz inbox] web:quick one", true);
	const a = agentOf(o);
	await a.push({ type: "session", ref: join(DATA, "quick-start-ref-2.jsonl") }, { type: "turn_start" }, { type: "turn_end" });
	o.deliver("[dotz inbox] web:quick two", true);
	expect(a.sent.at(-1)!.mode).toBe("followUp");
	o.stop();
	await advance(1000);
});

test("the seed tells the model the message comes in the same turn only when it does", () => {
	const events = [{ kind: "message", text: "earlier", ts: "2026-11-13T00:00:00Z" }] as Parameters<typeof seedText>[1];
	const sameTurn = (seedText as unknown as (p: string, e: typeof events, max: number, joined: boolean) => string)("web:quick", events, 6000, true);
	const apart = seedText("web:quick", events);
	expect(sameTurn).not.toBe(apart);
	expect(apart).toContain("reply with exactly -");
	expect(sameTurn).not.toContain("reply with exactly -");
});

test("the quick chat waits less than the default before it starts a turn, and no other target does", () => {
	const coalesceFor = (quick as unknown as { coalesceFor: (target: string, base: number) => number }).coalesceFor;
	const wait = (quick as unknown as { QUICK_COALESCE_MS: number }).QUICK_COALESCE_MS;
	expect(wait).toBeLessThan(2000);
	expect(coalesceFor("web:quick", 2000)).toBe(wait);
	expect(coalesceFor("web:quick", 300)).toBe(300); // an owner who set less keeps it
	expect(coalesceFor("web:quick", 0)).toBe(0); // and 0 stays off
	for (const target of ["web", "web:alert", "web:worklog", "mail:acme-1", "ch:1", "terminal"]) expect(coalesceFor(target, 2000)).toBe(2000);
});

test("the answer of a start turn that carried the owner's message is posted for that message and closes its request", async () => {
	const posts: { target: string; text: string; replyTo?: string }[] = [];
	const saved: unknown[][] = [];
	const o = session("quick", true, []);
	const q = createPrompts({
		deliver: text => o.deliver(text, true),
		steer: o.steer,
		working: () => o.orch.status === "working",
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: async (target, text, replyTo) => (posts.push({ target, text, replyTo }), { delivered: true }),
		clearProgress: () => {},
		persist: open => void saved.push(open),
		log: () => {},
		home: "web:quick",
		answered: [],
		recent: () => [],
	});
	o.setAnswerHandlers(q.onPrompt, q.onAnswer, q.onText);
	o.setIdleHandler(() => q.settleTurn(o.turnFailed()));
	const text = "[dotz inbox] web:quick msg=m1 hello";
	q.deliver(text, { target: "web:quick", replyTo: "m1", owner: true });
	const a = agentOf(o);
	expect(a.sent.map(m => m.mode)).toEqual(["prompt", "steer", "steer"]);
	// The frames the runtime emits for one start turn (a real run: start prompt, seed, then the answer; the message is the steer's third user row).
	await a.push(
		{ type: "session", ref: join(DATA, "quick-start-ref-pair.jsonl") },
		{ type: "turn_start" },
		...a.sent.map(m => ({ type: "user", text: m.text }) as AgentEvent),
		{ type: "assistant", text: "hi there", stop: "stop" } as AgentEvent,
		{ type: "turn_end" },
	);
	expect(posts).toEqual([{ target: "web:quick", text: "hi there", replyTo: "m1" }]);
	expect(saved.at(-1)).toEqual([]);
	expect(a.sent.map(m => m.mode)).toEqual(["prompt", "steer", "steer"]);
	o.stop();
	await advance(1000);
});
