import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as l from "./lanes.ts";
import type * as Lanes from "./lanes.ts";
import { cfg, NAME } from "./config.ts";
import { msg } from "./i18n.ts";
import { CHECK_MS, parkIdleLanes, remindMainWaits, shouldPark, startLaneIdleStop } from "./laneidle.ts";
import { createLaneRelay } from "./lanerelay.ts";
import { setMainWroteHandler } from "./lanestate.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, clock, flush } from "./runtime/test-clock.ts";
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

// The lane's report, written at `at` on the test clock (the file system does not follow it).
function waitReport(name: string, text: string, at: number): void {
	const file = join(DATA, "lanes", name, "report.md");
	writeFileSync(file, text);
	utimesSync(file, at / 1000, at / 1000);
}
const WAIT_TEXT = `[wait] 전체 시험을 기다려요\n\n${NAME} 몫: e1bec7e8 전체 시험 결과를 주세요\n`;

test("a lane waiting on main tells main again at 20, 60 and 180 min, then the owner once at 360; one waiting on CI tells no one", async () => {
	const main: string[] = [];
	const owner: string[] = [];
	l.setReportHandler((lane, text) => void main.push(`${lane.name}: ${text}`));
	l.setNoticeHandler((lane, text) => void owner.push(`${lane.name}: ${text}`));
	const at = Date.now();
	const onMain = await idleLane("wait-main");
	waitReport(onMain.name, WAIT_TEXT, at);
	const onCi = await idleLane("wait-ci");
	waitReport(onCi.name, "[wait] Actions 빌드 완료를 기다려요\n", at);
	const told = (minutes: number) => remindMainWaits(at + minutes * MIN);
	expect([told(19), told(20), told(21), told(59), told(60), told(179), told(180), told(359), told(360), told(2000)]).toEqual([[], ["wait-main"], [], [], ["wait-main"], [], ["wait-main"], [], ["wait-main"], []]);
	const said = (minutes: number) => `wait-main: ${msg().laneIdleWaitMain("wait-main", minutes, `전체 시험을 기다려요\n\n${NAME} 몫: e1bec7e8 전체 시험 결과를 주세요`)}`;
	expect(main).toEqual([said(20), said(60), said(180)]);
	expect(owner).toEqual([said(360)]);
	l.setReportHandler(() => {});
	l.setNoticeHandler(() => {});
	for (const lane of [onMain, onCi]) l.stopLane(lane.name);
	await advance(300);
});

test("the reminder has its own timer: a lane waiting on main that its own shell keeps up tells main, whether the idle stop is off or on", async () => {
	const saved = cfg.lanes;
	for (const minutes of [0, 20]) {
		cfg.lanes = { ...saved, idle_stop_min: minutes };
		const lane = await idleLane(`wait-held-${minutes}`);
		const agent = lane.proc as unknown as FakeAgent;
		lane.lastFrameAt = Date.now() - 25 * MIN;
		writeFileSync(lane.sessionFile!, `${JSON.stringify({ customType: "session-lifecycle", data: { state: "waiting_background", waitingOn: { background: [{ source: "terminal-background-sessions", activeCount: 1 }] } } })}\n`);
		waitReport(lane.name, WAIT_TEXT, Date.now() - 20 * MIN);
		const main: string[] = [];
		l.setReportHandler((ln, text) => void main.push(`${ln.name}: ${text.split(" ")[0]}`));
		const stop = startLaneIdleStop();
		await advance(CHECK_MS);
		stop();
		expect(main).toEqual([`${lane.name}: [lane`]);
		expect(agent.killed).toBe(0);
		l.setReportHandler(() => {});
		l.stopLane(lane.name);
		await advance(300);
	}
	cfg.lanes = saved;
});

test("a gateway restart keeps the reminder count: a lane parked before it goes on with its next step, not the first one again", async () => {
	const told: string[] = [];
	l.setReportHandler(lane => void told.push(lane.name));
	const at = Date.now();
	const lane = await idleLane("wait-restart");
	waitReport(lane.name, WAIT_TEXT, at);
	expect(parkIdleLanes(at + 20 * MIN, 20)).toContain(lane.name);
	await advance(300);
	await flush();
	expect(remindMainWaits(at + 20 * MIN)).toEqual([lane.name]);
	l.lanes.delete(lane.name);
	l.restoreLanes();
	expect(l.lanes.get(lane.name)!.proc).toBeUndefined();
	expect(remindMainWaits(at + 21 * MIN)).toEqual([]);
	expect(remindMainWaits(at + 60 * MIN)).toEqual([lane.name]);
	expect(told).toEqual([lane.name, lane.name]);
	l.setReportHandler(() => {});
	l.stopLane(lane.name);
	await advance(300);
});

test("a message reaching a waiting lane starts its reminders over; one not from the owner makes the relay take the same [wait] again", async () => {
	const relay = createLaneRelay({ busy: () => false, deliver: () => {}, lead: () => "" });
	setMainWroteHandler(relay.forget);
	const at = Date.now();
	const lane = await idleLane("wait-answer");
	waitReport(lane.name, WAIT_TEXT, at);
	expect(relay.report(lane.name, WAIT_TEXT, "report.md")).toBe("relayed");
	expect(remindMainWaits(at + 20 * MIN)).toEqual([lane.name]);
	expect(remindMainWaits(at + 60 * MIN)).toEqual([lane.name]);
	clock.now = at + 70 * MIN;
	l.sendToLane(lane.name, "[owner via web] 아직이에요");
	expect(relay.report(lane.name, WAIT_TEXT, "report.md")).toBe("duplicate");
	expect(remindMainWaits(at + 89 * MIN)).toEqual([]);
	expect(remindMainWaits(at + 90 * MIN)).toEqual([lane.name]);
	l.sendToLane(lane.name, "릴리스는 내일 만들어요", undefined, true);
	expect(relay.report(lane.name, WAIT_TEXT, "report.md")).toBe("relayed");
	setMainWroteHandler(() => {});
	l.stopLane(lane.name);
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
