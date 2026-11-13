// A lane with unfinished work never sits idle unnoticed (hub/laneunfinished.ts, hub/laneresume.ts), and one with nothing to do stays down at
// no cost. The session rows are reply-voice's own (2026-11-05, seq 226 and 228), cut to the fields the gateway reads.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
import { parkIdleLanes } from "./laneidle.ts";
import { resumeUnfinished } from "./laneresume.ts";
import * as l from "./lanes.ts";
import type * as Lanes from "./lanes.ts";
import { report } from "./lanereport.ts";
import { RESTART_HELD_FILE } from "./restart.ts";
import { dir, persist } from "./lanestate.ts";
import { laneClosed, RESUME_BACKOFF_MS, saysClosed, unfinishedWork } from "./laneunfinished.ts";
import { runState, stallStep } from "./runstate.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const MIN = 60_000;
const DEAD_PID = 2 ** 22 + 7; // above any pid macOS or Linux hands out
const ROOT = "01a1a711-4db3-7aa6-8fd6-bd53b48fb0f0";

class FakeAgent implements AgentProcess {
	pid = 7600;
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
	die = (code: number) => this.exit.resolve(code);
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

const child = { source: "senpi-task", activeCount: 1, items: [{ id: "st_01a1abe7", label: "에고 후보 평가", startedAt: "2026-11-05T13:30:58.172Z" }] };
const waitingChildren = { type: "custom", customType: "session-lifecycle", data: { state: "waiting_children", waitingOn: { children: 1, background: [], human: [], childSources: [child] } } };
const killedRow = { type: "custom", customType: "session-lifecycle", data: { state: "waiting_human", waitingOn: { children: 0, background: [], human: [{ kind: "stalled", requestId: "stall:3:3" }] }, lastStop: { cause: "no_wake" } } };
const todos = (open: number) => ({ type: "message", timestamp: "2026-11-05T13:00:00.000Z", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "구현", tasks: Array.from({ length: open }, (_, i) => ({ content: "할 일 " + i, status: "pending" })) }] } } });

function idleLane(name: string): Lanes.Lane {
	const cwd = join(DATA, "unfinished-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Evaluate the voice.\nDone when: the report is in");
	const sessions = join(DATA, "agent-" + name, "sessions", "s");
	mkdirSync(sessions, { recursive: true });
	lane.sessionFile = join(sessions, "2026-11-04T14-58-11-507Z_" + ROOT + ".jsonl");
	writeFileSync(lane.sessionFile, "");
	lane.status = "idle";
	lane.lastFrameAt = Date.now() - 35 * MIN;
	persist(lane);
	return lane;
}
// Written now by the test clock, which the file system does not follow.
function session(lane: Lanes.Lane, rows: unknown[], at = Date.now()): void {
	writeFileSync(lane.sessionFile!, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
	utimesSync(lane.sessionFile!, at / 1000, at / 1000);
}
const reportFile = (name: string, text: string) => writeFileSync(join(dir(name), "report.md"), text + "\n");

// The lane's task record, and the log whose age is the worker's silence.
function worker(lane: Lanes.Lane, pid: number, silentMin = 34): void {
	const store = join(DATA, "agent-" + lane.name, "projects", "p", "senpi-task");
	mkdirSync(join(store, "tasks"), { recursive: true });
	mkdirSync(join(store, "logs"), { recursive: true });
	const id = "st_" + lane.name;
	writeFileSync(join(store, "tasks", id + ".json"), JSON.stringify({ task_id: id, status: "running", pid, root_session_id: ROOT, description: "에고 후보 평가", started_at: new Date(Date.now() - 55 * MIN).toISOString(), updated_at: new Date(Date.now() - 34 * MIN).toISOString() }));
	const log = join(store, "logs", id + ".jsonl");
	writeFileSync(log, JSON.stringify({ type: "tool_execution" }) + "\n");
	const at = (Date.now() - silentMin * MIN) / 1000;
	utimesSync(log, at, at);
}

// What a stopped lane leaves behind; the gateway's restart needs the process gone first.
async function down(lane: Lanes.Lane): Promise<void> {
	lane.status = "idle";
	expect(l.parkLane(lane)).toBe(true);
	await advance(300);
	await flush();
}
async function restart(name: string): Promise<Lanes.Lane> {
	l.shutdownLanes();
	await advance(300);
	await flush();
	l.lanes.delete(name);
	l.restoreLanes();
	return l.lanes.get(name)!;
}
async function clear(...names: string[]): Promise<void> {
	for (const name of names) l.stopLane(name);
	await advance(300);
	await flush();
}
const spawned = () => spawns.length;
const lastAgent = () => spawns.at(-1)!.agent;

test("audit-xhigh replay (2026-11-06): a last [run] with nothing open behind it wakes nobody, and neither does work that sat for days", async () => {
	const lane = idleLane("uf-stale-run");
	reportFile(lane.name, "[run] 메모에 두 계좌 잔액을 반영했고, 운영팀 소관은 메모리에도 저장했어요.");
	await down(lane);
	const back = await restart(lane.name);
	session(back, [], Date.now() - 27 * 60 * MIN);
	expect(unfinishedWork(back)).toBeUndefined();
	session(back, []);
	expect(unfinishedWork(back)).toBeUndefined();
	const before = spawned();
	expect(await resumeUnfinished({})).toEqual([]);
	expect(spawned()).toBe(before);

	// Even open tasks and a cut stop are history after days; the plan is what a fresh stop would wake on.
	session(back, [todos(3), killedRow]);
	expect(unfinishedWork(back)?.open).toBe(3);
	session(back, [todos(3), killedRow], Date.now() - 72 * 60 * MIN);
	expect(unfinishedWork(back)).toBeUndefined();

	// An owner message it still holds is owed however long it sat.
	back.held = [{ text: "이어서 해 줘", at: Date.now() }] as Lanes.Lane["held"];
	expect(unfinishedWork(back)).toBeDefined();
	back.held = undefined;
	await clear(lane.name);
});

test("reply-voice timeline replay: the idle stop holds for the quiet worker, and a lane stopped anyway is resumed with its worker named", async () => {
	const lane = idleLane("uf-replay");
	const agent = lane.proc as unknown as FakeAgent;
	reportFile(lane.name, "[run] 평가가 끝나기를 기다려요");
	session(lane, [waitingChildren]);
	worker(lane, process.pid);

	// 23:25 KST, 35 minutes after the turn ended: the idle timeout may not take the process, however it asks.
	expect(parkIdleLanes(Date.now(), 20)).not.toContain(lane.name);
	expect(l.parkLane(lane)).toBe(false);
	expect(agent.killed).toBe(0);

	// The stop that did happen (the worker's pid gone, OmO's last row, a parked lane.json), then restarts that used to log "stays parked".
	worker(lane, DEAD_PID);
	session(lane, [waitingChildren, killedRow]);
	expect(l.parkLane(lane)).toBe(true);
	await advance(300);
	await flush();
	const back = await restart(lane.name);
	expect(back.proc).toBeUndefined();
	expect(unfinishedWork(back)?.workers).toEqual(["에고 후보 평가"]);

	// The first sweep wakes it with no owner message, naming the worker to rerun.
	expect(await resumeUnfinished()).toEqual([lane.name]);
	const prompt = lastAgent().sent.join("\n");
	expect(prompt).toContain(msg().laneWorkersCut(["에고 후보 평가"]));
	expect(back.proc).toBeDefined();
	await clear(lane.name);
});

test("a lane parked with work left reads as coming back, not as resting, and the first sweep after a restart brings it back", async () => {
	const lane = idleLane("uf-restart");
	session(lane, [todos(2)]);
	await down(lane);
	expect(runState({ status: "idle", resumeDue: lane.resumeDue })).toMatchObject({ kind: "waiting", reason: "resume" });
	const back = await restart(lane.name);
	expect(await resumeUnfinished()).toEqual([lane.name]);
	expect(back.resumeDue).toBeUndefined();
	expect(lastAgent().sent.join("\n")).toContain("[dotz gateway]");
	await clear(lane.name);
});

test("a worker killed under a live idle lane is named to it once", async () => {
	const lane = idleLane("uf-worker");
	const agent = lane.proc as unknown as FakeAgent;
	lane.prompted = undefined;
	session(lane, [waitingChildren]);
	worker(lane, DEAD_PID);
	const before = spawned();
	expect(await resumeUnfinished()).toEqual([lane.name]);
	expect(spawned()).toBe(before);
	expect(agent.sent.join("\n")).toContain("에고 후보 평가");
	lane.status = "idle";
	lane.prompted = undefined;
	expect(await resumeUnfinished()).toEqual([]);
	await clear(lane.name);
});

test("a process that crashes mid-turn is brought back, and its exit notice does not read as closed", async () => {
	const lane = idleLane("uf-crash");
	session(lane, [todos(1)]);
	lane.status = "working";
	(lane.proc as unknown as FakeAgent).die(1);
	await advance(300);
	await flush();
	expect(lane.status).toBe("exited");
	expect(lane.died?.code).toBe(1);
	expect(await resumeUnfinished()).toEqual([lane.name]);
	expect(lane.proc).toBeDefined();
	expect(lane.died).toBeUndefined();
	await clear(lane.name);
});

test("a resume waits for a free slot and is not dropped", async () => {
	const lane = idleLane("uf-capacity");
	session(lane, [todos(1)]);
	await down(lane);
	const lanes = cfg.lanes;
	cfg.lanes = { ...lanes, min_free_disk_gb: 1e9 };
	expect(await resumeUnfinished()).toEqual([]);
	expect(lane.resumeDue?.state).toBe("capacity");
	expect(runState({ status: "idle", resumeDue: lane.resumeDue })).toMatchObject({ kind: "waiting", reason: "capacity" });
	const back = await restart(lane.name);
	expect(await resumeUnfinished()).toEqual([]);
	expect(back.proc).toBeUndefined();
	expect(back.resumeDue?.state).toBe("capacity");
	cfg.lanes = lanes;
	expect(await resumeUnfinished()).toEqual([lane.name]);
	await clear(lane.name);
});

test("a lane left idle with work by a restart goes through the sweep too, not around capacity", async () => {
	const lane = idleLane("uf-idle-boot");
	session(lane, [todos(1)]);
	const lanes = cfg.lanes;
	cfg.lanes = { ...lanes, min_free_disk_gb: 1e9 };
	const before = spawned();
	const back = await restart(lane.name);
	expect(await resumeUnfinished()).toEqual([]);
	expect(spawned()).toBe(before);
	cfg.lanes = lanes;
	expect(await resumeUnfinished()).toEqual([lane.name]);
	expect(back.proc).toBeDefined();
	await clear(lane.name);
});

test("automatic resumes back off and stop at the bound with one plain message to the owner, and an owner message starts over", async () => {
	const lane = idleLane("uf-bound");
	session(lane, [todos(2)]);
	await down(lane);
	reports.length = 0;
	let now = Date.now();
	for (const wait of [0, 1, 2]) {
		now += RESUME_BACKOFF_MS * 2 ** (wait - 1) * (wait ? 1 : 0);
		if (wait) expect(await resumeUnfinished({}, now - 1)).toEqual([]);
		expect(await resumeUnfinished({}, now)).toEqual([lane.name]);
		await down(lane);
	}
	now += RESUME_BACKOFF_MS * 4;
	const before = spawned();
	expect(await resumeUnfinished({}, now)).toEqual([]);
	expect(await resumeUnfinished({}, now + 60 * MIN)).toEqual([]);
	expect(spawned()).toBe(before);
	expect(reports).toEqual([msg().laneRestartStuck(3)]);
	expect(runState({ status: "idle", resumeDue: lane.resumeDue })).toMatchObject({ kind: "waiting", reason: "standby" });
	l.sendToLane(lane.name, "계속해");
	await down(lane);
	expect(await resumeUnfinished({}, Date.now())).toEqual([lane.name]);
	await clear(lane.name);
});

test("a lane closed by [ask], [wait], [done] or the owner stays down whatever its plan says, at no cost", async () => {
	for (const [name, text] of [["uf-ask", "[ask] 어느 쪽으로 할까요?"], ["uf-wait", "[wait] 형 답을 기다려요"], ["uf-done", "[done] 끝났어요."]] as const) {
		const lane = idleLane(name);
		reportFile(name, text);
		session(lane, [todos(2), killedRow]);
		await down(lane);
		const back = await restart(name);
		expect(await resumeUnfinished()).toEqual([]);
		expect(back.proc).toBeUndefined();
		expect(back.resumeDue).toBeUndefined();
	}
	const stopped = idleLane("uf-stopped");
	session(stopped, [todos(2), killedRow]);
	worker(stopped, DEAD_PID);
	l.stopLane(stopped.name);
	await advance(300);
	await flush();
	const back = await restart(stopped.name);
	expect(back.ownerStopped).toBe(true);
	expect(await resumeUnfinished()).toEqual([]);
	expect(back.proc).toBeUndefined();
	const empty = idleLane("uf-empty");
	reportFile(empty.name, "메모만 남겨요");
	session(empty, [todos(0)]);
	await down(empty);
	await restart(empty.name);
	expect(await resumeUnfinished()).toEqual([]);
});

test("a bare [ask] the report guard refused still reads as a question after a restart, until the owner answers", async () => {
	// Refused once (the lane is told to end its turn, and may say nothing more), or refused twice and kept as a note.
	for (const [name, refused] of [["uf-bare-once", false], ["uf-bare-twice", true]] as const) {
		const lane = idleLane(name);
		session(lane, [todos(1)]);
		lane.askRefused = refused;
		report(lane, "[ask] 어느 쪽으로 할까요?");
		expect(lane.pendingAsk).toBeUndefined();
		lane.prompted = undefined;
		await down(lane);
		const back = await restart(name);
		expect(laneClosed(back)).toBe(true);
		expect(await resumeUnfinished()).toEqual([]);
		expect(back.proc).toBeUndefined();
		l.sendToLane(name, "왼쪽");
		expect(back.bareAsk).toBeUndefined();
		await clear(name);
	}
});

test("a restart nobody asked for keeps the owner's stop and wakes no closed lane; his own restart lifts it", async () => {
	const lane = idleLane("uf-guard");
	lane.ownerStopped = true;
	reportFile(lane.name, "[ask] 어느 쪽으로 할까요?");
	session(lane, [waitingChildren]);
	worker(lane, process.pid);
	await l.restartLane(lane.name, "메모리 가드");
	expect(lane.ownerStopped).toBe(true);
	expect(lastAgent().sent).toEqual([]);
	expect(lane.status).toBe("idle");
	await l.restartLane(lane.name, undefined, true);
	expect(lane.ownerStopped).toBeUndefined();
	await clear(lane.name);
});

test("a verified [done] the owner wrote past no longer closes the lane", async () => {
	const lane = idleLane("uf-claim");
	lane.claim = { state: "verified", at: "2026-11-06T01:00:00.000Z" };
	session(lane, [todos(1)]);
	expect(laneClosed(lane)).toBe(true);
	l.sendToLane(lane.name, "이것도 해줘");
	lane.status = "idle";
	expect(laneClosed(lane)).toBe(false);
	await clear(lane.name);
});

test("a refused message a crash left behind goes once, whichever comes first of the sweep and its retry", async () => {
	const lane = idleLane("uf-refused");
	session(lane, []);
	lane.refused = { text: "형 메시지", tries: 1 };
	let retried = 0;
	lane.refusedTimer = setTimeout(() => retried++, 1000);
	await down(lane);
	expect(await resumeUnfinished()).toEqual([lane.name]);
	await advance(2000);
	await flush();
	expect(retried).toBe(0);
	await clear(lane.name);
});

test("a lane the waiting restart paused (extension/restart-hold.ts) gets one note to go on after the restart", async () => {
	const lane = idleLane("uf-restart-held");
	session(lane, []);
	await down(lane);
	writeFileSync(join(dir(lane.name), RESTART_HELD_FILE), new Date().toISOString());
	const back = await restart(lane.name);
	expect(existsSync(join(dir(lane.name), RESTART_HELD_FILE))).toBe(false);
	expect(await resumeUnfinished()).toEqual([lane.name]);
	expect(lastAgent().sent.join("\n")).toContain(msg().laneRestartResume);
	back.status = "idle";
	back.prompted = undefined;
	expect(await resumeUnfinished()).toEqual([]);
	await clear(lane.name);
});

test("qa-golden replay (2026-11-10): a lane whose last report waits for the gateway restart goes on after it, with no held file", async () => {
	const lane = idleLane("uf-restart-wait");
	session(lane, []);
	reportFile(lane.name, "[wait] 게이트웨이가 재시작 전까지 멈추라고 해서 멈춰 있어요");
	await down(lane);
	const back = await restart(lane.name);
	expect(await resumeUnfinished()).toEqual([lane.name]);
	expect(lastAgent().sent.join("\n")).toContain(msg().laneRestartResume);
	back.status = "idle";
	back.prompted = undefined;
	expect(await resumeUnfinished()).toEqual([]);
	await clear(lane.name);
});

test("a [wait] on some other restart (a worker's) is no gateway restart: the lane gets no resume note after one", async () => {
	const lane = idleLane("uf-worker-restart");
	session(lane, []);
	reportFile(lane.name, "[wait] 워커 재시작 결과를 기다려요");
	await down(lane);
	await restart(lane.name);
	expect(await resumeUnfinished()).toEqual([]);
	await clear(lane.name);
});

test("ddotz/dotz#44: a gateway nudge leaves the owner's [ask] pending, a stall on it nudges nobody, and his answer wakes the lane once", async () => {
	const lane = idleLane("uf-44");
	lane.pendingAsk = { text: "[ask] 보낼까요?", at: "2026-11-06T01:00:00.000Z" };
	reportFile(lane.name, "[lane error] 게이트웨이 알림");
	session(lane, [todos(2)]);
	l.sendToLane(lane.name, "nudge", undefined, true);
	expect(lane.pendingAsk).toBeDefined();
	lane.status = "idle";
	const state = runState({ status: "idle", lastTurnEnd: new Date(Date.now() - 20 * MIN).toISOString(), lastAnswer: "[ask] 보낼까요?", todos: { open: 2, total: 2, done: 0, current: "할 일 0" } });
	expect(state).toMatchObject({ kind: "waiting" });
	expect(stallStep(state, Date.now(), { at: [] }).nudge).toBe(false);
	await down(lane);
	expect(await resumeUnfinished()).toEqual([]);
	const before = spawned();
	l.sendToLane(lane.name, "보내");
	expect(lane.pendingAsk).toBeUndefined();
	expect(spawned()).toBe(before + 1);
	await clear(lane.name);
});

// Last: the budget hold is module state, and the first pass here sets it.
test("the budget gate holds a resume until its reset, and the lane keeps its place", async () => {
	const lane = idleLane("uf-budget");
	session(lane, [todos(1)]);
	await down(lane);
	const now = Date.now();
	const blocked = async () => ({ text: "5h window low", resetAt: now + 30 * MIN });
	expect(await resumeUnfinished({ budget: blocked }, now)).toEqual([]);
	expect(lane.proc).toBeUndefined();
	expect(lane.resumeDue?.state).toBe("due");
	expect(await resumeUnfinished({}, now + 29 * MIN)).toEqual([]);
	expect(await resumeUnfinished({ restarting: () => true }, now + 31 * MIN)).toEqual([]);
	// A restart that begins while the gate is being asked: the turn would hold it up.
	let restarting = false;
	expect(await resumeUnfinished({ budget: async () => ((restarting = true), undefined), restarting: () => restarting }, now + 31 * MIN)).toEqual([]);
	expect(lane.proc).toBeUndefined();
	expect(await resumeUnfinished({}, now + 31 * MIN)).toEqual([lane.name]);
	await clear(lane.name);
});

test("a status emoji closes an answer unless a promise follows it; a sentence about waiting closes nothing", () => {
	expect(saysClosed("✅ 다 끝냈어요")).toBe(true);
	expect(saysClosed("❌ 배포가 실패했어요")).toBe(true);
	expect(saysClosed("✅ 빌드 통과\n이제 배포 진행할게요.")).toBe(false);
	expect(saysClosed("[done] 끝났고 내일 다시 볼게요.")).toBe(true);
	expect(saysClosed("이제 앞 메시지에 아직 답이 안 나갔으면 12초까지 기다려서 묶어요.")).toBe(false);
});
