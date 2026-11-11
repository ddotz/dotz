// What runs now: the header line of an owner prompt and the `dotz_lane list` view of a lane's running task workers.
// Lanes run on a minimal fake runtime adapter (the same approach as claim.test.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
import { formatHeader, HEADER_MAX, kstClock, type RunningLane } from "./lanevis.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SubagentUpdate } from "./runtime/types.ts";
import type * as Lanes from "./lanes.ts";

const DATA = process.env.DOTZ_DIR!;
// The lane state is one shared module (lanestate.ts): reset it so the scenario test driving it in this process does not leak in.
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7300;
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = this.stream();
	private async *stream(): AsyncGenerator<AgentEvent> {
		while (true) {
			while (this.queue.length) yield this.queue.shift()!;
			await this.wake.promise;
			this.wake = Promise.withResolvers<void>();
		}
	}
	async push(...events: AgentEvent[]): Promise<void> {
		this.queue.push(...events);
		this.wake.resolve();
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

const idle = (name: string): RunningLane => ({ name, status: "idle", workers: [] });
const sub = (update: SubagentUpdate): AgentEvent => ({ type: "subagent", update });

test("header: nothing running adds no line", () => {
	expect(formatHeader([], [])).toBe("");
	expect(formatHeader([idle("a"), idle("b")], [])).toBe("");
});

test("header: lanes and the orchestrator's own workers on one line", () => {
	const line = formatHeader([{ name: "gateway-ui", status: "working", workers: ["omo-adapter", "pending-asks"] }, idle("docs")], ["scout"]);
	expect(line.startsWith(msg().nowRunning)).toBe(true);
	expect(line).toContain("gateway-ui");
	expect(line).toContain("omo-adapter,pending-asks");
	expect(line).toContain("scout");
	expect(line).not.toContain("docs");
	expect(line).not.toContain("\n");
	// A lane that works without workers is named too.
	expect(formatHeader([{ name: "solo", status: "working", workers: [] }], [])).toContain("solo");
});

test("header: stays within 200 characters with many lanes and workers", () => {
	const many = Array.from({ length: 12 }, (_, i) => ({ name: `lane-number-${i}`, status: "working", workers: Array.from({ length: 6 }, (_, j) => `a-rather-long-worker-name-${i}-${j}`) }));
	const line = formatHeader(many, Array.from({ length: 8 }, (_, i) => `orchestrator-scout-${i}`));
	expect(line.length).toBeLessThanOrEqual(HEADER_MAX);
	expect(line.startsWith(msg().nowRunning)).toBe(true);
	// Past the names it still says how much runs.
	expect(line).toContain("12");
	const huge = Array.from({ length: 400 }, (_, i) => ({ name: `l${i}`, status: "working", workers: ["w"] }));
	expect(formatHeader(huge, ["x"]).length).toBeLessThanOrEqual(HEADER_MAX);
});

test("lane view: a running worker with its last intent, gone after done; report time persists", async () => {
	const cwd = join(DATA, "lanevis-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "lv"), { recursive: true, force: true });
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
	l.launch("lv", cwd, "Build it.\nDone when: tests pass");
	const agent = agents.at(-1)!;
	await advance(3000);
	const view = () => l.laneList().find(x => x.name === "lv")!;

	expect(view().workers).toEqual([]);
	expect(view().last_report_at).toBeNull();
	expect(l.turnHeader()).toContain("lv");

	await agent.push({ type: "alive" }, { type: "turn_start" }, sub({ id: "OmoAdapter", agent: "task", description: "x".repeat(200), status: "running", intent: "pytest 돌리는 중" }));
	await advance(500);
	let workers = view().workers as Array<Record<string, string>>;
	expect(workers).toHaveLength(1);
	expect(workers[0]).toMatchObject({ name: "OmoAdapter", last_intent: "pytest 돌리는 중" });
	expect(workers[0].description.length).toBeLessThanOrEqual(80);
	expect(workers[0].started_kst).toMatch(/^\d\d:\d\d$/);
	expect(workers[0].started_kst).toBe(kstClock(workers[0].started_at));
	expect(Date.parse(workers[0].updated_at)).toBeGreaterThan(0);
	expect(l.turnHeader()).toContain("OmoAdapter");

	// The worker's later frames move the intent; a specific agent type names it.
	await agent.push(sub({ id: "OmoAdapter", agent: "scout", status: "running", intent: "diff 읽는 중" }));
	await advance(100);
	workers = view().workers as Array<Record<string, string>>;
	expect(workers[0]).toMatchObject({ name: "scout", last_intent: "diff 읽는 중" });

	// The turn ends with a report while the worker still runs: the lane stays listed as busy, last_report_at is set.
	await agent.push({ type: "assistant", text: "[run] working", stop: "stop" }, { type: "turn_end" });
	// The stream is read asynchronously: let it take the frames before the report timer is run.
	await flush();
	await advance(500);
	expect(view().last_report_at).toMatch(/^\d{4}-\d\d-\d\dT/);
	expect(view().last_report_kst).toMatch(/^\d\d:\d\d$/);
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "lv", "lane.json"), "utf8")).lastReportAt).toBe(view().last_report_at);
	expect((view().workers as unknown[]).length).toBe(1);
	expect(l.turnHeader()).toContain("scout");

	await agent.push(sub({ id: "OmoAdapter", status: "done" }));
	await advance(100);
	expect(view().workers).toEqual([]);
	expect(l.turnHeader()).toBe("");

	l.stopLane("lv");
	await advance(300);
});
