// The owner's edit of a schedule (PATCH /api/schedules/<id>): persisted, re-armed, and paused without deleting.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { advance, clock } from "./runtime/test-clock.ts";
import { sessionKeyOf } from "./session-key.ts";
import { addSchedule, checksSharingSlot, listScheduleRuns, listSchedules, markScheduleRun, NAME_MAX, patchSchedule, removeSchedule, RUN_KEEP_MS, type ScheduleRun, scheduleTarget, startSchedules } from "./schedule.ts";
import type * as ScheduleModule from "./schedule.ts";

const fired: string[] = [];
// One entry per handler call: the ids of the schedules that call carries.
const turns: string[][] = [];
const runIds: string[][] = [];
beforeAll(() => startSchedules((s, group, runs) => (fired.push(s.id), turns.push((group ?? [s]).map(x => x.id)), runIds.push(runs))));
afterEach(() => {
	for (const s of listSchedules()) removeSchedule(s.id);
	fired.length = 0;
	turns.length = 0;
});
const stored = (id: string) => JSON.parse(readFileSync(paths.schedules, "utf8")).find((s: { id: string }) => s.id === id);

test("an edit of text, time and interval is persisted and the timer follows the new time", async () => {
	const s = addSchedule({ text: "보고", in_minutes: 10 });
	const at = new Date(clock.now + 60 * 60_000).toISOString();
	const edited = patchSchedule(s.id, { text: " 새 보고 ", at, every_minutes: 120 });
	expect(edited).toMatchObject({ id: s.id, text: "새 보고", at, every_minutes: 120 });
	expect(stored(s.id)).toMatchObject({ text: "새 보고", at, every_minutes: 120 });
	await advance(30 * 60_000);
	expect(fired).toEqual([]);
	await advance(31 * 60_000);
	expect(fired).toEqual([s.id]);
	expect(stored(s.id).at).toBe(new Date(Date.parse(at) + 120 * 60_000).toISOString());
});

test("a paused schedule stays listed and persisted but never fires; resuming a recurring one waits for its next slot", async () => {
	const s = addSchedule({ text: "점검", in_minutes: 10, every_minutes: 30 });
	expect(patchSchedule(s.id, { paused: true }).paused).toBe(true);
	expect(stored(s.id).paused).toBe(true);
	await advance(95 * 60_000);
	expect(fired).toEqual([]);
	expect(listSchedules().map(x => x.id)).toEqual([s.id]);
	const resumed = patchSchedule(s.id, { paused: false });
	expect(resumed.paused).toBeUndefined();
	expect(Date.parse(resumed.at)).toBeGreaterThan(clock.now);
	expect(stored(s.id).paused).toBeUndefined();
	await advance(31 * 60_000);
	expect(fired).toEqual([s.id]);
});

test("a recurring timer that fires a few ms before its slot fires once and moves to the next slot", async () => {
	const s = addSchedule({ text: "보고", in_minutes: 10, every_minutes: 30 });
	const slot = Date.parse(s.at);
	const realNow = Date.now;
	Date.now = () => realNow() - 46;
	try {
		await advance(10 * 60_000);
	} finally {
		Date.now = realNow;
	}
	await advance(1000);
	expect(fired).toEqual([s.id]);
	expect(stored(s.id).at).toBe(new Date(slot + 30 * 60_000).toISOString());
});

test("bad values and unknown ids are refused and change nothing", () => {
	const s = addSchedule({ text: "그대로", in_minutes: 10, every_minutes: 30 });
	const before = JSON.stringify(stored(s.id));
	for (const bad of [{ every_minutes: 0 }, { every_minutes: 10081 }, { every_minutes: 1.5 }, { every_minutes: "5" }, { at: "not a time" }, { text: "  " }, { paused: "yes" }]) expect(() => patchSchedule(s.id, bad)).toThrow();
	expect(JSON.stringify(stored(s.id))).toBe(before);
	expect(() => patchSchedule("nope00", { paused: true })).toThrow("no schedule");
	expect(patchSchedule(s.id, { every_minutes: 10080 }).every_minutes).toBe(10080);
});

test("a schedule made in a conversation session fires into that conversation's session, one made in main (or without conv) into main's", async () => {
	const inCh = addSchedule({ text: "채널 일", in_minutes: 10, session: "ch:1" });
	const inMain = addSchedule({ text: "메인 일", in_minutes: 10, session: "main" });
	const plain = addSchedule({ text: "그냥", in_minutes: 10 });
	const named = addSchedule({ text: "지정", in_minutes: 10, project: "th:7" });
	expect(stored(inCh.id).conv).toBe("ch:1");
	expect(stored(named.id).conv).toBe("th:7");
	expect(inMain.conv).toBeUndefined();
	expect(plain.conv).toBeUndefined();
	const rules = { on: true };
	expect(sessionKeyOf(scheduleTarget(inCh, "chat"), rules)).toBe("ch:1");
	expect(sessionKeyOf(scheduleTarget(inMain, "chat"), rules)).toBe("main");
	expect(sessionKeyOf(scheduleTarget(plain, "web"), rules)).toBe("main");
	await advance(11 * 60_000);
	expect(fired.sort()).toEqual([inCh.id, inMain.id, plain.id, named.id].sort());
});

test("a schedule with an unknown conversation kind is rejected", () => {
	expect(() => addSchedule({ text: "x", in_minutes: 10, project: "lane:a" })).toThrow("project must be a conversation target");
	expect(() => addSchedule({ text: "x", in_minutes: 10, conv: "nope" })).toThrow("conv must be a conversation target");
	expect(listSchedules()).toEqual([]);
});

test("an item added without a kind is exactly as before: its own time, its own turn", async () => {
	const a = addSchedule({ text: "그냥", in_minutes: 7 });
	const b = addSchedule({ text: "그냥 둘", in_minutes: 7 });
	expect(a.kind).toBeUndefined();
	expect(stored(a.id).kind).toBeUndefined();
	expect(Date.parse(a.at)).toBe(clock.now + 7 * 60_000);
	await advance(8 * 60_000);
	expect(turns.map(t => t.length)).toEqual([1, 1]);
	expect(fired.sort()).toEqual([a.id, b.id].sort());
});

test("a one-shot check is rounded up to the next :00 or :30, never earlier; an owner item keeps its time", () => {
	const asked = clock.now + 7 * 60_000;
	const check = addSchedule({ text: "점검", in_minutes: 7, kind: "check" });
	const at = new Date(check.at);
	expect(at.getTime()).toBeGreaterThanOrEqual(asked);
	expect(at.getTime() - asked).toBeLessThan(30 * 60_000);
	expect(at.getMinutes() % 30).toBe(0);
	expect(at.getSeconds() + at.getMilliseconds()).toBe(0);
	const onGrid = addSchedule({ text: "정각", at: check.at, kind: "check" });
	expect(onGrid.at).toBe(check.at);
	expect(addSchedule({ text: "알림", in_minutes: 7, kind: "owner" }).at).toBe(new Date(asked).toISOString());
	expect(() => addSchedule({ text: "x", in_minutes: 7, kind: "loud" })).toThrow("kind must be");
});

test("checks of one conversation due in the same slot fire as one turn; another conversation and an owner item keep their own", async () => {
	const a = addSchedule({ text: "하나", in_minutes: 7, kind: "check" });
	const b = addSchedule({ text: "둘", at: new Date(Date.parse(a.at) - 60_000).toISOString(), kind: "check" }); // a minute before a's slot: rounds up to it
	const other = addSchedule({ text: "다른 대화", in_minutes: 7, kind: "check", session: "ch:1" });
	const owner = addSchedule({ text: "알림", in_minutes: 7, kind: "owner" });
	expect(a.at).toBe(b.at);
	expect(checksSharingSlot(b)).toEqual([a.id]);
	await advance(40 * 60_000);
	expect(turns.map(t => [...t].sort())).toEqual(expect.arrayContaining([[a.id, b.id].sort(), [other.id], [owner.id]]));
	expect(turns).toHaveLength(3);
	expect(listSchedules()).toEqual([]);
});

test("a recurring check in a merged turn steps to its next slot and the others leave", async () => {
	const once = addSchedule({ text: "한 번", in_minutes: 7, kind: "check" });
	const every = addSchedule({ text: "반복", at: once.at, every_minutes: 60, kind: "check" });
	await advance(40 * 60_000);
	expect(turns).toHaveLength(1);
	expect(turns[0]!.sort()).toEqual([once.id, every.id].sort());
	expect(listSchedules().map(s => s.id)).toEqual([every.id]);
	expect(Date.parse(listSchedules()[0]!.at)).toBe(Date.parse(once.at) + 60 * 60_000);
});

test("PATCH changes the kind and refuses an unknown one", () => {
	const s = addSchedule({ text: "알림", in_minutes: 7 });
	expect(patchSchedule(s.id, { kind: "check" }).kind).toBe("check");
	expect(stored(s.id).kind).toBe("check");
	expect(() => patchSchedule(s.id, { kind: "quiet" })).toThrow("kind must be");
	expect(patchSchedule(s.id, { text: "고침" }).kind).toBe("check");
});

test("a name is trimmed, kept on one line and cut at NAME_MAX; a blank one is refused; with none the text names it", () => {
	const s = addSchedule({ name: "  sample-2\n 보고  ", kind: "task", text: "x", in_minutes: 7 });
	expect(stored(s.id)).toMatchObject({ name: "sample-2 보고", kind: "task" });
	expect(addSchedule({ name: "가".repeat(NAME_MAX + 9), text: "x", in_minutes: 7 }).name).toBe("가".repeat(NAME_MAX));
	for (const name of ["", "   ", 7]) expect(() => addSchedule({ name, text: "x", in_minutes: 7 })).toThrow("name must be");
	expect(addSchedule({ text: "sample-2 회의 알려 줘", in_minutes: 7 }).name).toBe("sample-2 회의 알려 줘");
	expect(patchSchedule(s.id, { name: " sample-3 " }).name).toBe("sample-3");
	expect(() => patchSchedule(s.id, { name: " " })).toThrow("name must be");
	expect(stored(s.id).name).toBe("sample-3");
});

test("a fire keeps a run record past the one-shot's deletion and a restart, hands its id to the handler, and drops it after 7 days", async () => {
	const s = addSchedule({ name: "sample-2", kind: "task", text: "sample-2 보고해", in_minutes: 7 });
	await advance(8 * 60_000);
	expect(listSchedules()).toEqual([]);
	const [run] = runIds.at(-1)!;
	const record: ScheduleRun = { run: run!, scheduleId: s.id, name: "sample-2", kind: "task", text: "sample-2 보고해", firedAt: new Date(Date.parse(s.at)).toISOString(), state: "fired" };
	expect(listScheduleRuns().filter(r => r.scheduleId === s.id)).toEqual([record]);
	expect(markScheduleRun(run!, "answered")).toMatchObject({ run, state: "answered" });
	const fresh = "./schedule.ts?runs-restart";
	const restarted: typeof ScheduleModule = await import(fresh);
	expect(restarted.listScheduleRuns().filter(r => r.scheduleId === s.id)).toEqual([{ ...record, state: "answered" }]);
	await advance(RUN_KEEP_MS);
	expect(listScheduleRuns().some(r => r.scheduleId === s.id)).toBe(false);
	expect(markScheduleRun(run!, "failed")).toBeUndefined();
	addSchedule({ name: "sample-3", text: "x", in_minutes: 1 });
	await advance(2 * 60_000);
	expect(JSON.parse(readFileSync(paths.scheduleRuns, "utf8")).some((r: { scheduleId: string }) => r.scheduleId === s.id)).toBe(false);
});

test("each check of a merged turn gets its own run id, in the order of the group", async () => {
	const a = addSchedule({ name: "sample-2", text: "하나", in_minutes: 7, kind: "check" });
	const b = addSchedule({ name: "sample-3", text: "둘", at: a.at, kind: "check" });
	await advance(40 * 60_000);
	expect(turns.at(-1)).toEqual([a.id, b.id]);
	const runs = runIds.at(-1)!;
	expect(new Set(runs).size).toBe(2);
	expect(runs.map(r => listScheduleRuns().find(x => x.run === r)?.scheduleId)).toEqual([a.id, b.id]);
});
