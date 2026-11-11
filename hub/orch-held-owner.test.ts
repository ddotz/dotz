// While a compaction runs nothing is steered into the process; the prompts held meanwhile go in with the owner's messages first,
// in arrival order.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cfg } from "./config.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode } from "./runtime/types.ts";

const mod: typeof Orchestrator = await import("./orchestrator.ts?ownerheld");

class FakeAgent implements AgentProcess {
	static next = 9400;
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
async function session() {
	const o = mod.createOrchestrator({ key: "main", stateFile: join(process.env.DOTZ_DIR!, `held-owner-${++seq}.json`), source: `held-owner:${seq}`, keepalive: false });
	o.deliver("first", true);
	const agent = started.at(-1)!;
	await agent.push({ type: "session", ref: join(process.env.DOTZ_DIR!, `held-owner-${seq}.jsonl`) }, { type: "turn_start" });
	return { o, agent };
}

test("a steer is refused while a compaction runs, so the owner's message is held as the next prompt", async () => {
	const { o, agent } = await session();
	o.orch.ctx.compaction.state = "compacting";
	expect(o.steer("[note] owner message")).toBe(false);
	expect(agent.sent.filter(m => m.mode === "steer")).toEqual([]);
	o.orch.ctx.compaction.state = "idle";
	expect(o.steer("[note] owner message")).toBe(true);
	expect(agent.sent.at(-1)?.mode).toBe("steer");
	expect(agent.sent.at(-1)?.text).toStartWith("[note] owner message\n[dotz-steer:");
	o.stop();
	await flush();
});

test("after a compaction the held owner messages go in first, in arrival order, ahead of held reports", async () => {
	const { o, agent } = await session();
	await agent.push({ type: "turn_end" });
	o.orch.ctx.compaction.state = "compacting";
	const before = agent.sent.length;
	o.deliver("[report] lane one is done");
	o.deliver("owner message A", true);
	o.deliver("[report] lane two is done");
	o.deliver("owner message B", true);
	expect(agent.sent.length).toBe(before);
	o.orch.ctx.compaction.state = "idle";
	await agent.push({ type: "compaction", state: "done" });
	expect(agent.sent.slice(before).map(m => m.text.split("\n")[0])).toEqual(["owner message A", "owner message B", "[report] lane one is done", "[report] lane two is done"]);
	o.stop();
	await flush();
});
