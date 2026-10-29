import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as l from "./lanes.ts";
import { cfg } from "./config.ts";
import { activeCount } from "./lanelimits.ts";
import { QUEUE_TELL_MS } from "./laneops.ts";
import { setMachineProbe } from "./limits.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;

class FakeAgent implements AgentProcess {
	pid = 7500;
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (): AsyncGenerator<AgentEvent> {})();
	send = () => {};
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}
const spawns: SpawnOpts[] = [];
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(opts) {
		spawns.push(opts);
		return new FakeAgent();
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};
const rich = () => ({ totalGb: 64, availableGb: 56, cpus: 16 });
const tight = () => ({ totalGb: 48, availableGb: 5.2, cpus: 12 });
const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fakeomo;
	Object.assign(cfg, savedCfg);
	setMachineProbe(rich);
});

const launch = (name: string) => {
	const cwd = join(DATA, "queue-work");
	mkdirSync(cwd, { recursive: true });
	return l.launch(name, cwd, "Polish the theme.\nDone when: owner approves");
};

test("short on memory a launch waits with its reason in the lane summary and /api/state capacity, then starts by itself when memory frees up", async () => {
	setMachineProbe(tight);
	const first = launch("q-first");
	expect(first.waiting).toBeUndefined();
	expect(first.proc).toBeDefined();
	const before = spawns.length;
	const second = launch("q-second");
	expect(second.waiting).toBe("메모리 여유가 없어 대기 중");
	expect(second.proc).toBeUndefined();
	expect(spawns.length).toBe(before);
	expect(l.laneSummary().find(s => s.name === "q-second")).toMatchObject({ status: "starting", waiting: "메모리 여유가 없어 대기 중" });
	expect(l.laneCapacity()).toMatchObject({ waiting: 1, wait_reason: "메모리 여유가 없어 대기 중" });
	expect(() => l.sendToLane("q-second", "hello")).toThrow("queued");
	expect(l.startQueuedLanes()).toEqual([]);
	setMachineProbe(rich);
	expect(l.startQueuedLanes()).toEqual(["q-second"]);
	expect(second.waiting).toBeUndefined();
	expect(second.proc).toBeDefined();
	expect(spawns.length).toBe(before + 1);
	l.stopLane("q-first");
	l.stopLane("q-second");
	await advance(300);
});

test("lanes.max_active is a hard cap: plenty of memory, the lane over the cap waits and a stopped queued lane never starts", async () => {
	setMachineProbe(rich);
	cfg.lanes = { ...cfg.lanes, max_active: 1 };
	const a = launch("cap-a");
	const b = launch("cap-b");
	expect(a.waiting).toBeUndefined();
	expect(b.waiting).toBe("동시 세션 한도(1개)에 도달해 대기 중");
	l.stopLane("cap-b");
	expect(b.waiting).toBeUndefined();
	expect(b.status).toBe("exited");
	expect(l.startQueuedLanes()).toEqual([]);
	cfg.lanes = { ...cfg.lanes, max_active: undefined };
	l.stopLane("cap-a");
	await advance(300);
});

test("a lane's worker slots come from the limits at spawn and go to the runtime", () => {
	setMachineProbe(rich);
	const spawned = spawns.length;
	const lane = launch("slots-a");
	expect(lane.workerSlots).toBe(2);
	expect(spawns[spawned]!.lane?.workerSlots).toBe(2);
	cfg.lanes = { ...cfg.lanes, max_workers: 1 };
	const capped = launch("slots-b");
	expect(capped.workerSlots).toBe(1);
	cfg.lanes = { ...cfg.lanes, max_workers: undefined };
	l.stopLane("slots-a");
	l.stopLane("slots-b");
});

// Mac mini 2026-10-29: kdb-allowance-review's spawn threw and the lane stayed "starting", so kdb-loss-review waited for memory behind it.
test("a lane whose start throws ends at once and holds no slot", () => {
	setMachineProbe(rich);
	const before = activeCount();
	const start = fake.start;
	fake.start = () => {
		throw new Error("posix_spawn ENOENT omo");
	};
	try {
		expect(() => launch("q-dead")).toThrow("ENOENT");
	} finally {
		fake.start = start;
	}
	expect(l.lanes.get("q-dead")?.status).toBe("exited");
	expect(activeCount()).toBe(before);
});

// No wait goes on unseen: a lane queued past QUEUE_TELL_MS is reported once, and a queued lane whose start fails is reported as a failure.
test("a lane queued too long is reported to the orchestrator once; a queued lane that cannot start is reported as a failure", () => {
	const reports: string[] = [];
	l.setReportHandler((lane, text) => reports.push(`${lane.name}: ${text}`));
	try {
		setMachineProbe(tight);
		launch("q-run");
		const q = launch("q-long");
		expect(q.waiting).toBeTruthy();
		q.startedAt = new Date(Date.now() - QUEUE_TELL_MS - 60_000).toISOString();
		l.startQueuedLanes();
		l.startQueuedLanes();
		expect(reports.filter(r => r.startsWith("q-long: [blocked]"))).toHaveLength(1);
		setMachineProbe(rich);
		const start = fake.start;
		fake.start = () => {
			throw new Error("posix_spawn ENOENT omo");
		};
		try {
			l.startQueuedLanes();
		} finally {
			fake.start = start;
		}
		expect(l.lanes.get("q-long")?.status).toBe("exited");
		expect(reports.some(r => r.startsWith("q-long: [fail]") && r.includes("ENOENT"))).toBe(true);
	} finally {
		l.setReportHandler(() => {});
		l.stopLane("q-run");
	}
});

// Ported from the Mac mini's own fix (2026-10-29): a lane left starting with no process neither holds a slot nor blocks a restart.
test("a lane left starting with no process holds no slot, does not block a restart, and stop marks it exited", () => {
	setMachineProbe(tight);
	const zombie = launch("zombie-a");
	zombie.proc = undefined;
	expect(l.laneBusy(zombie)).toBe(false);
	expect(l.laneCapacity()).toMatchObject({ active: 0 });
	const queued = launch("zombie-next");
	expect(queued.waiting).toBeUndefined();
	l.stopLane("zombie-a");
	expect(zombie.status).toBe("exited");
	l.stopLane("zombie-next");
});
