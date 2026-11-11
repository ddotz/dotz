// The hourly temp sweep (hub/temp-sweep.ts): roots, clock and budget are injected, every fixture lives in this test's own temp dir.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sweepTemp, type SweepDeps } from "./temp-sweep.ts";

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

test("old files in dotz-output-cap and dotz-handoff go, the folders and young files stay", async () => {
	const oldCap = made(dir("tmp", "dotz-output-cap", "a.txt"), 4, "file");
	const youngCap = made(dir("tmp", "dotz-output-cap", "b.txt"), 1, "file");
	const oldHand = made(dir("tmp", "dotz-handoff", "s.md"), 10, "file");
	old(dir("tmp", "dotz-output-cap"), 30);
	old(dir("tmp", "dotz-handoff"), 30);
	await sweep({ scratch: dir("tmp") });
	expect([existsSync(oldCap), existsSync(youngCap), existsSync(oldHand)]).toEqual([false, true, false]);
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
