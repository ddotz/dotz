// Conversation sessions and the orchestrator resume like lanes (hub/sessionresume.ts, hub/laneresume.ts). The registry, the task store reader and
// the signal are the real ones; only the agent process is a fake. The session rows are OmO's own shapes (2026-11-05, st_01a1abe7), cut to the fields read.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBgWork } from "./bgwork.ts";
import { type Conv, createConvSessions } from "./convsessions.ts";
import { msg } from "./i18n.ts";
import { RESUME_BACKOFF_MS } from "./laneunfinished.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { Prompts } from "./prompts.ts";
import { MAIN } from "./session-key.ts";
import { createSessionResume } from "./sessionresume.ts";

const DEAD_PID = 2 ** 22 + 7;
const ROOT = "01a1a711-4db3-7aa6-8fd6-bd53b48fb0f0";
const HOUR = 3600_000;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lifecycle = (data: unknown) => ({ type: "custom", customType: "session-lifecycle", data });
const killedRow = lifecycle({ state: "waiting_human", waitingOn: { children: 0, background: [], human: [{ kind: "stalled", requestId: "stall:3:3" }] }, lastStop: { cause: "no_wake" } });
const answer = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

function world() {
	const dir = mkdtempSync(join(tmpdir(), "session-resume-"));
	dirs.push(dir);
	const file = join(dir, "agent", "sessions", "s", `2026-11-04T14-58-11-507Z_${ROOT}.jsonl`);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, "");
	return { dir, file, resumeFile: join(dir, "session-resume.json") };
}
type World = ReturnType<typeof world>;
// Written now by the test clock, which the file system does not follow.
function session(w: World, rows: unknown[], at = Date.now()): void {
	writeFileSync(w.file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
	utimesSync(w.file, at / 1000, at / 1000);
}
function worker(w: World, pid: number, id = "st_a"): void {
	const tasks = join(w.dir, "agent", "projects", "p", "senpi-task", "tasks");
	mkdirSync(tasks, { recursive: true });
	const at = new Date(Date.now() - HOUR).toISOString();
	writeFileSync(join(tasks, `${id}.json`), JSON.stringify({ task_id: id, status: "running", pid, root_session_id: ROOT, description: "메일 첨부 분석", started_at: at, updated_at: at }));
}

type Agent = { pid?: number; status: string; stoppedBy: string; rateLimitedUntil: string };
function boot(w: World, opts: { maxLive?: number; mainFile?: boolean; asked?: boolean } = {}) {
	const agents = new Map<string, Agent>();
	const delivered: { key: string; text: string; target?: string }[] = [];
	const told: { target: string; text: string }[] = [];
	const agent = (key: string): Orchestrator => {
		const a: Agent = { status: "stopped", stoppedBy: "", rateLimitedUntil: "" };
		agents.set(key, a);
		const orch = { get status() { return a.status; }, get stoppedBy() { return a.stoppedBy; }, get rateLimitedUntil() { return a.rateLimitedUntil; }, ctx: { tokens: 0, compaction: { state: "idle" } }, sessionFile: "", activeModel: "m" };
		return { orch, orchestratorPid: () => a.pid, heldCount: () => 0, lastTurnEndAt: () => undefined, park: () => true } as unknown as Orchestrator;
	};
	const queue = (key: string) =>
		({
			deliver: (text: string, reply?: { target: string }) => {
				delivered.push({ key, text, target: reply?.target });
				const a = agents.get(key)!;
				a.pid ??= 4242;
				a.status = "working";
				return false;
			},
			queued: () => [],
		}) as unknown as Prompts;
	const bgOf = (o: Orchestrator) => createBgWork({ sessionFile: () => o.orch.sessionFile, deferred: () => [] });
	const registry = createConvSessions({
		on: () => true,
		kinds: () => undefined,
		maxLive: () => opts.maxLive ?? 3,
		idleMin: () => 20,
		mailOf: () => undefined,
		make: o => agent(o.key),
		wire: (c: Conv) => ({ queue: queue(c.key), bg: bgOf(c.o) }),
		dataDir: w.dir,
		history: () => [],
		workers: () => 0,
		workerPin: () => "pin",
		log: () => {},
		now: () => Date.now(),
	});
	const mainO = agent(MAIN);
	const mainBg = bgOf(mainO);
	registry.setMain({ key: MAIN, o: mainO, queue: queue(MAIN), bg: mainBg } as unknown as Parameters<typeof registry.setMain>[0]);
	const m = agents.get(MAIN)!;
	m.pid = 1111;
	m.status = "idle";
	if (opts.mainFile) mainO.orch.sessionFile = w.file;
	const resume = createSessionResume({
		file: w.resumeFile,
		log: () => {},
		sessions: () => registry.resumeSessions(() => opts.asked ?? false, (target, text) => void told.push({ target, text })),
	});
	return { registry, agents, delivered, told, resume, mainBg };
}
function parkedConv(w: World, key = "mail:k1"): void {
	const dir = join(w.dir, "conv-sessions", key.replace(":", "_"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "state.json"), JSON.stringify({ key, primary: key, aliases: [], createdAt: "2026-11-05T00:00:00.000Z", parked: true, sessionFile: w.file }));
}
// What the gateway finds after a restart: the conversation back in the registry with no process.
function restarted(w: World, opts: Parameters<typeof boot>[1] = {}) {
	parkedConv(w);
	const b = boot(w, opts);
	b.registry.restore();
	return b;
}

test("replay: a conversation's worker killed by a restart brings the parked conversation back with the worker named, and no owner message", async () => {
	const w = world();
	session(w, [killedRow]);
	worker(w, DEAD_PID);
	const b = restarted(w);
	expect(await b.resume.tick()).toEqual(["mail:k1"]);
	expect(b.delivered).toHaveLength(1);
	expect(b.delivered[0]).toMatchObject({ key: "mail:k1", target: "mail:k1" });
	expect(b.delivered[0]!.text).toContain("메일 첨부 분석");
	expect(b.told).toEqual([]);
	// The woken session runs now: the next pass does nothing.
	expect(await b.resume.tick()).toEqual([]);
});

test("replay: the orchestrator's own worker killed by a restart wakes main once, also across another restart", async () => {
	const w = world();
	session(w, [answer("[later] 맡겨 뒀어요")]);
	worker(w, DEAD_PID);
	const b = boot(w, { mainFile: true });
	expect(await b.resume.tick()).toEqual([MAIN]);
	expect(b.delivered.map(d => d.key)).toEqual([MAIN]);
	expect(b.delivered[0]!.text).toContain("메일 첨부 분석");
	// Its turn ended and cannot close the dead worker's record: told once is told.
	const later = Date.now() + 2 * HOUR;
	session(w, [answer("[later] 맡겨 뒀어요"), answer("다시 돌려서 끝냈어요")], later);
	b.agents.get(MAIN)!.status = "idle";
	expect(await b.resume.tick(undefined, later + HOUR)).toEqual([]);
	const again = boot(w, { mainFile: true });
	expect(await again.resume.tick(undefined, later + HOUR)).toEqual([]);
});

test("a turn killed with nothing else behind it comes back; the owner's own stop of that turn does not", async () => {
	const w = world();
	session(w, [lifecycle({ state: "running", waitingOn: { children: 0, background: [], human: [] } })]);
	expect((await restarted(w).resume.tick())).toEqual(["mail:k1"]);
	const stopped = world();
	session(stopped, [lifecycle({ state: "running", lastStop: { cause: "aborted" }, waitingOn: { children: 0, background: [], human: [] } })]);
	expect(await restarted(stopped).resume.tick()).toEqual([]);
});

test("a session waiting on the owner stays parked, however it says so", async () => {
	const said = [answer("[ask] 어느 계좌로 할까요?"), answer("어느 쪽으로 보낼까요?"), answer("[wait] 형 답을 기다려요"), lifecycle({ state: "waiting_human", waitingOn: { children: 0, background: [], human: [{ kind: "question", requestId: "question:1" }] } })];
	for (const row of said) {
		const w = world();
		session(w, [row]);
		worker(w, DEAD_PID);
		const b = restarted(w);
		expect(await b.resume.tick()).toEqual([]);
		expect(b.delivered).toEqual([]);
	}
	const w = world();
	session(w, [killedRow]);
	worker(w, DEAD_PID);
	const carded = restarted(w, { asked: true });
	expect(await carded.resume.tick()).toEqual([]);
});

test("a session that sat down days ago is history, whatever its last rows say", async () => {
	const w = world();
	session(w, [killedRow]);
	worker(w, DEAD_PID);
	const days = (Date.now() - 72 * HOUR) / 1000;
	utimesSync(w.file, days, days);
	const b = restarted(w);
	expect(await b.resume.tick()).toEqual([]);
	expect(b.delivered).toEqual([]);
});

test("a session with nothing cut is left alone: an open-ended clean answer is no evidence", async () => {
	const w = world();
	session(w, [answer("[run] 메모에 반영했어요"), lifecycle({ state: "done", completion: { kind: "reply" }, waitingOn: { children: 0, background: [], human: [] } })]);
	const b = restarted(w);
	expect(await b.resume.tick()).toEqual([]);
});

test("a clean turn that left todos open is no interruption: OmO's stalled row wakes neither a live nor a parked session", async () => {
	const w = world();
	session(w, [answer("[later] 나중에 볼게요"), killedRow]);
	expect(await boot(w, { mainFile: true }).resume.tick()).toEqual([]);
	expect(await restarted(w).resume.tick()).toEqual([]);
});

test("OmO's interrupted_run wakes a live session too", async () => {
	const w = world();
	session(w, [lifecycle({ state: "waiting_human", waitingOn: { children: 0, background: [], human: [{ kind: "interrupted_run", requestId: "interrupted:2:1" }] } })]);
	expect(await boot(w, { mainFile: true }).resume.tick()).toEqual([MAIN]);
});

test("a crash loop reaches the bound however its workers change, and a named worker a turn took up never comes back after the next park", async () => {
	const w = world();
	session(w, [killedRow]);
	worker(w, DEAD_PID);
	const b = restarted(w);
	let t = Date.now();
	for (const [i, row] of [lifecycle({ state: "running", waitingOn: {} }), killedRow, lifecycle({ state: "running", waitingOn: {} })].entries()) {
		expect(await b.resume.tick(undefined, t)).toEqual(["mail:k1"]);
		worker(w, DEAD_PID, `st_${i}`);
		t += 21 * 60_000;
		session(w, [row], t);
		Object.assign(b.agents.get("mail:k1")!, { pid: undefined, status: "stopped" });
		t += 60_000;
	}
	expect(await b.resume.tick(undefined, t)).toEqual([]);
	expect(b.delivered).toHaveLength(3);
	expect(b.told).toHaveLength(1);

	const parked = world();
	session(parked, [answer("[later] 맡겨 뒀어요")]);
	worker(parked, DEAD_PID);
	const p = restarted(parked);
	expect(await p.resume.tick()).toEqual(["mail:k1"]);
	session(parked, [answer("다시 돌렸어요")], Date.now() + HOUR);
	const next = restarted(parked);
	expect(await next.resume.tick(undefined, Date.now() + 2 * HOUR)).toEqual([]);
});

test("the bound: three wakes on 5, 10 and 20 minutes, then one plain owner message, and it holds across a gateway restart", async () => {
	const w = world();
	session(w, [killedRow]);
	worker(w, DEAD_PID);
	let b = restarted(w);
	const dies = () => Object.assign(b.agents.get("mail:k1")!, { pid: undefined, status: "stopped" });
	const t0 = Date.now();
	let t = t0;
	expect(await b.resume.tick(undefined, t)).toEqual(["mail:k1"]);
	dies();
	expect(await b.resume.tick(undefined, t + RESUME_BACKOFF_MS - 1)).toEqual([]);
	t += RESUME_BACKOFF_MS;
	expect(await b.resume.tick(undefined, t)).toEqual(["mail:k1"]);
	dies();
	b = restarted(w);
	expect(await b.resume.tick(undefined, t + 2 * RESUME_BACKOFF_MS - 1)).toEqual([]);
	t += 2 * RESUME_BACKOFF_MS;
	expect(await b.resume.tick(undefined, t)).toEqual(["mail:k1"]);
	dies();
	t += 4 * RESUME_BACKOFF_MS;
	expect(await b.resume.tick(undefined, t)).toEqual([]);
	expect(b.told).toEqual([{ target: "mail:k1", text: msg().sessionRestartStuck(3) }]);
	t += 100 * RESUME_BACKOFF_MS;
	expect(await b.resume.tick(undefined, t)).toEqual([]);
	expect(b.told).toHaveLength(1);
});

test("capacity and budget hold a wake without spending one; an owner stop, a usage limit and a turn in progress keep it down", async () => {
	const w = world();
	session(w, [killedRow]);
	worker(w, DEAD_PID);
	const full = restarted(w, { maxLive: 0 });
	expect(await full.resume.tick()).toEqual([]);
	const held = restarted(w);
	expect(await held.resume.tick(async () => true)).toEqual([]);
	expect(await held.resume.tick()).toEqual(["mail:k1"]);

	const other = world();
	session(other, [killedRow]);
	worker(other, DEAD_PID);
	for (const set of [{ stoppedBy: "owner" }, { rateLimitedUntil: new Date(Date.now() + HOUR).toISOString() }, { status: "working" }]) {
		const b = restarted(other);
		Object.assign(b.agents.get("mail:k1")!, set);
		expect(await b.resume.tick()).toEqual([]);
	}
});

test("a worker the failed-worker handover already brought up gets no second wake on a live session", async () => {
	const w = world();
	session(w, [answer("[later] 맡겨 뒀어요")]);
	worker(w, DEAD_PID);
	const b = boot(w, { mainFile: true });
	b.mainBg.handed.add("st_a");
	expect(await b.resume.tick()).toEqual([]);
	expect(b.delivered).toEqual([]);
});
