// A gateway restart waits for the OmO task workers of the orchestrator and of a lane, read from OmO's task store
// (<agent dir>/projects/<project>/senpi-task/tasks/<id>.json, root_session_id = the uuid ending the session file name),
// on the immediate path and on the coalescing path alike. 2026-10-23: three running workers were killed by a restart because
// the gate only knew deferred prompts, and OmO sends no worker frames for the live subagent map.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBgWork } from "./bgwork.ts";
import { createRestartGate } from "./restart.ts";
import { advance } from "./runtime/test-clock.ts";

const ORCH = "01a16939-7be6-7ebd-9b38-ed8319b56f3d";
const LANE = "01a16939-7be6-7ebd-9b38-ed8319b56f3e";
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let tasks: string;
const sessionOf = (root: string) => join(dir, "sessions", "-Users-x-dotz", `2026-10-23T14-00-00-000Z_${root}.jsonl`);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-restart-workers-"));
	tasks = join(dir, "projects", ".dotz-11b62020b284", "senpi-task", "tasks");
	mkdirSync(tasks, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The shape of a real record (keys only; no session content).
const record = (id: string, root: string, over: Record<string, unknown> = {}) =>
	writeFileSync(
		join(tasks, `${id}.json`),
		JSON.stringify({
			effect_seq: 3,
			task_id: id,
			status: "running",
			residency_state: "resident",
			parent_session_id: root,
			root_session_id: root,
			depth: 1,
			execution_mode: "background",
			created_at: iso(Date.now() - 600_000),
			started_at: iso(Date.now() - 590_000),
			updated_at: iso(Date.now() - 5_000),
			description: "worker",
			category: "deep-low",
			spawn_spec: { cwd: "/tmp/x", prompt: "Repo: /tmp/x" },
			pid: process.pid,
			background_mode: "background",
			...over,
		}),
	);

function setup(startedAgoMs: number) {
	const work = createBgWork({ sessionFile: () => sessionOf(ORCH), deferred: () => [] });
	const state = { exits: 0, logs: [] as string[] };
	const busy = () => {
		const n = work.running();
		const lane = work.running(sessionOf(LANE));
		return [n ? `orchestrator background workers (${n})` : "", lane ? `lane x background workers (${lane})` : ""].filter(Boolean);
	};
	const gate = createRestartGate({
		busy,
		collecting: () => false,
		startedAt: Date.now() - startedAgoMs,
		minGapMs: 5 * 60_000,
		noticeAfterMs: 20 * 60_000,
		notice: () => {},
		log: line => state.logs.push(line),
		exit: () => state.exits++,
	});
	return { gate, state, work };
}

test("running workers of the orchestrator and of a lane are counted per session; finished and foreign ones are not", () => {
	const { work } = setup(3600_000);
	record("st_a", ORCH);
	record("st_b", ORCH, { status: "queued" });
	record("st_c", ORCH, { status: "completed", terminal_at: iso(Date.now()) });
	record("st_lane", LANE);
	record("st_other", "01a16939-0000-0000-0000-000000000000");
	expect(work.running()).toBe(2);
	expect(work.running(sessionOf(LANE))).toBe(1);
	expect(work.running(undefined as unknown as string)).toBe(2);
});

test("a worker whose process is gone, or a pid-less leftover, is not running", () => {
	const dead = createBgWork({ sessionFile: () => sessionOf(ORCH), deferred: () => [], alive: () => false });
	record("st_dead", ORCH, { pid: 4242 });
	record("st_old", ORCH, { pid: undefined, updated_at: iso(Date.now() - 4 * 3600_000) });
	expect(dead.running()).toBe(0);
});

test("a running worker holds the restart on the immediate path, and the restart comes when it finishes", async () => {
	const { gate, state } = setup(3600_000);
	record("st_a", ORCH);
	expect(gate.request()).toContain("orchestrator background workers (1)");
	await advance(60_000);
	expect(state.exits).toBe(0);
	record("st_a", ORCH, { status: "completed", terminal_at: iso(Date.now()) });
	await advance(5000);
	expect(state.exits).toBe(1);
});

test("a running worker holds the restart on the coalescing path (inside the minimum gap) too", async () => {
	const { gate, state } = setup(60_000);
	record("st_a", ORCH);
	expect(gate.request()).toContain("coalescing");
	await advance(10 * 60_000);
	expect(state.exits).toBe(0);
	expect(gate.request()).toContain("orchestrator background workers (1)");
	record("st_a", ORCH, { status: "completed", terminal_at: iso(Date.now()) });
	await advance(5000);
	expect(state.exits).toBe(1);
});

test("a lane's worker holds the restart; past the notice time it is logged and still not killed", async () => {
	const { gate, state } = setup(3600_000);
	record("st_lane", LANE);
	gate.request();
	await advance(45 * 60_000);
	expect(state.exits).toBe(0);
	expect(state.logs.some(l => l.includes("still waiting") && l.includes("lane x background workers (1)") && l.includes("not killing"))).toBe(true);
	record("st_lane", LANE, { status: "completed", terminal_at: iso(Date.now()) });
	await advance(5000);
	expect(state.exits).toBe(1);
});

test("no worker running: the restart goes at once", async () => {
	const { gate, state } = setup(3600_000);
	record("st_c", ORCH, { status: "completed", terminal_at: iso(Date.now()) });
	expect(gate.request()).toBe("gateway restarting");
	await advance(2000);
	expect(state.exits).toBe(1);
});
