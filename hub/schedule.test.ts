// The owner's edit of a schedule (PATCH /api/schedules/<id>): persisted, re-armed, and paused without deleting.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { advance, clock } from "./runtime/test-clock.ts";
import { addSchedule, listSchedules, patchSchedule, removeSchedule, startSchedules } from "./schedule.ts";

const fired: string[] = [];
beforeAll(() => startSchedules(s => fired.push(s.id)));
afterEach(() => {
	for (const s of listSchedules()) removeSchedule(s.id);
	fired.length = 0;
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

test("bad values and unknown ids are refused and change nothing", () => {
	const s = addSchedule({ text: "그대로", in_minutes: 10, every_minutes: 30 });
	const before = JSON.stringify(stored(s.id));
	for (const bad of [{ every_minutes: 0 }, { every_minutes: 10081 }, { every_minutes: 1.5 }, { every_minutes: "5" }, { at: "not a time" }, { text: "  " }, { paused: "yes" }]) expect(() => patchSchedule(s.id, bad)).toThrow();
	expect(JSON.stringify(stored(s.id))).toBe(before);
	expect(() => patchSchedule("nope00", { paused: true })).toThrow("no schedule");
	expect(patchSchedule(s.id, { every_minutes: 10080 }).every_minutes).toBe(10080);
});
