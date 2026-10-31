import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { routeLanes } from "./routes-lanes.ts";
import { localTime, readScheduleSettings, SCHEDULE_FIELDS, writeScheduleSettings } from "./schedule-settings.ts";
import { addSchedule, listSchedules, removeSchedule, startSchedules } from "./schedule.ts";

// A schedule's settings screen uses the watch settings' schema format; the one write path ends in patchSchedule.
beforeAll(() => startSchedules(() => {}));
afterEach(() => { for (const s of listSchedules()) removeSchedule(s.id); });
const stored = (id: string) => JSON.parse(readFileSync(paths.schedules, "utf8")).find((s: { id: string }) => s.id === id);
const val = (id: string) => Object.fromEntries(readScheduleSettings(id).map(f => [f.key, f.value]));
const call = async (method: string, path: string, body?: unknown) => {
	const url = new URL(`http://hub${path}`);
	const res = await routeLanes(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), url, url.pathname.split("/").filter(Boolean));
	return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
};

test("the fields read the schedule's own values, the words without its internal target", () => {
	const s = addSchedule({ text: "ch:123 아침 보고 써 줘", in_minutes: 60, every_minutes: 1440 });
	expect(val(s.id)).toEqual({ enabled: true, at: localTime(s.at), every_minutes: 1440, text: "아침 보고 써 줘" });
	expect(SCHEDULE_FIELDS.map(f => [f.key, f.section])).toEqual([["enabled", "watch"], ["at", "watch"], ["every_minutes", "watch"], ["text", "advanced"]]);
});

test("one write pauses, moves, repeats and rewords it; the target stays and 0 makes it one-shot", () => {
	const s = addSchedule({ text: "ch:123 보고", in_minutes: 60, every_minutes: 30 });
	const next = new Date(Date.now() + 3 * 3600_000);
	next.setSeconds(0, 0);
	writeScheduleSettings(s.id, { enabled: false, at: localTime(next.toISOString()), every_minutes: 120, text: " 저녁 보고 " });
	expect(stored(s.id)).toMatchObject({ paused: true, at: next.toISOString(), every_minutes: 120, text: "ch:123 저녁 보고" });
	writeScheduleSettings(s.id, { enabled: true, every_minutes: 0 });
	expect(stored(s.id).paused).toBeUndefined();
	expect(stored(s.id).every_minutes).toBeUndefined();
	expect(val(s.id).every_minutes).toBe(0);
});

test("bad values are refused and change nothing", () => {
	const s = addSchedule({ text: "그대로", in_minutes: 60, every_minutes: 30 });
	const before = JSON.stringify(stored(s.id));
	for (const bad of [{ every_minutes: 3 }, { every_minutes: 10081 }, { at: "내일 아침" }, { text: "  " }, { enabled: "yes" }, { nope: 1 }]) expect(() => writeScheduleSettings(s.id, bad)).toThrow();
	expect(JSON.stringify(stored(s.id))).toBe(before);
	expect(() => readScheduleSettings("nope00")).toThrow("no schedule");
});

test("GET / PATCH /api/schedules/<id>/settings answer the settings shape; an unknown id is 404", async () => {
	const s = addSchedule({ text: "점검", in_minutes: 60 });
	const got = await call("GET", `/api/schedules/${s.id}/settings`);
	expect(got.status).toBe(200);
	expect(got.body.key).toBe(`s:${s.id}`);
	const patched = await call("PATCH", `/api/schedules/${s.id}/settings`, { values: { enabled: false } });
	expect((patched.body.fields as { key: string; value: unknown }[]).find(f => f.key === "enabled")!.value).toBe(false);
	expect(stored(s.id).paused).toBe(true);
	expect((await call("PATCH", `/api/schedules/${s.id}/settings`, { values: { every_minutes: 2 } })).status).toBe(400);
	expect((await call("GET", "/api/schedules/nope00/settings")).status).toBe(404);
});
