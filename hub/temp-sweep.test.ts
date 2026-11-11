// The hourly temp sweep (hub/temp-sweep.ts): roots, clock and budget are injected, every fixture lives in this test's own temp dir.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sweepTemp, sweepTempRepeating, type SweepDeps } from "./temp-sweep.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const DAY = 86_400_000;
let base = "";
let lines: string[] = [];
const dir = (...p: string[]) => join(base, ...p);
const old = (path: string, days: number) => utimesSync(path, new Date(NOW - days * DAY), new Date(NOW - days * DAY));
const made = (path: string, days: number, kind: "dir" | "file" = "dir") => {
	mkdirSync(kind === "dir" ? path : dirname(path), { recursive: true });
	if (kind === "file") writeFileSync(path, "x");
	old(path, days);
	return path;
};
const sweepArgs = (o: Partial<SweepDeps> = {}): Partial<SweepDeps> => ({ tmp: dir("tmp"), scratch: dir("scratch"), dataDir: dir("data"), installDir: dir("install"), log: l => lines.push(l), ...o });
const sweep = (o: Partial<SweepDeps> = {}) => sweepTemp({ tmp: dir("tmp"), scratch: dir("scratch"), dataDir: dir("data"), installDir: dir("install"), now: () => NOW, log: l => lines.push(l), ...o });

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "dotz-sweep-fixture-"));
	for (const d of ["tmp", "scratch", "data", "install"]) mkdirSync(dir(d));
	lines = [];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("an old dotz-test dir, a frozen legacy prefix dir and a dir of a prefix dotz owns are removed with their content", async () => {
	const test = made(dir("tmp", "dotz-test-aB3dE9"), 4);
	writeFileSync(join(test, "file"), "x");
	old(test, 4);
	const legacy = made(dir("tmp", "dotz-cleanup-Zz09aa"), 5);
	const owned = made(dir("tmp", "dotz-smoke-q1w2e3"), 4);
	const r = await sweep();
	expect([existsSync(test), existsSync(legacy), existsSync(owned)]).toEqual([false, false, false]);
	expect(r).toEqual({ removed: 3, left: 0, failed: 0 });
	expect(lines).toEqual(["temp sweep: removed 3 stale temp entries, 0 left for the next pass"]);
});

test("young dirs, symlinks, longer suffixes, other users, other names and plain files stay", async () => {
	const keep = [
		made(dir("tmp", "dotz-test-long1234"), 9),
		made(dir("tmp", "dotz-test-other1"), 9),
		made(dir("tmp", "unrelated-abc123"), 9),
		made(dir("tmp", "dotz-test-file12"), 9, "file"),
		made(dir("tmp", "rd-abc123"), 9),
		made(dir("tmp", "dotz-verify-omp-abc123"), 9),
	];
	made(dir("tmp", "dotz-test-young1"), 1);
	const target = made(dir("elsewhere"), 9);
	symlinkSync(target, dir("tmp", "dotz-test-link12"));
	lutimesSync(dir("tmp", "dotz-test-link12"), new Date(NOW - 9 * DAY), new Date(NOW - 9 * DAY));
	keep.push(dir("tmp", "dotz-test-link12"), target, dir("tmp", "dotz-test-young1"));
	const foreign = async (p: string) => {
		const st = await lstat(p);
		return p.endsWith("dotz-test-other1") ? { isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), isSymbolicLink: () => st.isSymbolicLink(), uid: st.uid + 1, mtimeMs: st.mtimeMs } : st;
	};
	const r = await sweep({ lstat: foreign });
	expect(keep.filter(p => !existsSync(p))).toEqual([]);
	expect(r.removed).toBe(0);
	expect(lines).toEqual([]);
});

test("a root that is the data dir, holds it, or holds the install dir is not swept", async () => {
	const victim = made(dir("tmp", "dotz-test-abc123"), 9);
	await sweep({ dataDir: dir("tmp") });
	await sweep({ dataDir: dir("tmp", "dotz-test-abc123", "data") });
	await sweep({ installDir: dir("tmp", "deep", "install") });
	expect(existsSync(victim)).toBe(true);
});

test("an entry that is the data dir, the install dir or holds one is never a target", async () => {
	const data = made(dir("tmp", "dotz-test-data12"), 9);
	const install = made(dir("tmp", "dotz-test-inst12"), 9);
	const holder = made(dir("tmp", "dotz-test-hold12"), 9);
	mkdirSync(join(holder, "data"));
	await sweep({ dataDir: data, installDir: install });
	await sweep({ dataDir: join(holder, "data"), installDir: dir("install") });
	expect([existsSync(data), existsSync(install), existsSync(holder)]).toEqual([true, true, true]);
});

test("scratch: dotz-* dirs older than 7 days go; younger ones, other names and files stay", async () => {
	const gone = made(dir("scratch", "dotz-shots"), 8);
	const young = made(dir("scratch", "dotz-probe"), 5);
	const other = made(dir("scratch", "notes"), 30);
	const file = made(dir("scratch", "dotz-dry-run.jsonl"), 30, "file");
	const r = await sweep();
	expect([existsSync(gone), existsSync(young), existsSync(other), existsSync(file)]).toEqual([false, true, true, true]);
	expect(r.removed).toBe(1);
});

// A /tmp/dotz-* folder is as old as the newest thing in it: a file rewritten in place does not move the folder's own mtime.
test("scratch: an old folder with a fresh file inside stays; an all-old one goes", async () => {
	const fresh = made(dir("scratch", "dotz-rewritten"), 9);
	made(join(fresh, "deep", "big.bin"), 1, "file");
	old(join(fresh, "deep"), 9);
	old(fresh, 9);
	const stale = made(dir("scratch", "dotz-stale"), 9);
	made(join(stale, "deep", "a.png"), 8, "file");
	old(join(stale, "deep"), 9);
	old(stale, 9);
	const r = await sweep();
	expect([existsSync(fresh), existsSync(stale)]).toEqual([true, false]);
	expect(r.removed).toBe(1);
});

test("scratch: the walk stops at the first newer entry and never visits more than its bound; a bound hit falls back to twice the age", async () => {
	const calls: string[] = [];
	const recorded = { lstat: async (p: string) => (calls.push(p), lstat(p)) };
	const big = made(dir("scratch", "dotz-huge"), 9);
	for (let i = 0; i < 2_100; i++) writeFileSync(join(big, `f${i}`), "x");
	for (let i = 0; i < 2_100; i++) old(join(big, `f${i}`), 9);
	old(big, 9);
	let r = await sweep(recorded);
	expect(existsSync(big)).toBe(true); // 9 days: bound hit, own mtime younger than twice the age
	expect(r.removed).toBe(0);
	expect(calls.filter(p => p.startsWith(`${realpathSync(big)}/`)).length).toBe(2_000);
	old(big, 15);
	calls.length = 0;
	r = await sweep(recorded);
	expect(existsSync(big)).toBe(false); // never immortal
	expect(r.removed).toBe(1);

	const early = made(dir("scratch", "dotz-early"), 9);
	for (let i = 0; i < 50; i++) made(join(early, `o${i}`), 9, "file");
	made(join(early, "new"), 1, "file");
	old(early, 9);
	calls.length = 0;
	await sweep({ ...recorded, readdir: async p => (p === realpathSync(early) ? ["new", ...(await readdir(p)).filter(n => n !== "new")] : readdir(p)) });
	expect(existsSync(early)).toBe(true);
	expect(calls.filter(p => p.startsWith(`${realpathSync(early)}/`))).toEqual([join(realpathSync(early), "new")]);
});

test("old files in dotz-output-cap and dotz-handoff go, the folders and young files stay", async () => {
	const oldCap = made(dir("tmp", "dotz-output-cap", "a.txt"), 4, "file");
	const youngCap = made(dir("tmp", "dotz-output-cap", "b.txt"), 1, "file");
	const oldHand = made(dir("tmp", "dotz-handoff", "s.md"), 10, "file");
	const midHand = made(dir("tmp", "dotz-handoff", "m.md"), 5, "file"); // handoff files live 7 days, spill files 3
	old(dir("tmp", "dotz-output-cap"), 30);
	old(dir("tmp", "dotz-handoff"), 30);
	await sweep({ scratch: dir("tmp") });
	expect([existsSync(oldCap), existsSync(youngCap), existsSync(oldHand), existsSync(midHand)]).toEqual([false, true, false, true]);
	expect(existsSync(dir("tmp", "dotz-output-cap"))).toBe(true);
	expect(existsSync(dir("tmp", "dotz-handoff"))).toBe(true);
});

test("the budget stops a pass and the next pass continues; a pass with nothing to do logs nothing", async () => {
	const all = ["a1b2c3", "d4e5f6", "g7h8i9", "j1k2l3", "m4n5o6"].map(s => made(dir("tmp", `dotz-test-${s}`), 4));
	const gone = () => all.filter(p => !existsSync(p)).length;
	expect(await sweep({ maxEntries: 2 })).toEqual({ removed: 2, left: 3, failed: 0 });
	expect(gone()).toBe(2);
	expect(await sweep({ maxEntries: 2 })).toEqual({ removed: 2, left: 1, failed: 0 });
	expect(await sweep({ maxEntries: 2 })).toEqual({ removed: 1, left: 0, failed: 0 });
	expect(gone()).toBe(5);
	expect(lines).toEqual([
		"temp sweep: removed 2 stale temp entries, 3 left for the next pass",
		"temp sweep: removed 2 stale temp entries, 1 left for the next pass",
		"temp sweep: removed 1 stale temp entries, 0 left for the next pass",
	]);
	await sweep({ maxEntries: 2 });
	expect(lines.length).toBe(3);
});

test("a failing delete is counted once in the pass line and does not stop the pass", async () => {
	made(dir("tmp", "dotz-test-bad123"), 4);
	made(dir("tmp", "dotz-test-ok1234"), 4);
	const r = await sweep({ rm: async (p, recursive) => (p.endsWith("bad123") ? Promise.reject(new Error("EACCES")) : rmSync(p, { recursive, force: true })) });
	expect(r).toEqual({ removed: 1, left: 0, failed: 1 });
	expect(lines).toEqual(["temp sweep: removed 1 stale temp entries, 0 left for the next pass, 1 failed"]);
});

// Fake file calls: `n` stale dotz-test dirs in the injected tmp root, nothing on disk; `tick` ms pass per delete.
const fake = (n: number, tick = 0, rm: SweepDeps["rm"] = async () => {}) => {
	let clock = NOW;
	const names = Array.from({ length: n }, (_, i) => `dotz-test-${i.toString(36).padStart(6, "0")}`);
	const stat = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, uid: 1, mtimeMs: NOW - 4 * DAY };
	return {
		uid: 1,
		now: () => clock,
		readdir: async (p: string) => (p.endsWith("tmp") ? names : []),
		lstat: async (p: string) => (/dotz-test-/.test(p) ? stat : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))),
		rm: async (p: string, recursive: boolean) => {
			clock += tick;
			await rm(p, recursive);
		},
	};
};

test("with the default budget a pass removes far more than 2,000 entries when time allows; the entry ceiling still stops a runaway pass", async () => {
	expect(await sweep(fake(10_000))).toEqual({ removed: 10_000, left: 0, failed: 0 });
	const r = await sweep(fake(60_000));
	expect(r.removed).toBe(50_000);
	expect(r.left).toBe(10_000);
});

test("the time limit still stops a pass past the old entry cap and reports what is left", async () => {
	const r = await sweep(fake(30_000, 1));
	expect(r).toEqual({ removed: 20_000, left: 10_000, failed: 0 });
	expect(lines).toEqual(["temp sweep: removed 20000 stale temp entries, 10000 left for the next pass"]);
});

test("a pass with entries left schedules one follow-up in 5 minutes, a finished pass none, and two passes never overlap", async () => {
	const timers: { fn: () => void; ms: number }[] = [];
	const schedule = (fn: () => void, ms: number) => (timers.push({ fn, ms }), setTimeout(() => {}, 0));
	await sweepTempRepeating(sweepArgs(fake(30_000, 1)), schedule);
	expect(timers.map(t => t.ms)).toEqual([300_000]);
	await sweepTempRepeating(sweepArgs(fake(100, 1)), schedule); // the pass that finishes
	expect(timers.length).toBe(1);

	let running = 0;
	let peak = 0;
	let release = () => {};
	const gate = new Promise<void>(r => (release = r));
	const slow = fake(3, 0, async () => {
		peak = Math.max(peak, ++running);
		await gate;
		running--;
	});
	const first = sweepTempRepeating(sweepArgs(slow), schedule);
	await sweepTempRepeating(sweepArgs(slow), schedule); // second call while the first runs: skipped
	release();
	await first;
	expect(peak).toBe(1);
});
