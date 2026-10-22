// A model/effort change made while the orchestrator compacts waits for the compaction's end: a set_model sent in the
// middle cancels the compaction, and the session is then rotated to a fresh one with a handover (2026-10-22 11:12 KST).
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
// Own copy of the stateful module (the query makes a new instance).
const o: typeof Orchestrator = await import("./orchestrator.ts?model-compact");

class FakeAgent implements AgentProcess {
	pid = 7200;
	sent: { text: string; mode: SendMode }[] = [];
	models: string[] = [];
	compactions = 0;
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
	abort = () => {};
	compact = () => void this.compactions++;
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}

const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start() {
		const agent = new FakeAgent();
		started.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
};

const savedCfg = { orchestrator: cfg.orchestrator, models: cfg.models };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

test("a model/effort change during a compaction is sent once, after the compaction ends", async () => {
	const session = join(DATA, "model-compact-session.jsonl");
	writeFileSync(session, "{}\n");
	writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ sessionFile: session, runtime: "omp" }));
	cfg.models = { ...savedCfg.models, orchestrator: { model: "anthropic/test-orch", thinking: "low" } };
	o.start();
	const agent = started.at(-1)!;
	await advance(4000);
	await agent.push({ type: "session", ref: session });
	expect(o.orch.status).toBe("idle");

	o.compact();
	expect(agent.compactions).toBe(1);
	expect(o.orch.ctx.compaction.state).toBe("compacting");

	cfg.models = { ...savedCfg.models, orchestrator: { model: "anthropic/test-orch", thinking: "high" } };
	expect(o.applyModelChange()).toBe("next-start");
	expect(agent.models).toEqual([]); // nothing is sent while the compaction runs

	await agent.push({ type: "compaction", state: "done", tokensBefore: 5000 });
	expect(agent.models).toEqual(["anthropic/test-orch:high"]);
	expect(started).toHaveLength(1); // switched in place: no restart, no new session

	await agent.push({ type: "turn_start" }, { type: "turn_end" });
	expect(agent.models).toHaveLength(1); // once

	o.stop();
	await advance(1000);
	rmSync(join(DATA, "orchestrator.json"), { force: true });
});
