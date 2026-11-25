import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { harnessDir } from "../agent-home.ts";

const STALE_MS = 60_000;
const STEP_MS = 100;

/** The directory folder locks live in: HARNESS_SLOTS_DIR (tests), else `<harness>/state/main-slots`. */
export const mainSlotsDir = (): string => process.env.HARNESS_SLOTS_DIR ?? join(harnessDir(), "state", "main-slots");

/** The lock directory of a folder: `<mainSlotsDir()>/<first 16 hex of sha1(real path of folder)>.lock`. */
export function lockPathOf(folder: string): string {
	let real: string;
	try {
		real = realpathSync(folder);
	} catch {
		real = resolve(folder);
	}
	return join(mainSlotsDir(), `${createHash("sha1").update(real).digest("hex").slice(0, 16)}.lock`);
}

/** The folder lock was taken and `work` ran (`value` is its result), or it was not taken and `work` never ran. */
export type LockResult<T> = { readonly acquired: true; readonly value: T } | { readonly acquired: false; readonly why: string };

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function pidOf(lock: string): string | undefined {
	try {
		return readFileSync(join(lock, "pid"), "utf8").trim();
	} catch {
		return undefined;
	}
}

function isStale(lock: string, pid: string | undefined): boolean {
	const n = Number(pid);
	if (pid !== undefined && Number.isInteger(n) && n > 0 && !alive(n)) return true;
	try {
		return Date.now() - statSync(lock).mtimeMs > STALE_MS;
	} catch {
		return false;
	}
}

/**
 * Breaks `lock` when its holder's pid is dead or the lock is older than 60 s: renames it to `<lock>.dead.<this pid>` and removes it. True only for the caller whose rename succeeded, so of two breakers exactly one gets true.
 * A lock the holder released and someone else re-took between the check and the rename is renamed back when that is still possible.
 */
export function breakStaleLock(lock: string): boolean {
	const seen = pidOf(lock);
	if (!isStale(lock, seen)) return false;
	const dead = `${lock}.dead.${process.pid}`;
	try {
		renameSync(lock, dead);
	} catch {
		return false;
	}
	if (pidOf(dead) !== seen) {
		try {
			renameSync(dead, lock);
			return false;
		} catch {
			rmSync(dead, { recursive: true, force: true });
			return true;
		}
	}
	rmSync(dead, { recursive: true, force: true });
	return true;
}

function tryTake(lock: string): "taken" | "busy" | "error" {
	try {
		mkdirSync(lock);
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EEXIST" ? "busy" : "error";
	}
	try {
		writeFileSync(join(lock, "pid"), String(process.pid));
		return "taken";
	} catch {
		rmSync(lock, { recursive: true, force: true });
		return "error";
	}
}

/**
 * Runs `work` while holding the folder's lock (a directory made by `mkdir`, holding a `pid` file), waiting up to `waitMs` (default 8000) in 100 ms steps. The lock is removed afterwards, also when `work` throws (the error propagates).
 * Never throws for the lock itself: a lock that stays taken or a state directory that cannot be written gives `{ acquired: false }`.
 */
export async function withFolderLock<T>(folder: string, work: () => T | Promise<T>, options: { waitMs?: number } = {}): Promise<LockResult<T>> {
	const lock = lockPathOf(folder);
	const deadline = Date.now() + (options.waitMs ?? 8000);
	try {
		mkdirSync(mainSlotsDir(), { recursive: true });
	} catch (error) {
		return { acquired: false, why: `cannot create ${mainSlotsDir()}: ${error instanceof Error ? error.message : String(error)}` };
	}
	for (;;) {
		const taken = tryTake(lock);
		if (taken === "error") return { acquired: false, why: `cannot create lock ${lock}` };
		if (taken === "taken") break;
		if (breakStaleLock(lock)) continue;
		const left = deadline - Date.now();
		if (left <= 0) return { acquired: false, why: `lock ${lock} is held by pid ${pidOf(lock) ?? "unknown"}` };
		await sleep(Math.min(STEP_MS, left));
	}
	try {
		return { acquired: true, value: await work() };
	} finally {
		if (pidOf(lock) === String(process.pid)) rmSync(lock, { recursive: true, force: true });
	}
}
