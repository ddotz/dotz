// While a compaction runs nothing is steered into the process; the prompts held meanwhile go in with the owner's messages first,
// in arrival order.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, orchestratorModel } from "./config.ts";
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

// A deep owner message (hub/ultrathink.ts) is marked where the session takes it, so a prompt held for a compaction keeps its line.
async function releasedAfterCompaction(...asks: [text: string, deep: boolean][]): Promise<string[]> {
	const { o, agent } = await session();
	await agent.push({ type: "turn_end" });
	o.orch.ctx.compaction.state = "compacting";
	const before = agent.sent.length;
	for (const [text, deep] of asks) o.deliver(text, true, deep);
	expect(agent.sent.length).toBe(before);
	o.orch.ctx.compaction.state = "idle";
	await agent.push({ type: "compaction", state: "done" });
	const out = agent.sent.slice(before).map(m => m.text);
	o.stop();
	await flush();
	return out;
}

test("a deep message held for a compaction goes in with the plain hint line on a runtime that is not OmO; a normal one grows by nothing", async () => {
	const [deep, plain] = await releasedAfterCompaction(["deep question", true], ["plain question", false]);
	expect(deep).toContain("deep question\n\nThe owner asked for deeper reasoning on this turn.");
	expect(deep).not.toContain("[dotz deep turn]");
	expect(plain).not.toContain("deeper reasoning");
});

test("a deep message held for a compaction goes in with the raise line on OmO's configured model", async () => {
	const dir = mkdtempSync(join(tmpdir(), "held-deep-"));
	const id = orchestratorModel().model.split("/").pop()!;
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id, compat: { supportsMidConvoEffort: true } }] } } }));
	const savedDir = process.env.OMO_CODING_AGENT_DIR;
	process.env.OMO_CODING_AGENT_DIR = dir;
	adapters.fakeomo = { ...fake, id: "omo" };
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fakeomo" };
	try {
		const [deep] = await releasedAfterCompaction(["deep question", true]);
		expect(deep).toContain("deep question\n\n[dotz deep turn] ");
		expect(deep!.match(/\[dotz deep turn\]/g)).toHaveLength(1);
	} finally {
		cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
		delete adapters.fakeomo;
		if (savedDir === undefined) delete process.env.OMO_CODING_AGENT_DIR;
		else process.env.OMO_CODING_AGENT_DIR = savedDir;
	}
});
