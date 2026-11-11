import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { paths } from "./config.ts";
import { advance } from "./runtime/test-clock.ts";
import { listMonitors } from "./monitors.ts";
import { addSchedule, listSchedules, patchSchedule, removeSchedule, startSchedules, stopSchedules } from "./schedule.ts";
import { addWatch, allWatches, patchWatch, removeWatch, runWatch, startWatches } from "./watch.ts";

const clearAll = () => {
	for (const w of allWatches()) removeWatch(w.id);
	for (const s of listSchedules()) removeSchedule(s.id);
};
beforeEach(clearAll);
afterAll(clearAll);

test("no watches and no schedules is an empty list", () => {
	expect(listMonitors()).toEqual([]);
});

test("one watch and one schedule come back in the owner-facing shape", async () => {
	const w = addWatch({ name: "demo-watch", command: "echo hi", every_minutes: 10, channels: ["ch:7"] }, "");
	await runWatch(w.id);
	const s = addSchedule({ text: "ch:7 주간 보고 정리", in_minutes: 60, every_minutes: 120 });

	const items = listMonitors();
	expect(items).toHaveLength(2);
	const watch = items.find(i => i.kind === "watch")!;
	expect(watch).toMatchObject({ name: "demo watch", watch: "demo-watch", kind: "watch", channel: "ch:7", last_result: "ok", every: "10분마다", scope: "project", project: "ch:7", project_title: "프로젝트" });
	expect(Date.parse(watch.last_run!)).toBeGreaterThan(0);
	expect(Date.parse(watch.next_run!) - Date.parse(watch.last_run!)).toBe(10 * 60_000);

	const sched = items.find(i => i.kind === "schedule")!;
	expect(sched).toEqual({ name: "주간 보고 정리", schedule: s.id, kind: "schedule", channel: "ch:7", scope: "project", project: "ch:7", project_title: "프로젝트", next_run: s.at, every: "2시간마다" });
});

test("a schedule carries its id, so the web can pause, resume and delete it (PATCH / DELETE /api/schedules/<id>)", () => {
	const s = addSchedule({ text: "메일 연결 확인", in_minutes: 30 });
	expect(listMonitors()).toEqual([{ name: "메일 연결 확인", schedule: s.id, kind: "schedule", scope: "plain", next_run: s.at }]);
	patchSchedule(s.id, { paused: true });
	expect(listMonitors()).toEqual([{ name: "메일 연결 확인", schedule: s.id, kind: "schedule", scope: "plain", paused: true }]);
});

test("a watch carries its own connection, a short last line and a paused flag", async () => {
	const w = addWatch({ name: "line-watch", command: "echo 업데이트 3개", every_minutes: 10 }, "");
	await runWatch(w.id);
	let m = listMonitors().find(i => i.watch === "line-watch")!;
	expect(m).toMatchObject({ connection: "connected", last_result: "ok", last_summary: "업데이트 3개" });
	expect(m.since).toBeUndefined();

	// Paused by the owner: nothing is scheduled, and it says so.
	patchWatch(w.id, { paused: true });
	m = listMonitors().find(i => i.watch === "line-watch")!;
	expect(m).toMatchObject({ paused: true, connection: "connected" });
	expect(m.next_run).toBeUndefined();
});

// Where a monitor is listed (hub/watch-scope.ts): its owner's app, its project, internal housekeeping, else plain.
test("a monitor carries its scope: the app it serves, its project, internal, or plain", async () => {
	addWatch({ name: "reply-library-icloud", label: "첨부 폴더 iCloud 내려받기", command: "echo ok", every_minutes: 10 }, "");
	addWatch({ name: "ch-1-1", command: "echo ok", every_minutes: 10, channels: ["1"] }, "");
	addWatch({ name: "omonyang-housekeeping", command: "echo ok", every_minutes: 10 }, "");
	addWatch({ name: "disk-check", command: "echo ok", every_minutes: 10 }, "");
	const by = (n: string) => listMonitors().find(m => m.watch === n)!;
	expect(by("reply-library-icloud")).toMatchObject({ scope: "app", app: "mail" });
	expect(by("ch-1-1")).toMatchObject({ scope: "project", project: "ch:1", project_title: "프로젝트" });
	expect(by("omonyang-housekeeping")).toMatchObject({ scope: "internal" });
	expect(by("disk-check")).toMatchObject({ scope: "plain" });
	expect(by("disk-check").app).toBeUndefined();
});

// A watch that failed twice is disconnected on its own (hub/watch-status.ts), whatever was alerted; the list says since when and why.
test("two failures in a row read as disconnected with the outage start", async () => {
	const w = addWatch({ name: "flaky-watch", command: "exit 3", every_minutes: 10 }, "");
	await runWatch(w.id);
	await runWatch(w.id);
	const m = listMonitors().find(i => i.watch === "flaky-watch")!;
	expect(m).toMatchObject({ connection: "disconnected", conn_reason: "check", last_result: "fail" });
	expect(m.fails!).toBeGreaterThanOrEqual(2);
	expect(Date.parse(m.since!)).toBeGreaterThan(0);
	expect(m.next_run).toBeDefined();
});

// A paused schedule keeps its row and says it is off; its last run is a success by definition (it fired).
test("a schedule is listed by its short name, never by the commands its text runs", () => {
	addSchedule({ text: "ch:7 피드백 데일리 보고: `ssh -o BatchMode=yes user@100.64.0.2 python3 - 24 < ~/.dotz/projects/feedback/collect.py`로 지난 24시간 메시지를 정리해요.", in_minutes: 60 });
	expect(listMonitors().find(m => m.kind === "schedule")!.name).toBe("피드백 데일리 보고: 지난 24시간 메시지를 정리해요");
});

test("a paused schedule says it is off", () => {
	const s = addSchedule({ text: "ch:7 주간 보고 정리", in_minutes: 60, every_minutes: 120 });
	patchSchedule(s.id, { paused: true });
	const m = listMonitors().find(i => i.kind === "schedule")!;
	expect(m).toMatchObject({ name: "주간 보고 정리", paused: true });
	expect(m.next_run).toBeUndefined();
});

// A one-shot is removed from the hub (memory and file) once it has done its job; a recurring one stays.
test("a one-shot schedule is deleted after it fires and a recurring one is kept", async () => {
	const fired: string[] = [];
	startSchedules(s => fired.push(s.id));
	const once = addSchedule({ text: "ch:7 한 번만", in_minutes: 1 });
	const every = addSchedule({ text: "ch:7 계속", in_minutes: 1, every_minutes: 60 });
	expect(listMonitors().filter(m => m.kind === "schedule")).toHaveLength(2);
	await advance(61_000); // the test clock (hub/runtime/test-clock.ts): both are due, no real wait
	stopSchedules();
	expect(fired.sort()).toEqual([once.id, every.id].sort());
	const names = listMonitors().filter(m => m.kind === "schedule").map(m => m.name);
	expect(names).toEqual(["계속"]);
	const saved = JSON.parse(readFileSync(paths.schedules, "utf8")) as { id: string }[];
	expect(saved.map(s => s.id)).toEqual([every.id]);
	expect(Date.parse(listSchedules()[0]!.at)).toBeGreaterThan(Date.now());
});

test("a one-shot watch is deleted after its first match report and a recurring one is kept", async () => {
	const reports: string[] = [];
	startWatches((w, reason) => reports.push(`${w.name}:${reason}`));
	// each run prints a new number: the once watch matches on its first run, the recurring one on every run after its baseline
	const check = 'f="$DOTZ_WATCH_STATE_DIR/n"; n=$(cat "$f" 2>/dev/null || echo 0); echo $((n + 1)) > "$f"; echo "run $n"';
	const once = addWatch({ name: "gone-after-match", command: check, every_minutes: 60, on: "match", pattern: "run", once: true }, "");
	const every = addWatch({ name: "stays-after-match", command: check, every_minutes: 60, on: "match", pattern: "run" }, "");
	for (let i = 0; i < 3; i++) {
		await runWatch(once.id);
		await runWatch(every.id);
	}
	expect(reports.filter(r => r.startsWith("gone-after-match:"))).toHaveLength(1);
	expect(reports.filter(r => r.startsWith("stays-after-match:")).length).toBeGreaterThanOrEqual(2);
	expect(allWatches().map(w => w.name)).toEqual(["stays-after-match"]);
	expect(listMonitors().filter(m => m.kind === "watch").map(m => m.name)).toEqual(["stays after match"]);
	const saved = JSON.parse(readFileSync(paths.watches, "utf8")) as { name: string }[];
	expect(saved.map(w => w.name)).toEqual(["stays-after-match"]);
	expect(existsSync(paths.watches)).toBe(true);
});
