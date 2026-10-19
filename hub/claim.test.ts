// A lane's [done] report is only a claim ("reported"); the orchestrator's verify makes it "verified"; the next report that
// is not [done] withdraws it. Lanes run on a minimal fake runtime adapter (the same approach as runtime/fake-adapter.test.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
// A separate lanes.ts instance (the query makes a new module): the scenario test drives the original in this same process
// and must not inherit its state; a static import cannot do that.
const l: typeof Lanes = await import("./lanes.ts?claim");

class FakeAgent implements AgentProcess {
	pid = 7100;
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
	recentExchanges: () => undefined,
};

const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	adapters.fake = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

// One lane turn ending with `text` as its final message (the report).
async function turn(agent: FakeAgent, text: string): Promise<void> {
	await agent.push({ type: "alive" }, { type: "turn_start" }, { type: "assistant", text, stop: "stop" }, { type: "turn_end" });
	await advance(500);
}
const saved = () => JSON.parse(readFileSync(join(DATA, "lanes", "cl", "lane.json"), "utf8")).claim;

test("claim: [done] reports, verify only from reported, any other report clears it", async () => {
	const cwd = join(DATA, "claim-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "cl"), { recursive: true, force: true });
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
	const lane = l.launch("cl", cwd, "Build it.\nDone when: tests pass");
	const agent = agents.at(-1)!;
	await advance(3000);

	// A progress-style report is no claim, so there is nothing to verify.
	await turn(agent, "still working on it");
	expect(lane.claim).toBeUndefined();
	expect(() => l.verifyLane("cl", "ran the tests")).toThrow("no reported-done claim");
	expect(l.claimPrefix("cl")).toBe("");

	await turn(agent, "[done] all green");
	expect(lane.claim).toMatchObject({ state: "reported" });
	expect(saved()).toMatchObject({ state: "reported" });
	expect(l.claimPrefix("cl")).toBe("reported · ");

	expect(() => l.verifyLane("cl", "  ")).toThrow("needs evidence");
	expect(lane.claim?.state).toBe("reported");
	l.verifyLane("cl", "bun test: 12 pass, 0 fail");
	expect(lane.claim).toMatchObject({ state: "verified", evidence: "bun test: 12 pass, 0 fail" });
	expect(saved()).toMatchObject({ state: "verified", evidence: "bun test: 12 pass, 0 fail" });
	expect(l.claimPrefix("cl")).toBe("verified · ");
	// Verified is final until the lane reports again.
	expect(() => l.verifyLane("cl", "again")).toThrow("already verified");

	await turn(agent, "[done] one more change");
	expect(lane.claim?.state).toBe("reported");
	// New work sent to the lane withdraws an unchecked claim.
	l.sendToLane("cl", "also fix the README");
	expect(lane.claim).toBeUndefined();
	await turn(agent, "[done] README fixed");
	expect(lane.claim?.state).toBe("reported");
	await turn(agent, "[ask] which branch?");
	expect(lane.claim).toBeUndefined();
	expect(saved()).toBeUndefined();
	expect(() => l.verifyLane("nope", "x")).toThrow("no lane nope");

	l.sendToLane("cl", "main, please"); // answers the pending [ask], so it does not leak into other tests' pending-ask blocks
	l.stopLane("cl");
	await advance(300);
});
