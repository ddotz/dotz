import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const o: typeof Orchestrator = await import("./orchestrator.ts?compact-size");

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
	setModel = () => {};
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
	caps: { steer: "native", subagents: "none", contextNumbers: "exact", compact: "rpc", sessionTranscript: false, promptCacheKeepalive: false, contextLimit: "compact" },
	start() {
		const agent = new FakeAgent();
		started.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
};

const THRESHOLD = 200_000;
const savedCfg = { orchestrator: cfg.orchestrator };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake", rotate_tokens: THRESHOLD };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

// One compaction that finished and the usage number the runtime reports right after it.
async function compactTo(left: number): Promise<number> {
	const session = join(DATA, "compact-size-session.jsonl");
	writeFileSync(session, "{}\n");
	writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ sessionFile: session, runtime: "omp" }));
	started.length = 0;
	o.start();
	const agent = started.at(-1)!;
	await advance(4000);
	await agent.push({ type: "session", ref: session });
	expect(o.orch.status).toBe("idle");
	o.compact();
	await agent.push({ type: "compaction", state: "done", tokensBefore: THRESHOLD + 10_000 }, { type: "usage", tokens: left, window: 1_000_000 });
	await advance(1000);
	const sessions = started.length;
	o.stop();
	await advance(1000);
	rmSync(join(DATA, "orchestrator.json"), { force: true });
	return sessions;
}

test("a compaction that leaves more than half the threshold hands over to a fresh session", async () => {
	expect(await compactTo(THRESHOLD / 2 + 1)).toBe(2);
});

test("a compaction that leaves up to half the threshold keeps the session", async () => {
	expect(await compactTo(THRESHOLD / 2)).toBe(1);
});
