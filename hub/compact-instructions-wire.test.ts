import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { OmpProcess, omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const o: typeof Orchestrator = await import("./orchestrator.ts?compact-instructions");

class FrameProcess extends OmpProcess {
	frames: Record<string, unknown>[] = [];
	constructor() {
		super({ exited: new Promise<number>(() => {}), pid: 1 } as never, "o");
	}
	protected override write(frame: Record<string, unknown>): void {
		this.frames.push(frame);
	}
}

test("omp's compact frame carries the instruction as customInstructions, and stays bare without one", () => {
	const p = new FrameProcess();
	p.compact("keep it short");
	p.compact();
	expect(p.frames).toEqual([{ type: "compact", customInstructions: "keep it short" }, { type: "compact" }]);
});

class FakeAgent implements AgentProcess {
	pid = 7400;
	compactions: (string | undefined)[] = [];
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
	send(_text: string, _mode: SendMode): void {}
	setModel = () => {};
	abort = () => {};
	compact = (instructions?: string) => void this.compactions.push(instructions);
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

const savedCfg = { orchestrator: cfg.orchestrator };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

test("the orchestrator asks its runtime to compact with the summary instruction", async () => {
	const session = join(DATA, "compact-instructions-session.jsonl");
	writeFileSync(session, "{}\n");
	writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ sessionFile: session, runtime: "omp" }));
	o.start();
	const agent = started.at(-1)!;
	await advance(4000);
	await agent.push({ type: "session", ref: session });
	expect(o.orch.status).toBe("idle");
	o.compact();
	expect(agent.compactions).toHaveLength(1);
	const instructions = agent.compactions[0] ?? "";
	// The summary instruction itself (hub/compact-instructions.ts): present, short, and pointing at the record files.
	expect(instructions.length).toBeGreaterThan(0);
	expect(instructions.length).toBeLessThan(2000);
	for (const file of ["state.json", "inbox.jsonl", "outbox.jsonl", "tasks-closed.jsonl"]) expect(instructions).toContain(file);
	o.stop();
	await advance(1000);
	rmSync(join(DATA, "orchestrator.json"), { force: true });
});
