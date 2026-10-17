// Nightly lane hygiene (what 오모냥's session doctor did for its tabs): once a day at lanes.nightly_at (gateway-local time)
// every idle lane is looked at. A session file past lanes.rotate_mb starts a fresh session with a handover; otherwise a
// context at 60% of lanes.compact_at or more is compacted. The bar is the auto-compaction point, not the model window:
// with a 1M window and auto-compaction at 400K, 60% of the window would never be reached. Working, rate-limited and
// stopped lanes are left alone.
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { statusActivity } from "./activity.ts";
import { lanesCompactAt, lanesNightlyAt, lanesRotateMb, log, OMP, paths } from "./config.ts";
import { describeCtx } from "./context.ts";
import { compactLane, lanes, refreshLaneStats, rotateLane } from "./lanes.ts";

const COMPACT_AT_PERCENT = 60;
const STATS_WAIT_MS = 3000;
// A run missed while the gateway was down is made up this long after the start, once restored lanes know their numbers.
const CATCHUP_DELAY_MS = 60_000;

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function lastRunDate(): string | undefined {
	try {
		const saved: { date?: string } = JSON.parse(readFileSync(paths.laneHygiene, "utf8"));
		return saved.date;
	} catch {
		return undefined;
	}
}

// Looks at every idle lane once; returns one line per action taken.
export async function runLaneHygiene(): Promise<string[]> {
	const idle = [...lanes.values()].filter(l => l.proc && l.status === "idle");
	const skipped = [...lanes.values()].filter(l => l.status === "working" || l.status === "starting" || l.status === "rate-limited").map(l => `${l.name} (${l.status})`);
	for (const lane of idle) refreshLaneStats(lane.name);
	if (idle.length) await Bun.sleep(STATS_WAIT_MS);
	const actions: string[] = [];
	const limitBytes = lanesRotateMb() * 1e6;
	for (const lane of idle) {
		// The lane may have picked up a message while the numbers were refreshed.
		if (!lane.proc || lane.status !== "idle") {
			skipped.push(`${lane.name} (${lane.status})`);
			continue;
		}
		const bytes = lane.sessionFile && existsSync(lane.sessionFile) ? statSync(lane.sessionFile).size : 0;
		let action: string | undefined;
		try {
			if (bytes > limitBytes) {
				const why = `session file ${+(bytes / 1e6).toFixed(2)} MB > ${lanesRotateMb()} MB`;
				await rotateLane(lane.name, why);
				action = `rotated to a fresh session with a handover (${why})`;
			} else if (lane.ctx.tokens >= (lanesCompactAt() * COMPACT_AT_PERCENT) / 100) {
				compactLane(lane.name);
				action = `compacting its context (${describeCtx(lane.ctx)}, at least ${COMPACT_AT_PERCENT}% of the ${lanesCompactAt().toLocaleString("en-US")}-token auto-compaction point)`;
			}
		} catch (e) {
			action = `hygiene failed: ${e instanceof Error ? e.message : e}`;
		}
		if (!action) continue;
		log(`lane hygiene: ${lane.name} ${action}`);
		statusActivity(`lane:${lane.name}`, `nightly hygiene: ${action}`);
		actions.push(`${lane.name}: ${action}`);
	}
	log(`lane hygiene: ${idle.length} idle lane(s) checked, ${actions.length} action(s)${skipped.length ? `, skipped ${skipped.join(", ")}` : ""}`);
	return actions;
}

export function startLaneHygiene(): void {
	const at = lanesNightlyAt();
	if (at === "off") return;
	const [, h, m] = /^(\d{1,2}):(\d{2})$/.exec(at) ?? [];
	if (h === undefined || Number(h) > 23 || Number(m) > 59) return log(`lane hygiene disabled: lanes.nightly_at "${at}" is neither HH:MM nor "off"`);
	const todayAt = () => {
		const d = new Date();
		d.setHours(Number(h), Number(m), 0, 0);
		return d;
	};
	const untilNext = () => {
		const d = todayAt();
		if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
		return d.getTime() - Date.now();
	};
	const arm = (delay: number) =>
		setTimeout(async () => {
			// The date is recorded before the run, so a crash in the middle never repeats it on the next start.
			writeFileSync(paths.laneHygiene, `${JSON.stringify({ date: localDate(new Date()) })}\n`);
			await runLaneHygiene().catch(e => log(`lane hygiene failed: ${e}`));
			arm(untilNext());
		}, delay);
	const last = lastRunDate();
	const missed = last !== undefined && last !== localDate(new Date()) && Date.now() >= todayAt().getTime();
	if (missed) log(`lane hygiene: last run ${last}, making up the missed ${at} run in ${CATCHUP_DELAY_MS / 1000}s`);
	arm(missed ? CATCHUP_DELAY_MS : untilNext());
}

// Finished task workers leave their isolation worktrees behind (a worker that copies a whole folder tree can leave
// gigabytes). Hourly, and WORKTREE_FIRST_MS after the start, every worktree omp reports with an `orphanReason` (no live
// job uses it) and untouched for WORKTREE_MIN_AGE_MS is deleted. Retained worktrees hold read-only files that make
// `omp worktree clear` fail with EACCES, so they are made writable first; only paths under the omp worktree root go.
const WORKTREE_ROOT = join(homedir(), ".omp", "wt");
const WORKTREE_EVERY_MS = 3600_000;
const WORKTREE_FIRST_MS = 2 * 60_000;
const WORKTREE_MIN_AGE_MS = 3600_000;

export type WorktreeEntry = { path: string; orphanReason?: string };

async function listWorktrees(): Promise<WorktreeEntry[]> {
	const proc = Bun.spawn([OMP, "worktree", "list", "--json"], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) throw new Error(`omp worktree list exited ${proc.exitCode}`);
	const parsed: unknown = JSON.parse(out);
	if (!Array.isArray(parsed)) throw new Error("omp worktree list did not return an array");
	return parsed.filter((e): e is WorktreeEntry => typeof e?.path === "string");
}

function underRoot(path: string, root: string): boolean {
	try {
		return realpathSync(path).startsWith(realpathSync(root) + sep);
	} catch {
		return false;
	}
}

function sizeKb(path: string): number {
	const r = Bun.spawnSync(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
	return Number(r.stdout.toString().split("\t")[0]) || 0;
}

// Deletes orphaned, stale worktrees; returns how many went and how much space they held.
export async function cleanWorktrees(entries?: WorktreeEntry[], root = WORKTREE_ROOT): Promise<{ removed: number; kb: number }> {
	let removed = 0;
	let kb = 0;
	for (const entry of entries ?? (await listWorktrees())) {
		if (!entry.orphanReason || !existsSync(entry.path) || !underRoot(entry.path, root)) continue;
		if (Date.now() - statSync(entry.path).mtimeMs < WORKTREE_MIN_AGE_MS) continue;
		const size = sizeKb(entry.path);
		Bun.spawnSync(["chmod", "-R", "u+w", entry.path], { stdout: "ignore", stderr: "ignore" });
		try {
			rmSync(entry.path, { recursive: true, force: true });
			removed++;
			kb += size;
		} catch (e) {
			log(`worktree cleanup: could not remove ${entry.path}: ${e}`);
		}
	}
	log(`worktree cleanup: removed ${removed} orphaned worktree(s), ${(kb / 1024).toFixed(1)} MB freed`);
	return { removed, kb };
}

export function startWorktreeCleanup(): void {
	const run = () => void cleanWorktrees().catch(e => log(`worktree cleanup failed: ${e}`));
	setTimeout(() => {
		run();
		setInterval(run, WORKTREE_EVERY_MS);
	}, WORKTREE_FIRST_MS);
}
