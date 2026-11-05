import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHeavySlot } from "./heavyslot.ts";
import { advance } from "./runtime/test-clock.ts";

let dir = "";
beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "dotz-heavy-")), "heavy");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

test("a second run waits until the first releases the only slot", async () => {
	const first = await acquireHeavySlot({ dir, label: "first", slots: 1 });
	let released = false;
	const second = acquireHeavySlot({ dir, label: "second", slots: 1 }).then(s => ({ s, releasedFirst: released }));
	expect(readFileSync(join(dir, "slot.1"), "utf8")).toContain(" first");
	released = true;
	first.release();
	const { s, releasedFirst } = await second;
	expect(releasedFirst).toBe(true);
	expect(s.note).toContain("held by first");
	expect(readFileSync(join(dir, "slot.1"), "utf8")).toContain(" second");
	s.release();
	expect(readdirSync(dir)).toEqual([]);
});

test("a slot whose holder died is reclaimed at once", async () => {
	const dead = Bun.spawnSync(["true"]).pid;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "slot.1"), `${dead} ${Date.now()} x crashed run`);
	const s = await acquireHeavySlot({ dir, label: "next", slots: 1 });
	expect(s.note).toBeUndefined();
	expect(readFileSync(join(dir, "slot.1"), "utf8")).toContain(" next");
	s.release();
});

test("a wait past its bound gives up and reports it", async () => {
	const held = await acquireHeavySlot({ dir, label: "long", slots: 1 });
	const late = acquireHeavySlot({ dir, label: "late", slots: 1, timeoutMs: 60_000 });
	await advance(60_000);
	const s = await late;
	expect(s.note).toContain("timed out");
	s.release();
	expect(readFileSync(join(dir, "slot.1"), "utf8")).toContain(" long");
	held.release();
});

test("the workers of one run share its slot, and another run waits for the whole run", async () => {
	const run = await acquireHeavySlot({ dir, label: "run", slots: 1, pid: process.pid });
	const worker = await acquireHeavySlot({ dir, label: "worker", slots: 1, pid: process.pid, family: [process.pid] });
	expect(worker.note).toBeUndefined();
	worker.release();   // not the holder: the slot stays
	expect(readFileSync(join(dir, "slot.1"), "utf8")).toContain(" run");
	let sawHolder = "";
	const child = await acquireHeavySlot({ dir, label: "started by the holder", slots: 1, pid: process.ppid, family: [process.ppid, process.pid] });
	expect(child.note).toBeUndefined();
	const other = acquireHeavySlot({ dir, label: "other", slots: 1, pid: process.ppid, family: [process.ppid], onWait: h => { sawHolder = h; } });
	expect(sawHolder).toBe("run");
	run.release();
	(await other).release();
	expect(readdirSync(dir)).toEqual([]);
});
