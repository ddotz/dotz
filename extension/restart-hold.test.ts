// While a gateway restart waits, a lane and the orchestrator start no new task worker and launch no session, so the running ones drain
// and the restart goes; steering a running child stays allowed (hub/restart.ts, extension/restart-hold.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRestartGate, markRestartPending, RESTART_HELD_FILE } from "../hub/restart.ts";
import { advance } from "../hub/runtime/test-clock.ts";
import { holdOnRestart, RESTART_HOLD_LANE, RESTART_HOLD_MAIN, restartHeld } from "./restart-hold.ts";

let data: string;
beforeEach(() => {
	data = mkdtempSync(join(tmpdir(), "dz-restart-hold-"));
	mkdirSync(join(data, "lanes", "qa-golden"), { recursive: true });
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

const host = () => {
	const handlers: Record<string, ((event: any, ctx?: any) => any)[]> = {};
	return {
		call: (event: any, ctx?: any) => handlers.tool_call![0]!(event, ctx),
		spawn: (event: any = { agent: "task", invocationKind: "eval" }) => handlers.before_subagent_spawn![0]!(event, {}),
		pi: { on: (name: string, fn: (event: any, ctx?: any) => any) => void (handlers[name] ??= []).push(fn) },
	};
};
const spawn = { toolName: "task", input: { prompt: "run the tests" } };

test("with a restart pending a lane's task spawn is refused with the stop note; with none it passes", () => {
	const lane = host();
	holdOnRestart(lane.pi, data, "qa-golden");
	expect(lane.call(spawn)).toBeUndefined();
	markRestartPending(data, true);
	expect(lane.call(spawn)).toEqual({ block: true, reason: RESTART_HOLD_LANE });
	expect(lane.call({ toolName: "read", input: {} })).toBeUndefined();
	expect(existsSync(join(data, "lanes", "qa-golden", RESTART_HELD_FILE))).toBe(true);
	const main = host();
	holdOnRestart(main.pi, data);
	expect(main.call(spawn)).toEqual({ block: true, reason: RESTART_HOLD_MAIN });
	expect(restartHeld("launch", data)).toBe(RESTART_HOLD_MAIN);
	expect(restartHeld("list", data)).toBeUndefined();
	// A marker a crashed hub left behind holds nothing.
	writeFileSync(join(data, "restart-pending.json"), JSON.stringify({ pid: 2 ** 22 + 7, since: "2026-11-10T00:01:00.000Z" }));
	expect(lane.call(spawn)).toBeUndefined();
	markRestartPending(data, true);
	markRestartPending(data, false);
	expect(lane.call(spawn)).toBeUndefined();
	expect(restartHeld("launch", data)).toBeUndefined();
});

test("while a restart waits omp's other ways to start a worker are held too: eval agent()/workpool() through before_subagent_spawn, a write to agent://<id>", () => {
	const lane = host();
	holdOnRestart(lane.pi, data, "qa-golden");
	const revive = { toolName: "write", input: { path: "agent://Falcon", content: "go on" } };
	expect(lane.spawn()).toBeUndefined();
	expect(lane.call(revive)).toBeUndefined();
	markRestartPending(data, true);
	expect(lane.spawn()).toEqual({ block: true, reason: RESTART_HOLD_LANE });
	expect(lane.call(revive)).toEqual({ block: true, reason: RESTART_HOLD_LANE });
	expect(existsSync(join(data, "lanes", "qa-golden", RESTART_HELD_FILE))).toBe(true);
	expect(lane.call({ toolName: "write", input: { path: "notes/agent.md", content: "x" } })).toBeUndefined();
	expect(lane.call({ toolName: "write", input: { path: "/tmp/agent://x", content: "x" } })).toBeUndefined();
	const main = host();
	holdOnRestart(main.pi, data);
	expect(main.spawn()).toEqual({ block: true, reason: RESTART_HOLD_MAIN });
});

test("task_send while pending: steering a running child passes, resuming an ended one or a redispatch is refused", () => {
	const root = "01a16939-7be6-7ebd-9b38-ed8319b56f3e";
	const sessionFile = join(data, "agent", "sessions", "-Users-x-proj", `2026-11-10T00-00-00-000Z_${root}.jsonl`);
	const tasks = join(data, "agent", "projects", "proj-1", "senpi-task", "tasks");
	mkdirSync(tasks, { recursive: true });
	const rec = (id: string, name: string, status: string) => writeFileSync(join(tasks, `${id}.json`), JSON.stringify({ task_id: id, name, status, root_session_id: root }));
	rec("st_run", "impl", "running");
	rec("st_done", "review", "completed");
	const lane = host();
	holdOnRestart(lane.pi, data, "qa-golden");
	markRestartPending(data, true);
	const send = (input: unknown) => lane.call({ toolName: "task_send", input }, { sessionManager: { getSessionFile: () => sessionFile } });
	expect(send({ to: "st_run", message: "wrap up and report" })).toBeUndefined();
	expect(send({ to: "impl", message: "wrap up" })).toBeUndefined();
	expect(send({ to: "st_done", message: { type: "shutdown_request" } })).toBeUndefined();
	expect(send({ to: "st_done", message: "one more pass" })).toMatchObject({ block: true });
	expect(send({ to: "review", message: "one more pass" })).toMatchObject({ block: true });
	expect(send({ to: "st_run", redispatch: true })).toMatchObject({ block: true });
});

test("a lane that starts a worker as each one ends no longer holds the restart: the count reaches 0 and the restart goes", async () => {
	const lane = host();
	holdOnRestart(lane.pi, data, "qa-golden");
	let workers = 2;
	let exits = 0;
	const gate = createRestartGate({
		busy: () => (workers ? [`lane qa-golden (${workers} background workers)`] : []),
		collecting: () => false,
		startedAt: Date.now() - 3600_000,
		minGapMs: 5 * 60_000,
		noticeAfterMs: 20 * 60_000,
		notice: () => {},
		log: () => {},
		hold: () => markRestartPending(data, true),
		exit: () => exits++,
	});
	// The lane: whenever a worker ends it asks for the next one.
	const workerEnds = () => {
		workers--;
		if (!lane.call(spawn)) workers++;
	};
	workerEnds();
	expect(workers).toBe(2);
	gate.request();
	for (let i = 0; i < 2; i++) {
		await advance(10 * 60_000);
		expect(exits).toBe(0);
		workerEnds();
	}
	expect(workers).toBe(0);
	await advance(5000);
	expect(exits).toBe(1);
});

test("while a restart waits a write to agent://<id> steers a worker the guard knows as running and a broadcast, and is held for a worker that ended or is unknown", () => {
	const lane = host();
	const alive = new Set(["Falcon"]);
	holdOnRestart(lane.pi, data, "qa-golden", (_ctx, id) => alive.has(id));
	markRestartPending(data, true);
	const send = (id: string) => lane.call({ toolName: "write", input: { path: `agent://${id}`, content: "wrap up" } });
	expect(send("Falcon")).toBeUndefined();
	expect(send("all")).toBeUndefined();
	expect(send("Hawk")).toEqual({ block: true, reason: RESTART_HOLD_LANE });
	alive.delete("Falcon");
	expect(send("Falcon")).toEqual({ block: true, reason: RESTART_HOLD_LANE });
});
