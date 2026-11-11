// Stale temp folders (owner, 2026-11-11: "this is for the gateway to manage"). Test runs and agents leave folders in the
// OS temp dir (hundreds of thousands on a busy machine) and nothing removed them, so the hourly data cleanup (hygiene.ts)
// calls this sweep. It deletes, by exact path, direct children of two roots only and never matches recursively:
// - <os tmpdir>: a directory of the current user, not a symlink, older than 3 days, named `dotz-test-` + the 6-character
//   mkdtemp suffix, a frozen legacy test prefix + suffix (temp-sweep-prefixes.txt), or a prefix dotz's own code creates and
//   never needs after 3 days (OWNED); files older than 3 days in <tmpdir>/dotz-output-cap and <tmpdir>/dotz-handoff.
// - /tmp: directories named dotz-* older than 7 days (agent scratch: screenshots, probes).
// Left out on purpose: rd- (too generic a name to claim) and dz-sns- (only a test helper makes it), dotz-verify-<id>- (the
// runtime check removes it itself). The data dir, the install dir and the live data dir are never targets and never inside
// a swept root. A pass has a budget (entries and time), so a backlog of 500,000 folders is worked off over days.
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DATA_DIR, log } from "./config.ts";
import { liveDataDir } from "./live-guard.ts";

const DAY = 86_400_000;
const TEST_AGE_MS = 3 * DAY;
const SCRATCH_AGE_MS = 7 * DAY;
const MAX_ENTRIES = 2000;
const MAX_MS = 20_000;
const SUFFIX = /^[A-Za-z0-9]{6}$/;
// Each is created and removed inside one call of non-test code (a failed or killed run leaves it); nothing reads it later.
const OWNED = new Set(["dotz-permprobe-", "dotz-rebase-", "dotz-release-note-", "dotz-sigcheck-", "dotz-smoke-", "dotz-verify-", "dotz-video-", "kakao-dry-"]);
const CAP_DIRS = ["dotz-output-cap", "dotz-handoff"];

type Stat = { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; uid: number; mtimeMs: number };
export type SweepDeps = {
	tmp: string;
	scratch: string;
	dataDir: string;
	installDir: string;
	now: () => number;
	uid: number;
	maxEntries: number;
	maxMs: number;
	lstat: (path: string) => Promise<Stat>;
	readdir: (path: string) => Promise<string[]>;
	rm: (path: string, recursive: boolean) => Promise<void>;
	log: (line: string) => void;
};
export type SweepResult = { removed: number; left: number; failed: number };

const defaults = (): SweepDeps => ({
	tmp: tmpdir(),
	scratch: "/tmp",
	dataDir: DATA_DIR,
	installDir: join(import.meta.dir, ".."),
	now: Date.now,
	uid: process.getuid?.() ?? -1,
	maxEntries: MAX_ENTRIES,
	maxMs: MAX_MS,
	lstat: p => lstat(p),
	readdir: p => readdir(p),
	rm: (p, recursive) => rm(p, { recursive, force: true }),
	log,
});

// Frozen data file (see its first lines): older test runs made these folders; do not extend it for new code.
let prefixes: Promise<Set<string>> | undefined;
const legacyPrefixes = (): Promise<Set<string>> =>
	(prefixes ??= Bun.file(join(import.meta.dir, "temp-sweep-prefixes.txt")).text().then(t => new Set(t.split("\n").map(l => l.trim()).filter(l => !l.startsWith("#") && l.endsWith("-")))));

// The real path; a part that does not exist yet keeps its name under the real path of the nearest existing parent.
async function real(path: string): Promise<string> {
	const abs = resolve(path);
	try {
		return await realpath(abs);
	} catch {
		const up = dirname(abs);
		return up === abs ? abs : join(await real(up), basename(abs));
	}
}
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

type Root = { path: string; scratch: boolean; caps: boolean };

// How old (ms) an entry named `name` must be to go, or undefined when this sweep never touches it.
function maxAge(name: string, legacy: Set<string>, scratch: boolean): number | undefined {
	if (name.length > 6 && SUFFIX.test(name.slice(-6))) {
		const head = name.slice(0, -6);
		if (head === "dotz-test-" || legacy.has(head) || OWNED.has(head)) return TEST_AGE_MS;
	}
	return scratch && name.startsWith("dotz-") && !CAP_DIRS.includes(name) ? SCRATCH_AGE_MS : undefined;
}

export async function sweepTemp(o: Partial<SweepDeps> = {}): Promise<SweepResult> {
	const d = { ...defaults(), ...o };
	const legacy = await legacyPrefixes();
	const protect = await Promise.all([d.dataDir, d.installDir, liveDataDir(d.dataDir) ?? d.dataDir].map(real));
	const res: SweepResult = { removed: 0, left: 0, failed: 0 };
	const start = d.now();
	const spent = () => res.removed + res.failed >= d.maxEntries || d.now() - start >= d.maxMs;
	const mine = (st: Stat, ageMs: number) => st.uid === d.uid && !st.isSymbolicLink() && d.now() - st.mtimeMs > ageMs;
	const stat = async (path: string): Promise<Stat | undefined> => {
		try {
			return await d.lstat(path);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") res.failed++;
			return undefined;
		}
	};
	// Works through `todo` (path, kind of entry, age) until the budget is spent; what is not reached counts as left.
	const work = async (todo: [string, boolean, number][]) => {
		for (let i = 0; i < todo.length; i++) {
			if (spent()) {
				res.left += todo.length - i;
				return;
			}
			const [path, dir, ageMs] = todo[i];
			if (protect.some(p => overlaps(resolve(path), p))) continue;
			const st = await stat(path);
			if (!st || !mine(st, ageMs) || !(dir ? st.isDirectory() : st.isFile())) continue;
			try {
				await d.rm(path, dir);
				res.removed++;
			} catch {
				res.failed++;
			}
		}
	};
	const roots: Root[] = [{ path: await real(d.tmp), scratch: false, caps: true }];
	const scratch = await real(d.scratch);
	if (scratch === roots[0].path) roots[0].scratch = true;
	else roots.push({ path: scratch, scratch: true, caps: false });
	for (const root of roots) {
		if (protect.some(p => overlaps(root.path, p))) continue;
		try {
			if (root.caps)
				for (const name of CAP_DIRS) {
					const dir = join(root.path, name);
					const st = await stat(dir);
					if (!st || !st.isDirectory() || st.isSymbolicLink() || st.uid !== d.uid) continue;
					await work((await d.readdir(dir)).filter(n => n !== "." && n !== ".." && !n.includes("/")).map(n => [join(dir, n), false, TEST_AGE_MS]));
				}
			// One listing per root and pass; only the names that can match are kept.
			const todo: [string, boolean, number][] = [];
			for (const name of await d.readdir(root.path)) {
				const age = name.includes("/") || name.includes(sep) ? undefined : maxAge(name, legacy, root.scratch);
				if (age !== undefined) todo.push([join(root.path, name), true, age]);
			}
			await work(todo);
		} catch {
			res.failed++;
		}
	}
	if (res.removed || res.failed) d.log(`temp sweep: removed ${res.removed} stale temp entries, ${res.left} left for the next pass${res.failed ? `, ${res.failed} failed` : ""}`);
	return res;
}
