import { afterAll, expect, test } from "bun:test";
import { listMonitors } from "./monitors.ts";
import { addSchedule, listSchedules, removeSchedule } from "./schedule.ts";
import { addWatch, allWatches, removeWatch, runWatch } from "./watch.ts";

afterAll(() => {
	for (const w of allWatches()) removeWatch(w.id);
	for (const s of listSchedules()) removeSchedule(s.id);
});

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
	expect(watch).toMatchObject({ name: "demo-watch", kind: "watch", channel: "ch:7", last_result: "ok", every: "10분마다" });
	expect(Date.parse(watch.last_run!)).toBeGreaterThan(0);
	expect(Date.parse(watch.next_run!) - Date.parse(watch.last_run!)).toBe(10 * 60_000);

	const sched = items.find(i => i.kind === "schedule")!;
	expect(sched).toEqual({ name: "주간 보고 정리", kind: "schedule", channel: "ch:7", next_run: s.at, every: "2시간마다" });
});
