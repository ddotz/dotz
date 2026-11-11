import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger, type Ledger } from "./ledger.ts";
import { dueNotices, runTick } from "./ledger-tick.ts";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
let dir: string, file: string, clock: number;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-ledger-tick-"));
	file = join(dir, "ledger.json");
	clock = at(10, 9);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const source = { kind: "conversation" as const, ref: "main" };
function rig(delivered = true) {
	const store: Ledger = createLedger({ file, now: () => clock });
	const sent: { text: string; project?: string }[] = [];
	const deps = { store, now: () => clock, morning: () => "08:00", log: () => undefined, send: (text: string, project?: string) => (sent.push({ text, project }), { delivered }) };
	return { store, sent, deps };
}

describe("day before", () => {
	test("an item due tomorrow is told once, from 18:00", async () => {
		const r = rig();
		r.store.add({ what: "WHAT-A", source, due: "2026-11-11" });
		clock = at(10, 17, 59);
		await runTick(r.deps);
		expect(r.sent).toHaveLength(0);
		clock = at(10, 18);
		await runTick(r.deps);
		expect(r.sent).toHaveLength(1);
		expect(r.sent[0]!.text).toContain("WHAT-A");
		clock = at(10, 19);
		await runTick(r.deps);
		expect(r.sent).toHaveLength(1);
		expect(r.store.list()[0]!.told?.before).toBeDefined();
		expect(r.store.list()[0]!.told?.morning).toBeUndefined();
	});

	test("several items at one tick are one message, to the project they all belong to", async () => {
		const r = rig();
		r.store.add({ what: "WHAT-A", source: { kind: "mail", ref: "m1", project: "ch:100" }, due: "2026-11-11" });
		r.store.add({ what: "WHAT-B", source: { kind: "mail", ref: "m2", project: "ch:100" }, due: "2026-11-11" });
		clock = at(10, 18);
		await runTick(r.deps);
		expect(r.sent).toHaveLength(1);
		expect(r.sent[0]!.text).toContain("WHAT-A");
		expect(r.sent[0]!.text).toContain("WHAT-B");
		expect(r.sent[0]!.project).toBe("ch:100");
		r.store.add({ what: "WHAT-C", source, due: "2026-11-11" });
		r.store.add({ what: "WHAT-D", source: { kind: "mail", ref: "m3", project: "ch:100" }, due: "2026-11-11" });
		await runTick(r.deps);
		expect(r.sent).toHaveLength(2);
		expect(r.sent[1]!.project).toBeUndefined();
	});

	test("done and cancelled items never notify", async () => {
		const r = rig();
		const a = r.store.add({ what: "WHAT-A", source, due: "2026-11-11" }), b = r.store.add({ what: "WHAT-B", source, due: "2026-11-09" });
		r.store.done(a.id);
		r.store.cancel(b.id);
		clock = at(10, 18);
		await runTick(r.deps);
		clock = at(11, 12);
		await runTick(r.deps);
		expect(r.sent).toHaveLength(0);
	});

	test("a send that is not delivered leaves no mark, so the next tick tries again", async () => {
		const r = rig(false);
		r.store.add({ what: "WHAT-A", source, due: "2026-11-11" });
		clock = at(10, 18);
		await runTick(r.deps);
		expect(r.store.list()[0]!.told).toBeUndefined();
		const again = rig(true);
		await runTick(again.deps);
		expect(again.sent).toHaveLength(1);
	});

	test("marks survive a reload of the store: a restart tells nothing twice", async () => {
		const first = rig();
		first.store.add({ what: "WHAT-A", source, due: "2026-11-11" });
		clock = at(10, 18);
		await runTick(first.deps);
		const second = rig();
		clock = at(10, 20);
		await runTick(second.deps);
		expect(first.sent).toHaveLength(1);
		expect(second.sent).toHaveLength(0);
	});
});

describe("late and quiet hours", () => {
	test("an item whose morning was missed is told late exactly once, on the first tick after the morning time", async () => {
		const r = rig();
		clock = at(9, 20);
		const a = r.store.add({ what: "WHAT-A", source, due: "2026-11-10" });
		r.store.add({ what: "WHAT-B", source, due: "2026-11-05" });
		clock = at(10, 11);
		await runTick(r.deps);
		expect(r.sent).toHaveLength(1);
		expect(r.sent[0]!.text).toContain("WHAT-A");
		expect(r.sent[0]!.text).toContain("WHAT-B");
		const told = r.store.list().find(x => x.id === a.id)!.told!;
		expect(told.before).toBeDefined();
		expect(told.morning).toBeDefined();
		clock = at(10, 11, 5);
		await runTick(r.deps);
		clock = at(11, 9);
		await runTick(r.deps);
		expect(r.sent).toHaveLength(1);
	});

	test("an item added after today's morning time is not late; it waits for the next morning", () => {
		const r = rig();
		clock = at(10, 10);
		r.store.add({ what: "WHAT-A", source, due: "2026-11-10" });
		expect(dueNotices(r.store.list(), at(10, 12), { morning: "08:00" }).late).toHaveLength(0);
	});

	test("nothing is sent from 22:00 until the morning time, then the waiting items go in one message", async () => {
		const r = rig();
		clock = at(9, 12);
		r.store.add({ what: "WHAT-A", source, due: "2026-11-10" });
		r.store.add({ what: "WHAT-B", source, due: "2026-11-11" });
		for (const when of [at(10, 22), at(10, 23, 30), at(11, 3), at(11, 7, 59), at(11, 8, 5)]) {
			clock = when;
			await runTick(r.deps);
		}
		expect(r.sent).toHaveLength(0);
		clock = at(11, 8, 10);
		await runTick(r.deps);
		expect(r.sent).toHaveLength(1);
		expect(r.sent[0]!.text).toContain("WHAT-A");
	});

	test("the quiet hours end at the morning time that is given", () => {
		const r = rig();
		clock = at(9, 12);
		r.store.add({ what: "WHAT-A", source, due: "2026-11-10" });
		const late = (hour: number, minute: number, morning: string) => dueNotices(r.store.list(), at(10, hour, minute), { morning }).late.length;
		expect(late(8, 45, "09:00")).toBe(0);
		expect(late(9, 15, "09:00")).toBe(1);
		expect(late(8, 45, "08:00")).toBe(1);
	});
});
