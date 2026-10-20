// Nightly lane hygiene (what 오모냥's session doctor did for its tabs): once a day at lanes.nightly_at (gateway-local time)
// every idle lane is looked at. A session file past lanes.rotate_mb starts a fresh session with a handover; otherwise a
// context of lanes.nightly_compact_at tokens or more (default 300K, the same as the daytime lanes.compact_at) is compacted.
// Working, rate-limited and stopped lanes are left alone.
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { statusActivity } from "./activity.ts";
import { closeDeadLaneTasks, pruneArchives, pruneTempSessions, pruneUploads, rotateFile, sessionDirs } from "./cleanup.ts";
import { DATA_DIR, lanesNightlyAt, lanesNightlyCompactAt, lanesRotateMb, log, OMP, paths, writeAtomic } from "./config.ts";
import { describeCtx } from "./context.ts";
import { UPLOADS } from "./files.ts";
import { compactLane, lanes, refreshLaneStats, rotateLane } from "./lanes.ts";
import { purgeTrash } from "./lanetrash.ts";
import { nightlyHandover, orchestratorPid } from "./orchestrator.ts";
import { trackTimer } from "./shutdown.ts";

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
			} else if (lane.ctx.tokens >= lanesNightlyCompactAt()) {
				compactLane(lane.name);
				action = `compacting its context (${describeCtx(lane.ctx)}, at least ${lanesNightlyCompactAt().toLocaleString("en-US")} tokens)`;
			}
		} catch (e) {
			action = `hygiene failed: ${e instanceof Error ? e.message : e}`;
		}
		if (!action) continue;
		log(`lane hygiene: ${lane.name} ${action}`);
		statusActivity(`lane:${lane.name}`, `nightly hygiene: ${action}`);
		actions.push(`${lane.name}: ${action}`);
	}
	const handover = nightlyHandover(limitBytes);
	if (handover) {
		log(`nightly hygiene: ${handover}`);
		actions.push(handover);
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
		trackTimer("lane hygiene", setTimeout(async () => {
			// The date is recorded before the run, so a crash in the middle never repeats it on the next start.
			writeAtomic(paths.laneHygiene, `${JSON.stringify({ date: localDate(new Date()) })}\n`);
			await runLaneHygiene().catch(e => log(`lane hygiene failed: ${e}`));
			arm(untilNext());
		}, delay));
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
export const WORKTREE_EVERY_MS = 3600_000;
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
	trackTimer("worktree cleanup", setTimeout(() => {
		run();
		trackTimer("worktree cleanup", setInterval(run, WORKTREE_EVERY_MS));
	}, WORKTREE_FIRST_MS));
}

// An omp rpc host whose gateway died (or that a crash detached) keeps running with nobody reading its stdout, holding a
// session and memory. Every ORPHAN_EVERY_MS the process table is searched for `omp ... --mode rpc` processes of this user
// that were reparented to launchd/init (ppid 1), have run at least ORPHAN_MIN_AGE_MIN minutes, and are neither a pid the
// gateway tracks nor in its own process tree; those are killed together with their children. A host with a live parent (a lane, the orchestrator, or an omp the owner runs in a terminal) is never touched.
const ORPHAN_EVERY_MS = 10 * 60_000;
const ORPHAN_FIRST_MS = 90_000;
const ORPHAN_KILL_GRACE_MS = 5000;
const ORPHAN_MIN_AGE_MIN = 10;

type PsRow = { pid: number; ppid: number; minutes: number; command: string };

// ps etime is [[dd-]hh:]mm:ss.
function etimeMinutes(etime: string): number {
	const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
	const p = clock!.split(":").map(Number);
	while (p.length < 3) p.unshift(0);
	return Number(days) * 1440 + p[0]! * 60 + p[1]!;
}

function psRows(): PsRow[] {
	const r = Bun.spawnSync(["ps", "-U", String(process.getuid?.() ?? ""), "-o", "pid=,ppid=,etime=,command="], { stdout: "pipe", stderr: "ignore" });
	if (r.exitCode !== 0) throw new Error(`ps exited ${r.exitCode}`);
	const rows: PsRow[] = [];
	for (const line of r.stdout.toString().split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), minutes: etimeMinutes(m[3]!), command: m[4]! });
	}
	return rows;
}

const isOmpRpcHost = (command: string): boolean =>
	/(^|\s)--mode[ =]rpc(\s|$)/.test(command) && command.split(/\s+/).slice(0, 3).some(t => t === OMP || basename(t) === basename(OMP));

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

// Kills provable orphaned omp rpc hosts; `only` narrows the candidates to command lines it matches and `minAgeMin` is the
// least age, both for smoke tests.
export async function reapOrphanHosts(only?: RegExp, minAgeMin = ORPHAN_MIN_AGE_MIN): Promise<number[]> {
	const rows = psRows();
	const parentOf = new Map(rows.map(r => [r.pid, r.ppid]));
	const tracked = new Set<number>([process.pid, orchestratorPid() ?? 0, ...[...lanes.values()].map(l => l.proc?.pid ?? 0)]);
	const inOwnTree = (pid: number): boolean => {
		for (let p: number | undefined = pid, n = 0; p && p > 1 && n < 64; p = parentOf.get(p), n++) if (p === process.pid) return true;
		return false;
	};
	const orphans = rows.filter(r => r.ppid === 1 && r.minutes >= minAgeMin && isOmpRpcHost(r.command) && (!only || only.test(r.command)) && !tracked.has(r.pid) && !inOwnTree(r.pid));
	const victims = orphans.flatMap(o => [o.pid, ...rows.filter(r => r.ppid === o.pid).map(r => r.pid)]);
	for (const pid of victims) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
	if (orphans.length) {
		await Bun.sleep(ORPHAN_KILL_GRACE_MS);
		for (const pid of victims)
			if (alive(pid))
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
		log(`orphan reaper: killed ${orphans.length} orphaned omp rpc host(s): ${orphans.map(o => o.pid).join(", ")}`);
	}
	return orphans.map(o => o.pid);
}

export function startOrphanReaper(): void {
	const run = () => void reapOrphanHosts().catch(e => log(`orphan reaper failed: ${e}`));
	trackTimer("orphan reaper", setTimeout(() => {
		run();
		trackTimer("orphan reaper", setInterval(run, ORPHAN_EVERY_MS));
	}, ORPHAN_FIRST_MS));
}

// Hourly data cleanup (eval 2026-10-20 L3/C1), DATA_CLEANUP_FIRST_MS after the start and then every hour. Sizes stay small
// and nothing the owner needs is dropped: rotated log/inbox/outbox heads are archived (inbox/outbox archives kept for
// good, hub.log ones for HUB_LOG_ARCHIVE_DAYS), uploads go after UPLOAD_KEEP_DAYS, only sessions of deleted temp folders
// idle for a day go, and an open task waiting on a lane that ended at least LANE_DEAD_MS ago is closed into
// tasks-closed.jsonl with the reason (the orchestrator can reopen it from there).
const DATA_CLEANUP_FIRST_MS = 3 * 60_000;
const DATA_CLEANUP_EVERY_MS = 3600_000;
const LOG_MAX_BYTES = 5e6;
const LOG_KEEP_BYTES = 1e6;
const EVENTS_MAX_BYTES = 5e6;
const EVENTS_KEEP_BYTES = 2e6;
const HUB_LOG_ARCHIVE_DAYS = 90;
const UPLOAD_KEEP_DAYS = 60;
const TEMP_SESSION_IDLE_MS = 86_400_000;
const LANE_DEAD_MS = 3600_000;

// Why a lane counts as ended for its open tasks, or undefined while it is live or restarting. A lane must be seen ended
// by two sweeps at least LANE_DEAD_MS apart (lane.json's mtime moves on every persist, so it cannot date the exit).
const endedSeen = new Map<string, number>();
export function laneEndedReason(name: string, now = Date.now()): string | undefined {
	const lane = lanes.get(name);
	const ended = lane ? lane.status === "exited" && !lane.proc && !lane.quiet : !existsSync(join(paths.lanes, name, "lane.json"));
	if (!ended) {
		endedSeen.delete(name);
		return undefined;
	}
	const since = endedSeen.get(name) ?? now;
	endedSeen.set(name, since);
	if (now - since < LANE_DEAD_MS) return undefined;
	return lane ? `lane ${name} ended (status exited, seen ended since ${new Date(since).toISOString()})` : `lane ${name} no longer exists`;
}

export function runDataCleanup(now = Date.now()): string[] {
	const actions: string[] = [];
	const step = (what: string, fn: () => string | undefined) => {
		try {
			const r = fn();
			if (r) actions.push(r);
		} catch (e) {
			actions.push(`${what} failed: ${e instanceof Error ? e.message : e}`);
		}
	};
	const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;
	for (const [file, max, keep] of [[paths.log, LOG_MAX_BYTES, LOG_KEEP_BYTES], [paths.inbox, EVENTS_MAX_BYTES, EVENTS_KEEP_BYTES], [paths.outbox, EVENTS_MAX_BYTES, EVENTS_KEEP_BYTES]] as const)
		step(`rotate ${basename(file)}`, () => {
			const r = rotateFile(file, max, keep, now);
			return r && `rotated ${basename(file)} ${mb(r.before)} -> ${mb(r.after)} (head in ${basename(r.archive)})`;
		});
	step("hub.log archives", () => {
		const gone = pruneArchives(join(DATA_DIR, "archive"), basename(paths.log), HUB_LOG_ARCHIVE_DAYS, now);
		return gone.length ? `removed ${gone.length} hub.log archive(s) older than ${HUB_LOG_ARCHIVE_DAYS} days` : undefined;
	});
	step("uploads", () => {
		const gone = pruneUploads(UPLOADS, UPLOAD_KEEP_DAYS, now);
		return gone.length ? `removed upload folder(s) older than ${UPLOAD_KEEP_DAYS} days: ${gone.join(", ")}` : undefined;
	});
	for (const dir of sessionDirs())
		step(`temp sessions in ${dir}`, () => {
			const r = pruneTempSessions(dir, TEMP_SESSION_IDLE_MS, now);
			return r.removed.length ? `removed ${r.removed.length} session folder(s) of deleted temp folders in ${dir} (${(r.kb / 1024).toFixed(1)} MB)` : undefined;
		});
	step("open tasks", () => {
		const closed = closeDeadLaneTasks(join(DATA_DIR, "state.json"), join(DATA_DIR, "tasks-closed.jsonl"), name => laneEndedReason(name, now), now);
		return closed.length ? `closed ${closed.length} open task(s) of ended lanes: ${closed.map(t => `${t.id} (${t.lane})`).join(", ")}` : undefined;
	});
	step("lane trash", () => purgeTrash(now));
	for (const a of actions) log(`data cleanup: ${a}`);
	if (actions.length) statusActivity("hub", `data cleanup: ${actions.join("; ")}`);
	return actions;
}

export function startDataCleanup(): void {
	const run = () => void runDataCleanup();
	trackTimer("data cleanup", setTimeout(() => {
		run();
		trackTimer("data cleanup", setInterval(run, DATA_CLEANUP_EVERY_MS));
	}, DATA_CLEANUP_FIRST_MS));
}
