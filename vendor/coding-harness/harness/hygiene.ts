import { execFile } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { harnessDir, logsDir } from "./agent-home.ts";
import { parkedLine, slotsUnlistedLine, slotStates } from "./checkouts/report.ts";
import { pruneStateDir, WORKER_MAX_RUNTIME_MS } from "./guard/state.ts";

const execFileAsync = promisify(execFile);

const HOUR_MS = 3600_000;

/** How long nothing anywhere in an orphaned worktree may have been written before it goes: a worker's maximum runtime plus half an hour. `omp worktree list` of one process reports the live worktrees of other sessions (and of its own sub-agents) as orphans, so only a tree without a write for longer than any worker runs shows that no worker is left; dotz lanes run without a runtime limit but write into the tree all the time. */
export const ORPHAN_MIN_IDLE_MS = WORKER_MAX_RUNTIME_MS + HOUR_MS / 2;

/** The most worktrees one sweep removes; the rest wait for the next sweep, so a session start or a doctor run is not held up by gigabytes of deletion. */
export const SWEEP_MAX_REMOVALS = 3;
const HUB_LOG_TAIL_BYTES = 64 * 1024;
const OMP_BIN = /(^|\/)(bun|node)$/.test(process.execPath) ? "omp" : process.execPath;
const ompBin = () => process.env.ORCH_GUARD_OMP_BIN ?? OMP_BIN;
const worktreeRoot = () => process.env.ORCH_GUARD_WORKTREE_ROOT ?? join(homedir(), ".omp", "wt");

/** One worktree omp reports as owned by no live job: its folder, size in KiB, and whether nothing in it was written for `ORPHAN_MIN_IDLE_MS`. */
export type OrphanWorktree = { path: string; kb: number; removable: boolean };

/** `root` replaces the omp worktree root (`~/.omp/wt`), `dry` only reports, `now` replaces the clock. */
export type SweepOptions = { root?: string; dry?: boolean; now?: number };

/** What a sweep saw (`orphans`, removable or not) and did (`removed` worktrees holding `kb` KiB; `deferred` removable ones left for the next sweep by `SWEEP_MAX_REMOVALS`). */
export type SweepReport = { orphans: OrphanWorktree[]; removed: number; kb: number; deferred: number };

/** `done` and `failed` ran a sweep; `skipped: <reason>` did not. */
export type SweepOutcome = "done" | "failed" | `skipped: ${string}`;

type ListedWorktree = { path: string; orphanReason?: string };

const isListed = (entry: unknown): entry is ListedWorktree => typeof entry === "object" && entry !== null && "path" in entry && typeof entry.path === "string";

async function listWorktrees(): Promise<ListedWorktree[]> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync(ompBin(), ["worktree", "list", "--json"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
	} catch (error) {
		throw new Error(`omp worktree list exited with an error: ${String(error)}`);
	}
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) throw new Error("omp worktree list did not return an array");
	return parsed.filter(isListed);
}

function underRoot(path: string, root: string): boolean {
	try {
		return realpathSync(path).startsWith(realpathSync(root) + sep);
	} catch {
		return false;
	}
}

async function sizeKb(path: string): Promise<number> {
	try {
		const { stdout } = await execFileAsync("du", ["-sk", path], { timeout: 60_000 });
		return Number(stdout.split("\t")[0]) || 0;
	} catch (error) {
		if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") return Number(error.stdout.split("\t")[0]) || 0;
		throw error;
	}
}

/** why(platform): macOS find(1) takes only a whole number for `-mmin` ("illegal trailing character" for 150.5) and a local-time string for `-newermt` that a process with another TZ gets wrong, so the cutoff is a whole number of minutes (`man find`, -mmin). */
async function writtenSince(path: string, cutoffMs: number): Promise<boolean> {
	const minutes = Math.max(1, Math.ceil((Date.now() - cutoffMs) / 60_000));
	const { stdout } = await execFileAsync("find", [path, "-mmin", `-${minutes}`, "-print", "-quit"], { timeout: 120_000, maxBuffer: 1024 * 1024 });
	return stdout.trim() !== "";
}

async function idleSince(path: string, cutoffMs: number, now: number): Promise<boolean> {
	try {
		return !(await writtenSince(path, cutoffMs));
	} catch (error) {
		logLine(`worktree sweep: kept ${path}, could not read the whole tree to tell when it was last written: ${String(error)}`, now);
		return false;
	}
}

/** The worktrees omp lists with an `orphanReason` that exist under the omp worktree root, with their size and whether nothing anywhere in the tree (the folder, its subfolders or files) was written for `ORPHAN_MIN_IDLE_MS`; throws when omp cannot list them. */
export async function findOrphans({ root = worktreeRoot(), now = Date.now() }: SweepOptions = {}): Promise<OrphanWorktree[]> {
	const found: OrphanWorktree[] = [];
	for (const entry of await listWorktrees()) {
		if (!entry.orphanReason || !existsSync(entry.path) || !underRoot(entry.path, root)) continue;
		const removable = await idleSince(entry.path, now - ORPHAN_MIN_IDLE_MS, now);
		found.push({ path: entry.path, kb: await sizeKb(entry.path), removable });
	}
	return found;
}

/**
 * Removes at most `SWEEP_MAX_REMOVALS` orphaned worktrees (listed with an `orphanReason`, nothing in them written for `ORPHAN_MIN_IDLE_MS`) under the omp worktree root, without blocking the event loop.
 * Retained worktrees hold read-only files that make a plain removal fail with EACCES, so each is made writable first;
 * a path outside the root, or a link that leads outside it, is never touched. `dry` reports without removing.
 */
export async function sweepOrphans(options: SweepOptions = {}): Promise<SweepReport> {
	const orphans = await findOrphans(options);
	let removed = 0;
	let kb = 0;
	let deferred = 0;
	let attempted = 0;
	if (options.dry) return { orphans, removed, kb, deferred };
	for (const orphan of orphans) {
		if (!orphan.removable) continue;
		if (attempted >= SWEEP_MAX_REMOVALS) {
			deferred++;
			continue;
		}
		attempted++;
		try {
			await execFileAsync("chmod", ["-R", "u+w", orphan.path], { timeout: 60_000 });
			await rm(orphan.path, { recursive: true, force: true });
			removed++;
			kb += orphan.kb;
		} catch (error) {
			logLine(`worktree sweep: could not remove ${orphan.path}: ${String(error)}`, options.now ?? Date.now());
		}
	}
	return { orphans, removed, kb, deferred };
}

const logEnglish = (text: { en: string }): string => text.en;

async function logParkedSlots(now: number): Promise<void> {
	if (Bun.which("ovnfs", { PATH: process.env.PATH ?? "" }) === null) return;
	try {
		const slots = await slotStates();
		if (!slots.ok) {
			logLine(slotsUnlistedLine(slots.why, logEnglish), now);
			return;
		}
		for (const slot of slots.value) if (slot.condition.state === "parked") logLine(parkedLine(slot, logEnglish, now), now);
	} catch (error) {
		logLine(`parked slots: failed: ${String(error)}`, now);
	}
}

const markerPath = () => join(harnessDir(), "state", "worktree-sweep.json");
const hygieneLogPath = () => join(logsDir(), "hygiene.log");
const hubLogPath = () => join(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "hub.log");

function logLine(message: string, now: number): void {
	mkdirSync(logsDir(), { recursive: true });
	appendFileSync(hygieneLogPath(), `${new Date(now).toISOString()} ${message}\n`);
}

function lastSweepAt(): number {
	try {
		const parsed: unknown = JSON.parse(readFileSync(markerPath(), "utf8"));
		return typeof parsed === "object" && parsed !== null && "at" in parsed && typeof parsed.at === "number" ? parsed.at : 0;
	} catch {
		return 0;
	}
}

/** When the dotz hub last logged its hourly `worktree cleanup:` line in `hub.log` (an ISO timestamp starts the line), or 0 when there is no such line in the last 64 KiB. */
export function hubSweptAt(): number {
	const path = hubLogPath();
	if (!existsSync(path)) return 0;
	const size = statSync(path).size;
	const length = Math.min(size, HUB_LOG_TAIL_BYTES);
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, length, size - length);
	} finally {
		closeSync(fd);
	}
	let at = 0;
	for (const line of buffer.toString("utf8").split("\n")) {
		const match = line.match(/^(\S+) worktree cleanup: removed /);
		if (match) at = Date.parse(match[1]) || at;
	}
	return at;
}

/**
 * The omp worktree sweep a main session runs at its start, at most hourly: orphaned worktrees with no write anywhere in them for `ORPHAN_MIN_IDLE_MS` go (at most `SWEEP_MAX_REMOVALS` per sweep).
 * It does not run when `DOTZ_SHARED_CLEANUP=off` is set, when a sweep of this machine's harness started within the hour
 * (the marker is written before the sweep, so a failing listing is not retried by every session), or when the dotz hub
 * logged its own `worktree cleanup:` line in `~/.dotz/hub.log` (`DOTZ_DIR`) within the hour. One line with the count and the
 * space freed goes to `<logs>/hygiene.log`, then one line per parked checkout slot of any folder (it holds work nobody holds; the sweep removes and lands nothing of them).
 */
export async function runWorktreeSweep(options: SweepOptions = {}): Promise<SweepOutcome> {
	const now = options.now ?? Date.now();
	if (process.env.DOTZ_SHARED_CLEANUP === "off") return "skipped: DOTZ_SHARED_CLEANUP=off";
	if (now - hubSweptAt() < HOUR_MS) return "skipped: the dotz hub swept within the hour";
	if (now - lastSweepAt() < HOUR_MS) return "skipped: swept within the hour";
	mkdirSync(dirname(markerPath()), { recursive: true });
	writeFileSync(markerPath(), `${JSON.stringify({ at: now })}\n`);
	let outcome: SweepOutcome;
	try {
		const report = await sweepOrphans({ ...options, now });
		logLine(`worktree sweep: removed ${report.removed} orphaned worktree(s), ${(report.kb / 1024).toFixed(1)} MB freed${report.deferred ? `, ${report.deferred} left for the next sweep` : ""}`, now);
		outcome = "done";
	} catch (error) {
		logLine(`worktree sweep: failed: ${String(error)}`, now);
		outcome = "failed";
	}
	await logParkedSlots(now);
	return outcome;
}

/** What a main session does at its start: prunes the worker state dir and, outside a host copy, sweeps orphaned worktrees. Never throws. */
export async function sessionStartHygiene({ sweepWorktrees }: { sweepWorktrees: boolean }): Promise<void> {
	try {
		const pruned = pruneStateDir();
		const changed = pruned.deletedFiles + pruned.lostWorkers + pruned.droppedWorkers + pruned.deletedPatches;
		if (changed) logLine(`state prune: ${pruned.deletedFiles} dead-cwd file(s), ${pruned.lostWorkers} worker(s) marked lost, ${pruned.droppedWorkers} dropped, ${pruned.deletedPatches} stale patch(es) deleted`, Date.now());
		if (sweepWorktrees) await runWorktreeSweep();
	} catch (error) {
		logLine(`session hygiene failed: ${String(error)}`, Date.now());
	}
}
