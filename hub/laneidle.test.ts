import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as l from "./lanes.ts";
import type * as Lanes from "./lanes.ts";
import { cfg, NAME } from "./config.ts";
import { msg } from "./i18n.ts";
import { parkIdleLanes, shouldPark } from "./laneidle.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;

class FakeAgent implements AgentProcess {
	pid = 7400;
	sent: string[] = [];
	killed = 0;
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (): AsyncGenerator<AgentEvent> {})();
	send = (text: string) => void this.sent.push(text);
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {
		this.killed++;
		this.exit.resolve(0);
	};
}
const spawns: { opts: SpawnOpts; agent: FakeAgent }[] = [];
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent();
		spawns.push({ opts, agent });
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};
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
});

const MIN = 60_000;

test("shouldPark: only an idle lane with a process and a session, quiet for the whole period, and never with minutes 0", () => {
	const idle = { name: "x", status: "idle", proc: {} as AgentProcess, sessionFile: "/s.jsonl", lastFrameAt: 1_000 } as const;
	const at = 1_000 + 20 * MIN;
	expect(shouldPark(idle, false, 20, at)).toBe(true);
	expect(shouldPark(idle, false, 20, at - 1)).toBe(false);
	expect(shouldPark(idle, false, 0, at)).toBe(false);
	expect(shouldPark(idle, true, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, status: "working" }, false, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, status: "rate-limited" }, false, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, proc: undefined }, false, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, revive: {} }, false, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, sessionFile: undefined }, false, 20, at)).toBe(false);
});

async function idleLane(name: string): Promise<Lanes.Lane> {
	const cwd = join(DATA, "idle-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Polish the theme.\nDone when: owner approves");
	const session = join(DATA, "idle-sessions", `${name}.jsonl`);
	mkdirSync(join(DATA, "idle-sessions"), { recursive: true });
	writeFileSync(session, "");
	lane.sessionFile = session;
	lane.status = "idle";
	lane.lastFrameAt = 1_000_000;
	return lane;
}

test("an idle lane past the period is stopped but stays idle and live; the next message resumes the same session file", async () => {
	const lane = await idleLane("idle-park");
	const agent = lane.proc as unknown as FakeAgent;
	expect(parkIdleLanes(1_000_000 + 19 * MIN, 20)).toEqual([]);
	expect(agent.killed).toBe(0);
	expect(parkIdleLanes(1_000_000 + 20 * MIN, 20)).toContain("idle-park");
	await advance(300);
	await flush();
	expect(agent.killed).toBe(1);
	expect(lane.proc).toBeUndefined();
	expect(lane.status).toBe("idle");
	expect(l.laneRunning(lane)).toBe(true);
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "idle-park", "lane.json"), "utf8"))).toMatchObject({ status: "idle", parked: true, sessionFile: lane.sessionFile });
	const before = spawns.length;
	expect(l.sendToLane("idle-park", "[owner via web] one more tweak")).toBe("resumed");
	expect(spawns.length).toBe(before + 1);
	expect(spawns.at(-1)!.opts.resume).toBe(lane.sessionFile);
	expect(lane.parked).toBeUndefined();
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "idle-park", "lane.json"), "utf8")).parked).toBeUndefined();
	l.stopLane("idle-park");
	await advance(300);
});

test("a lane stopped while its last report waits on main tells main once; one waiting on CI does not", async () => {
	const told: string[] = [];
	l.setReportHandler((lane, text) => void told.push(`${lane.name}: ${text}`));
	const onMain = await idleLane("idle-main");
	writeFileSync(join(DATA, "lanes", "idle-main", "report.md"), `[wait] 전체 시험을 기다려요\n\n${NAME} 몫: e1bec7e8 전체 시험 결과를 주세요\n`);
	const onCi = await idleLane("idle-ci");
	writeFileSync(join(DATA, "lanes", "idle-ci", "report.md"), "[wait] Actions 빌드 완료를 기다려요\n");
	expect(parkIdleLanes(1_000_000 + 25 * MIN, 20)).toEqual(expect.arrayContaining(["idle-main", "idle-ci"]));
	await advance(300);
	expect(told).toEqual([`idle-main: ${msg().laneIdleWaitMain("idle-main", 25, `전체 시험을 기다려요\n\n${NAME} 몫: e1bec7e8 전체 시험 결과를 주세요`)}`]);
	expect(parkIdleLanes(1_000_000 + 60 * MIN, 20)).toEqual([]);
	expect(told).toHaveLength(1);
	l.setReportHandler(() => {});
	for (const lane of [onMain, onCi]) l.stopLane(lane.name);
	await advance(300);
});

test("a working lane is never parked, however long since its last frame", async () => {
	const lane = await idleLane("idle-busy");
	lane.status = "working";
	const agent = lane.proc as unknown as FakeAgent;
	expect(parkIdleLanes(1_000_000 + 600 * MIN, 20)).not.toContain("idle-busy");
	expect(agent.killed).toBe(0);
	l.stopLane("idle-busy");
	await advance(300);
});

// A lane's session in an agent dir of its own: a worker's task record and the log whose age is the worker's silence (hub/bgwork.ts stallOf).
function quietWorker(lane: Lanes.Lane, description: string): (minutes: number) => void {
	const root = "01a1a711-4db3-7aa6-8fd6-bd53b48fb0f0", agent = join(DATA, `agent-${lane.name}`), store = join(agent, "projects", "p", "senpi-task");
	const log = join(store, "logs", "st_quiet.jsonl");
	mkdirSync(join(agent, "sessions", "s"), { recursive: true });
	mkdirSync(join(store, "tasks"), { recursive: true });
	mkdirSync(join(store, "logs"), { recursive: true });
	lane.sessionFile = join(agent, "sessions", "s", `2026-11-04T14-58-11-507Z_${root}.jsonl`);
	writeFileSync(lane.sessionFile, "");
	writeFileSync(join(store, "tasks", "st_quiet.json"), JSON.stringify({ task_id: "st_quiet", status: "running", pid: process.pid, root_session_id: root, description, started_at: new Date(Date.now() - 300 * MIN).toISOString() }));
	writeFileSync(log, `${JSON.stringify({ type: "tool_execution" })}\n`);
	return minutes => {
		const at = (Date.now() - minutes * MIN) / 1000;
		utimesSync(log, at, at);
	};
}

test("a worker silent in a long wait keeps its lane up however long; past the bound the owner is told once what holds it", async () => {
	const lane = await idleLane("idle-job");
	const agent = lane.proc as unknown as FakeAgent;
	const silentFor = quietWorker(lane, "에고 후보 평가");
	lane.lastFrameAt = Date.now() - 34 * MIN;
	const reports: string[] = [];
	l.setReportHandler((_, text) => void reports.push(text));
	silentFor(16);
	expect(parkIdleLanes(Date.now(), 20)).not.toContain("idle-job");
	expect(agent.killed).toBe(0);
	silentFor(119);
	expect(parkIdleLanes(Date.now(), 20)).not.toContain("idle-job");
	expect(reports).toEqual([]);
	silentFor(120);
	expect(parkIdleLanes(Date.now(), 20)).not.toContain("idle-job");
	expect(parkIdleLanes(Date.now(), 20)).not.toContain("idle-job");
	expect(agent.killed).toBe(0);
	expect(reports).toHaveLength(1);
	expect(reports[0]).toStartWith("[lane stuck]");
	expect(reports[0]).toContain("에고 후보 평가");
	l.setReportHandler(() => {});
	l.stopLane("idle-job");
	await advance(300);
});

test("a worker stopped on a provider error keeps its lane up like a silent one; the lane is not parked with it", async () => {
	const lane = await idleLane("idle-errored");
	const agent = lane.proc as unknown as FakeAgent;
	const silentFor = quietWorker(lane, "주석 통합");
	const log = join(DATA, `agent-${lane.name}`, "projects", "p", "senpi-task", "logs", "st_quiet.jsonl");
	writeFileSync(log, `${JSON.stringify({ type: "child_error", payload: { message: "Provider stream start timed out after 300000ms", stop_reason: "error" } })}\n`);
	lane.lastFrameAt = Date.now() - 34 * MIN;
	silentFor(16);
	expect(parkIdleLanes(Date.now(), 20)).not.toContain("idle-errored");
	expect(agent.killed).toBe(0);
	l.stopLane("idle-errored");
	await advance(300);
});

test("a lane's own shell holds the idle stop; past the bound the owner is told once", async () => {
	const lane = await idleLane("idle-shell");
	const agent = lane.proc as unknown as FakeAgent;
	writeFileSync(lane.sessionFile!, `${JSON.stringify({ customType: "session-lifecycle", data: { state: "waiting_background", waitingOn: { background: [{ source: "terminal-background-sessions", activeCount: 1 }] } } })}\n`);
	lane.lastText = "[run] 빌드를 기다려요";
	const reports: string[] = [];
	l.setReportHandler((_, text) => void reports.push(text));
	expect(parkIdleLanes(1_000_000 + 119 * MIN, 20)).not.toContain("idle-shell");
	expect(agent.killed).toBe(0);
	expect(reports).toEqual([]);
	expect(parkIdleLanes(1_000_000 + 120 * MIN, 20)).not.toContain("idle-shell");
	expect(parkIdleLanes(1_000_000 + 121 * MIN, 20)).not.toContain("idle-shell");
	expect(agent.killed).toBe(0);
	expect(reports).toHaveLength(1);
	l.setReportHandler(() => {});
	l.stopLane("idle-shell");
	await advance(300);
});

test("a gateway restart leaves a parked lane stopped instead of respawning it idle", async () => {
	const lane = await idleLane("idle-restore");
	expect(parkIdleLanes(1_000_000 + 30 * MIN, 20)).toContain("idle-restore");
	await advance(300);
	await flush();
	l.lanes.delete("idle-restore");
	const before = spawns.length;
	l.restoreLanes();
	const back = l.lanes.get("idle-restore")!;
	expect(back.status).toBe("idle");
	expect(back.proc).toBeUndefined();
	expect(spawns.length).toBe(before);
	expect(l.sendToLane("idle-restore", "[owner via web] hi")).toBe("resumed");
	expect(spawns.at(-1)!.opts.resume).toBe(lane.sessionFile);
	l.stopLane("idle-restore");
	await advance(300);
});
