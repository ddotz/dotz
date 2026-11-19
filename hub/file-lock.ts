// OmO's file lock, as proper-lockfile writes it: the lock is the directory `<file>.lock`; one older than 30 s (mtime) is stale and
// taken over, and a caller waits at most 1 s (synchronously) before giving up. Used where dotz edits OmO's auth.json
// (omo-pin.ts, accounts-providers.ts). Only node:fs, so any layer can load it.
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_STALE_MS = 30_000;
const LOCK_BUDGET_MS = 1_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

function ageOf(path: string): number | undefined {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch (e) {
		if (errno(e) === "ENOENT") return undefined;
		throw e;
	}
}

function removeDir(path: string): void {
	try {
		rmdirSync(path);
	} catch (e) {
		if (errno(e) !== "ENOENT") throw e;
	}
}

function removeStaleUnderGuard(dir: string): boolean {
	const guard = `${dir}.takeover`;
	try {
		mkdirSync(guard);
	} catch (e) {
		if (errno(e) !== "EEXIST") throw e;
		if ((ageOf(guard) ?? 0) > LOCK_STALE_MS) removeDir(guard);
		return false;
	}
	try {
		const age = ageOf(dir);
		if (age === undefined) return true;
		if (age <= LOCK_STALE_MS) return false;
		removeDir(dir);
		return true;
	} finally {
		removeDir(guard);
	}
}

/** How long a caller waits for the lock and what the error names when it gives up (`<what> 파일이 ...ms 동안 잠겨 있어요`). */
export type LockOpts = { budgetMs?: number; what?: string };

/**
 * Takes the lock on `file` and returns the function that releases it. A stale lock is removed only while holding `<file>.lock.takeover` and after its
 * age is read again inside that guard, so two waiters that both saw it stale never both remove it (the second would remove the first one's fresh lock).
 * A guard left by a waiter that died in it is removed once it is stale itself, and that pass removes no lock.
 */
export function lock(file: string, { budgetMs = LOCK_BUDGET_MS, what = "OmO의 계정" }: LockOpts = {}): () => void {
	const dir = `${file}.lock`;
	const started = Date.now();
	for (let attempt = 0; ; attempt++) {
		try {
			mkdirSync(dir);
			return () => {
				try {
					rmdirSync(dir);
				} catch {}
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const age = ageOf(dir);
		if (age === undefined || (age > LOCK_STALE_MS && removeStaleUnderGuard(dir))) continue;
		const waited = Date.now() - started;
		if (waited >= budgetMs) throw new Error(`${what} 파일이 ${waited}ms 동안 잠겨 있어요 (${dir})`);
		sleep(Math.min(100 * 2 ** attempt, 1000, budgetMs - waited));
	}
}

/** Runs `fn` holding the cross-process lock on `file` (its directory is made first), and releases it however `fn` ends. */
export function withLock<T>(file: string, what: string, fn: () => T): T {
	mkdirSync(dirname(file), { recursive: true });
	const release = lock(file, { budgetMs: 10_000, what });
	try {
		return fn();
	} finally {
		release();
	}
}
