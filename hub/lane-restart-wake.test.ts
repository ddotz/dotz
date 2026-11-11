// A gateway restart and a lane's open work. site-demo-proto (2026-11-04 01:10): a turn ended on purpose to wait for its own background
// shell, the gate read that as idle, the restart killed the shell, and the lane came back idle with 7 tasks open for 90 minutes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
import { resumeUnfinished } from "./laneresume.ts";
import * as l from "./lanes.ts";
import type * as Lanes from "./lanes.ts";
import { dir, persist } from "./lanestate.ts";
import { createRestartGate } from "./restart.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;

class FakeAgent implements AgentProcess {
	pid = 7500;
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
const reports: string[] = [];
const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	l.setReportHandler((_lane, text) => void reports.push(text));
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fakeomo;
	Object.assign(cfg, savedCfg);
});

const shell = { source: "terminal-background-sessions", activeCount: 1, items: [{ id: "bash_20", label: "bun shots.mjs" }] };
// A notification receipt OmO leaves listed for hours, and a monitor OmO restores by itself: neither dies with the process.
const receipt = { source: "delivery:senpi-codemode:notification:1", activeCount: 1 };
const monitor = { source: "terminal-monitors", activeCount: 1, items: [{ id: "mon_1", label: "테스트 완료" }] };
const life = (state: string, background: unknown[], extra: object = {}) => ({ type: "custom", customType: "session-lifecycle", data: { state, waitingOn: { children: 0, background, human: [] }, ...extra } });
const stopped = life("waiting_human", [], { lastStop: { cause: "no_wake" } });
const todos = (open: number) => ({ type: "message", timestamp: "2026-11-04T01:00:00.000Z", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "구현", tasks: Array.from({ length: open }, (_, i) => ({ content: `할 일 ${i}`, status: "pending" })) }] } } });
// Written now by the test clock, which the file system does not follow.
function session(lane: Lanes.Lane, rows: unknown[]): void {
	writeFileSync(lane.sessionFile!, `${rows.map(r => JSON.stringify(r)).join("\n")}\n`);
	utimesSync(lane.sessionFile!, Date.now() / 1000, Date.now() / 1000);
}

function idleLane(name: string): Lanes.Lane {
	const cwd = join(DATA, "wake-work");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(DATA, "wake-sessions"), { recursive: true });
	const lane = l.launch(name, cwd, "Refresh the demo.\nDone when: the demo is reshot");
	lane.sessionFile = join(DATA, "wake-sessions", `${name}.jsonl`);
	writeFileSync(lane.sessionFile, "");
	lane.status = "idle";
	persist(lane);
	return lane;
}

// One gateway restart: what the gateway saves, the process gone, a new gateway reading the records back, and its first sweep, far enough
// from the last one that the backoff has run out.
let sweepAt = Date.now();
async function restart(name: string): Promise<FakeAgent | undefined> {
	const before = spawns.length;
	l.shutdownLanes();
	await advance(300);
	await flush();
	l.lanes.delete(name);
	l.restoreLanes();
	await resumeUnfinished({}, (sweepAt += 3600_000));
	return spawns.slice(before).at(-1)?.agent;
}
const reportFile = (name: string, text: string) => writeFileSync(join(dir(name), "report.md"), `${text}\n`);

test("the restart gate waits for a lane whose ended turn waits on its own background shell, then goes", async () => {
	const lane = idleLane("wake-gate");
	session(lane, [life("waiting_background", [shell, receipt])]);
	let exits = 0;
	const gate = createRestartGate({ busy: () => (l.laneBusy(lane) ? [`lane ${lane.name}`] : []), collecting: () => false, startedAt: 0, minGapMs: 0, noticeAfterMs: 20 * 60_000, notice: () => {}, log: () => {}, exit: () => exits++ });
	gate.request();
	await advance(60_000);
	expect(exits).toBe(0);
	session(lane, [life("waiting_background", [shell, receipt]), life("waiting_background", [receipt])]);
	await advance(5000);
	expect(exits).toBe(1);
	l.stopLane(lane.name);
	await advance(300);
});

test("a shell it still counts holds through the moment OmO writes a running record, and a dead process's record counts for nothing", async () => {
	const lane = idleLane("wake-record");
	session(lane, [life("running", [shell])]);
	expect(l.laneBusy(lane)).toBe(true);
	l.stopLane(lane.name);
	await advance(300);
	expect(lane.proc).toBeUndefined();
	lane.status = "idle";
	expect(l.laneBusy(lane)).toBe(false);
});

test("what survives a restart holds nothing: a monitor, a receipt, or a shell left over after a [done]", async () => {
	const lane = idleLane("wake-free");
	session(lane, [life("waiting_background", [monitor, receipt])]);
	expect(l.laneBusy(lane)).toBe(false);
	session(lane, [life("waiting_background", [shell])]);
	lane.lastText = "[done] 끝났어요";
	expect(l.laneBusy(lane)).toBe(false);
	l.stopLane(lane.name);
	await advance(300);
});

test("a lane with tasks open whose shell the restart cut comes back with one continuation turn on the same session", async () => {
	const lane = idleLane("wake-open");
	reportFile(lane.name, "[run] 데모 촬영이 끝나면 화면을 확인해요.");
	session(lane, [todos(7), stopped]);
	const file = lane.sessionFile;
	const agent = await restart(lane.name);
	expect(agent).toBeDefined();
	expect(spawns.at(-1)!.opts.resume).toBe(file);
	expect(agent!.sent).toHaveLength(1);
	expect(agent!.sent[0]).toContain(msg().laneResumeContinue(7, "할 일 0"));
	expect(l.lanes.get(lane.name)!.status).toBe("starting");
	l.stopLane(lane.name);
	await advance(300);
});

test("a lane whose shell was cut wakes with no plan at all", async () => {
	const lane = idleLane("wake-noplan");
	reportFile(lane.name, "[run] 테스트를 기다려요.");
	session(lane, [stopped]);
	const agent = await restart(lane.name);
	expect(agent!.sent).toHaveLength(1);
	expect(agent!.sent[0]).toContain(msg().laneResumeContinue(0, ""));
	l.stopLane(lane.name);
	await advance(300);
});

test("the owner's restart now, which skips the gate, saves a lane with a live shell as working and resumes it", async () => {
	const lane = idleLane("wake-forced");
	reportFile(lane.name, "[run] 테스트를 기다려요.");
	session(lane, [life("waiting_background", [shell])]);
	const agent = await restart(lane.name);
	expect(agent!.sent).toHaveLength(1);
	expect(agent!.sent[0]).toContain(msg().laneGatewayRestarted);
	l.stopLane(lane.name);
	await advance(300);
});

test("a lane that finished or waits on the owner stays idle, tasks open or not", async () => {
	for (const [name, text] of [["wake-done", "[done] 끝났어요."], ["wake-ask", "[ask] 어느 쪽으로 할까요?"]] as const) {
		const lane = idleLane(name);
		reportFile(name, text);
		session(lane, [todos(2), stopped]);
		const agent = await restart(name);
		expect(agent!.sent).toEqual([]);
		expect(l.lanes.get(name)!.status).toBe("idle");
		l.stopLane(name);
		await advance(300);
	}
	const asked = idleLane("wake-pending");
	asked.pendingAsk = { text: "[ask] 보낼까요?", at: "2026-11-04T01:00:00.000Z" };
	persist(asked);
	reportFile(asked.name, "[lane error] 게이트웨이 알림");
	session(asked, [todos(2), stopped]);
	expect((await restart(asked.name))!.sent).toEqual([]);
	l.stopLane(asked.name);
	await advance(300);
	const quiet = idleLane("wake-quiet");
	reportFile(quiet.name, "중간 보고");
	session(quiet, [todos(0)]);
	expect((await restart(quiet.name))!.sent).toEqual([]);
	l.stopLane(quiet.name);
	await advance(300);
});

test("a lane that makes no progress is woken three times, then alerts once and stays idle; progress starts the count over", async () => {
	const lane = idleLane("wake-loop");
	reportFile(lane.name, "[run] 이어서 해요.");
	session(lane, [todos(3), stopped]);
	const name = lane.name;
	for (let i = 0; i < 3; i++) {
		expect((await restart(name))!.sent).toHaveLength(1);
		l.lanes.get(name)!.status = "idle";
		persist(l.lanes.get(name)!);
	}
	reports.length = 0;
	expect(await restart(name)).toBeUndefined();
	expect(reports).toEqual([msg().laneRestartStuck(3)]);
	expect(l.lanes.get(name)!.status).toBe("idle");
	expect(await restart(name)).toBeUndefined();
	expect(reports).toHaveLength(1);
	session(l.lanes.get(name)!, [todos(2), stopped]);
	expect((await restart(name))!.sent).toHaveLength(1);
	l.stopLane(name);
	await advance(300);
});
