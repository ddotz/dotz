import { expect, test } from "bun:test";
import { emitEventActivity } from "./activity.ts";
import { laneBusyLines, sessionBusyLines, type SessionBusy } from "./busy-lines.ts";
import { laneBusy, type Lane } from "./lanes.ts";
import { restartCapText } from "./restart.ts";
import type { AgentProcess } from "./runtime/types.ts";
import { createOmpFeed } from "./worker-hold.ts";

const idle: SessionBusy = { turn: "", bgRunning: 0, subagents: [], live: 0, deferred: false };
const lines = (s: Partial<SessionBusy>) => sessionBusyLines("orchestrator", { ...idle, ...s }).filter(Boolean);

test("a session with nothing running and nothing deferred has no busy line", () => {
	expect(lines({})).toEqual([]);
});

test("a session's turn line comes first, then its background work", () => {
	expect(lines({ turn: "orchestrator turn", bgRunning: 2, subagents: [{ status: "running" }], live: 1 })).toEqual(["orchestrator turn", "orchestrator background workers (2)"]);
});

test("what the process reports live holds the session: running omp subagents are workers", () => {
	expect(lines({ subagents: [{ status: "running" }, { status: "done" }], live: 1 })).toEqual(["orchestrator background workers (1)"]);
	expect(lines({ subagents: [{ status: "running" }, { status: "running" }], live: 2 })).toEqual(["orchestrator background workers (2)"]);
});

test("work only awaitingAsync reports (a shell job, a service) holds the session and reads as jobs, not workers", () => {
	expect(lines({ live: 1 })).toEqual(["orchestrator background jobs (1)"]);
	expect(lines({ subagents: [{ status: "done" }], live: 1 })).toEqual(["orchestrator background jobs (1)"]);
});

test("OmO's task store alone counts the session's workers", () => {
	expect(lines({ bgRunning: 3 })).toEqual(["orchestrator background workers (3)"]);
});

test("a request just deferred holds the session without a count until its worker shows up", () => {
	expect(lines({ deferred: true })).toEqual(["orchestrator background workers"]);
	expect(lines({ deferred: true, live: 1 })).toEqual(["orchestrator background jobs (1)"]);
});

test("a lane says what it waits on: its turn or shell with its OmO workers, or the workers alone", () => {
	expect(laneBusyLines("x", true, 0)).toEqual(["lane x"]);
	expect(laneBusyLines("x", true, 2)).toEqual(["lane x (2 background workers)"]);
	expect(laneBusyLines("x", false, 2)).toEqual(["lane x background workers (2)"]);
	expect(laneBusyLines("x", false, 0)).toEqual([]);
});

test("a lane whose process says async work can still wake it is busy; one that does not say is not", () => {
	const lane = (awaiting: (() => boolean) | undefined) => ({ name: "busy-lines", status: "idle", proc: { awaitingAsync: awaiting } }) as unknown as Lane;
	expect(laneBusy(lane(() => true))).toBe(true);
	expect(laneBusy(lane(() => false))).toBe(false);
	expect(laneBusy(lane(undefined))).toBe(false);
	expect(laneBusy(lane(() => true), false)).toBe(false);
});

test("the owner reads a job line as work, a worker line as workers", () => {
	const text = restartCapText(["orchestrator background jobs (1)", "conversation session c1 background jobs (1)", "orchestrator background workers (2)"], 30);
	expect(text).toContain("메인 대화 작업 1개, 대화 c1 작업 1개, 메인 대화 워커 2개");
});

test("an omp feed counts running subagents and awaitingAsync, and only for omp", () => {
	const source = "busy-lines:feed";
	let awaiting = false;
	let omp = true;
	const proc = { awaitingAsync: () => awaiting } as unknown as AgentProcess;
	const feed = createOmpFeed({ source, process: () => proc, omp: () => omp, free: () => true });
	expect([feed.count(), feed.live()]).toEqual([0, 0]);
	awaiting = true;
	expect([feed.count(), feed.live()]).toEqual([1, 1]);
	awaiting = false;
	emitEventActivity(source, { type: "subagent", update: { id: "w1", status: "running" } });
	expect([feed.count(), feed.live(), feed.list().map(s => s.id)]).toEqual([1, 1, ["w1"]]);
	omp = false;
	expect([feed.live(), feed.list()]).toEqual([0, []]);
});

test("an omp feed tells the running process only while it is free", () => {
	const sent: string[][] = [];
	let free = true;
	const proc = { send: (text: string, mode: string) => void sent.push([text, mode]) } as unknown as AgentProcess;
	const feed = createOmpFeed({ source: "busy-lines:tell", process: () => proc, omp: () => true, free: () => free });
	expect(feed.tell("a")).toBe(true);
	free = false;
	expect(feed.tell("b")).toBe(false);
	expect(sent).toEqual([["a", "steer"]]);
	expect(createOmpFeed({ source: "busy-lines:none", process: () => undefined, omp: () => true, free: () => true }).tell("c")).toBe(false);
});
