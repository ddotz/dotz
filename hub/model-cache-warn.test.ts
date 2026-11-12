// A model change on the orchestrator or on a conversation session asks first when it would rewrite a live prompt cache, as a running lane
// does: refused with requires_force and the context tokens, applied with force. Nothing asks without a live process, with a small
// context, or for an effort change the runtime sends as a per-message marker. Fake agents stand in for the runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, orchestratorModel, selectorOf } from "./config.ts";
import { ForceRequired, setModel, targetView } from "./control.ts";
import { convs } from "./convsessions.ts";
import { start, stop } from "./orchestrator.ts";
import "./outbound.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const SONNET = "anthropic/claude-sonnet-5-5", OPUS = "anthropic/claude-opus-5-5", FABLE = "anthropic/claude-fable-5-2";
const BIG = 189_760;

class FakeAgent implements AgentProcess {
	pid = 7400 + started.length;
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
	send = () => {};
	setModel = () => {};
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}

const started: FakeAgent[] = [];
const fake = (id: string): RuntimeAdapter => ({
	id,
	caps: { steer: "native", subagents: "none", contextNumbers: "exact", compact: "rpc", sessionTranscript: false, promptCacheKeepalive: false },
	start() {
		const agent = new FakeAgent();
		started.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
});

const savedCfg = { orchestrator: cfg.orchestrator, models: cfg.models };
beforeAll(() => {
	adapters.fake_omo = fake("omo");
	adapters.fake_omp = fake("omp");
});
afterAll(() => {
	delete adapters.fake_omo;
	delete adapters.fake_omp;
	Object.assign(cfg, savedCfg);
});
const runOn = (key: "fake_omo" | "fake_omp") => void (cfg.orchestrator = { ...savedCfg.orchestrator, runtime: key });

type Proc = { start: () => void; stop: () => void };
const CONV = "ch:7401";
const targets: { name: string; key: string; proc: () => Proc }[] = [
	{ name: "the orchestrator", key: "orchestrator", proc: () => ({ start, stop }) },
	{ name: "a conversation session", key: CONV, proc: () => convs.get(CONV)!.o },
];

// Starts the target's process on a fake agent whose context holds `tokens`.
async function runWith(proc: Proc, tokens: number): Promise<FakeAgent> {
	const session = join(DATA, `cache-warn-${started.length}.jsonl`);
	writeFileSync(session, "{}\n");
	proc.start();
	const agent = started.at(-1)!;
	await advance(4000);
	await agent.push({ type: "session", ref: session }, { type: "usage", tokens });
	return agent;
}
async function endRun(proc: Proc): Promise<void> {
	proc.stop();
	await advance(1000);
	rmSync(join(DATA, "orchestrator.json"), { force: true });
}

for (const t of targets) {
	describe(t.name, () => {
		beforeEach(async () => {
			runOn("fake_omo");
			cfg.models = { ...savedCfg.models, orchestrator: { model: SONNET, thinking: "high" } };
			if (t.key !== "orchestrator") await setModel(t.key, SONNET, "high"); // a conversation keeps its own pick
		});
		const modelOf = async () => ((await targetView(t.key === "orchestrator" ? "main" : t.key)) as { model: string }).model;

		test("a live process with a large context refuses a model change until forced", async () => {
			const proc = t.proc();
			await runWith(proc, BIG);
			try {
				const refused = await setModel(t.key, OPUS).then(() => undefined, (e: unknown) => e);
				expect(refused).toBeInstanceOf(ForceRequired);
				expect(refused).toMatchObject({ status: 409, contextTokens: BIG });
				expect(await modelOf()).toBe(SONNET);
				await setModel(t.key, OPUS, undefined, true);
				expect(await modelOf()).toBe(OPUS);
			} finally {
				await endRun(proc);
			}
		});

		test("an effort change that OmO sends per message keeps the cache and applies without force", async () => {
			const proc = t.proc();
			await runWith(proc, BIG);
			try {
				await setModel(t.key, undefined, "low");
				expect(await modelOf()).toBe(SONNET);
				expect(((await targetView(t.key === "orchestrator" ? "main" : t.key)) as { thinking: string }).thinking).toBe("low");
			} finally {
				await endRun(proc);
			}
		});

		test("an effort change the runtime cannot send per message asks until forced", async () => {
			runOn("fake_omp");
			const proc = t.proc();
			await runWith(proc, BIG);
			try {
				const refused = await setModel(t.key, undefined, "low").then(() => undefined, (e: unknown) => e);
				expect(refused).toBeInstanceOf(ForceRequired);
				expect(refused).toMatchObject({ contextTokens: BIG });
			} finally {
				await endRun(proc);
			}
		});

		test("a context too small to be worth a warning applies without force", async () => {
			const proc = t.proc();
			await runWith(proc, 2_000);
			try {
				await setModel(t.key, FABLE);
				expect(await modelOf()).toBe(FABLE);
			} finally {
				await endRun(proc);
			}
		});

		test("with no live process the change applies without force", async () => {
			await setModel(t.key, OPUS);
			expect(await modelOf()).toBe(OPUS);
		});
	});
}
