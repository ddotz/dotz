import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentHome } from "../agent-home.ts";
import { BUDGET_MARKER } from "./briefs.ts";
import { debug } from "./debug.ts";
import { measureFinishedWorkers } from "./worker-size.ts";

export type WorkerState = { brief: string; spawnedAt: number; status: string; session?: string; patch?: string; applied?: boolean; items?: number; peak?: number; compacted?: boolean };

/** The workers `session` spawned, with the id each is kept under; records without a session (written before sessions were recorded) belong to every session, and so does every record when the session id is unknown. */
export function workersOfSession(state: ProjectState, session: string | undefined): [string, WorkerState][] {
	return Object.entries(state.workers).filter(([, worker]) => !worker.session || !session || worker.session === session);
}

/** What a finished worker's own session file showed: its brief's change items, its peak context in tokens and whether it compacted; absent fields were not recorded. */
export type FinishedWorker = { id: string; at: number; items?: number; peak?: number; compacted?: boolean };
export type ProjectState = { cwd: string; lane?: string; workers: Record<string, WorkerState>; settled?: Record<string, number>; reviewerNamed?: string[]; finished?: FinishedWorker[] };

const STATE_MAX_AGE_MS = 7 * 24 * 3600_000;
const SETTLED_MAX_AGE_MS = 30 * 24 * 3600_000;
const STATE_QUIET_MS = 24 * 3600_000;
const FINISHED_KEEP = 50;
const MOUNT_ROOT = /^\/(?:Volumes\/[^/]+|media\/[^/]+\/[^/]+|mnt\/[^/]+)/;

function onUnmountedVolume(path: string): boolean {
	const root = MOUNT_ROOT.exec(path)?.[0];
	return root !== undefined && !existsSync(root);
}

/** How long a worker may run: `task.maxRuntimeMs` in `config.yml` (a test keeps the two equal). Dotz lanes and orchestrator overlays run workers without a limit, so this bounds idle time in a worktree, never the age of a `running` record. */
export const WORKER_MAX_RUNTIME_MS = 2 * 3600_000;

/** Where per-project worker state lives. Read per call, not at import: tests (and a copy of this extension run with -e) point ORCH_GUARD_STATE_DIR elsewhere. */
export const stateDir = () => process.env.ORCH_GUARD_STATE_DIR ?? join(agentHome(), "orchestrator-state");

function statePath(cwd: string, lane?: string): string {
	return join(stateDir(), `${createHash("sha1").update(lane ? `${cwd}\0${lane}` : cwd).digest("hex").slice(0, 16)}.json`);
}

function readStateFile(cwd: string, lane: string | undefined): ProjectState | undefined {
	try {
		return JSON.parse(readFileSync(statePath(cwd, lane), "utf8"));
	} catch {
		return undefined;
	}
}

/** The saved worker state of the project folder `cwd`, or an empty one. State is per project folder and, for dotz lanes (several omp sessions in one folder), per lane, so one lane's workers are never reported in another lane's channel. */
export function loadState(cwd: string): ProjectState {
	const lane = process.env.DOTZ_LANE || undefined;
	const saved = readStateFile(cwd, lane);
	return saved ? { ...saved, cwd, lane } : { cwd, lane, workers: {} };
}

/** Whether the owner discarded `worker` by deleting its kept patch under the state dir; a captured path elsewhere (the keep copy failed) can vanish on its own and is not a discard. */
export function patchDiscarded(worker: WorkerState): boolean {
	return Boolean(worker.patch && !worker.applied && worker.patch.startsWith(join(stateDir(), "patches")) && !existsSync(worker.patch));
}

function settleWorkers(state: ProjectState, now: number): number {
	let dropped = 0;
	for (const [id, worker] of Object.entries(state.workers)) {
		const finished = worker.status !== "running" && (!worker.patch || worker.applied || patchDiscarded(worker));
		if (finished || worker.spawnedAt < now - STATE_MAX_AGE_MS) {
			delete state.workers[id];
			dropped++;
			if (worker.status !== "lost") (state.settled ??= {})[id] = now;
		}
	}
	return dropped;
}

function markGoneWorkersLost(state: ProjectState, stateFileMtimeMs: number, now: number): number {
	if (stateFileMtimeMs >= now - STATE_QUIET_MS) return 0;
	let lost = 0;
	for (const worker of Object.values(state.workers)) {
		if (worker.status !== "running" || worker.spawnedAt >= now - STATE_QUIET_MS) continue;
		worker.status = "lost";
		lost++;
	}
	return lost;
}

function expireTombstones(state: ProjectState, now: number): void {
	for (const [id, at] of Object.entries(state.settled ?? {})) if (at < now - SETTLED_MAX_AGE_MS) delete state.settled?.[id];
	if (state.finished) state.finished = state.finished.filter(entry => entry.at >= now - SETTLED_MAX_AGE_MS).slice(-FINISHED_KEEP);
}

function writeStateFile(path: string, state: ProjectState): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(temp, path);
}

/**
 * Writes `state` after dropping the workers that finished (and whose patch, if any, was applied or discarded) or are older than 7 days.
 * A dropped worker leaves a tombstone in `settled` for 30 days, because old task-result blocks in the session history
 * would otherwise recreate it as unapplied; a `lost` worker gets none, since it never produced a result block and must be
 * tracked if it does finish after all. Tombstones another omp process (a second session in this lane) wrote since this one
 * loaded the file are kept, and so are its `finished` size records (the last 50 within 30 days) and the workers it spawned that this one does not know; the file is replaced by a rename, so a reader never sees half of it.
 * With `session`, a worker another session spawned is written as that session left it on disk (dropped when it is gone there), so a stale copy never undoes the owner's update.
 */
export function saveState(state: ProjectState, session?: string): void {
	const now = Date.now();
	const onDisk = readStateFile(state.cwd, state.lane);
	if (session) {
		for (const [id, worker] of Object.entries(state.workers)) {
			if (!worker.session || worker.session === session) continue;
			const theirs = onDisk?.workers[id];
			if (theirs) state.workers[id] = theirs;
			else delete state.workers[id];
		}
	}
	for (const [id, worker] of Object.entries(onDisk?.workers ?? {})) if (!state.workers[id] && !state.settled?.[id] && !onDisk?.settled?.[id]) state.workers[id] = worker;
	settleWorkers(state, now);
	for (const [id, at] of Object.entries(onDisk?.settled ?? {})) if (!state.workers[id]) (state.settled ??= {})[id] ??= at;
	const known = new Set((state.finished ?? []).map(entry => entry.id));
	const others = (onDisk?.finished ?? []).filter(entry => !known.has(entry.id));
	if (others.length) state.finished = [...others, ...(state.finished ?? [])].sort((a, b) => a.at - b.at);
	expireTombstones(state, now);
	mkdirSync(stateDir(), { recursive: true });
	writeStateFile(statePath(state.cwd, state.lane), state);
}

/** What a prune of the state dir did, or with `dry` would do: files looked at, state files of vanished folders deleted, workers marked lost, worker records dropped, kept patches seen and stale ones deleted. */
export type PruneReport = { stateFiles: number; deletedFiles: number; lostWorkers: number; droppedWorkers: number; keptPatches: number; deletedPatches: number };

/**
 * Prunes every state file in the state dir, not only the one of the current folder (nothing else saves a project nobody opens again):
 * the file of a folder that no longer exists (and is not on a volume whose mount root under /Volumes, /media or /mnt is missing) is deleted unless it
 * still references an unapplied kept patch that exists; a `running` worker is marked `lost` only when its state file has not been written
 * for a day and it was spawned more than a day ago, because every spawn, result and apply of a live session writes that file
 * (dotz lanes and overlays run workers without a runtime limit, so a record's age alone proves nothing); the files then get the rules of `saveState`; a kept patch under
 * `patches/` that no remaining worker references and that is over 7 days old is deleted, with its folder once empty.
 * A file that does not parse is left alone, and then no patch is deleted, because the unread file may reference it.
 */
export function pruneStateDir({ dry = false, now = Date.now() }: { dry?: boolean; now?: number } = {}): PruneReport {
	const report: PruneReport = { stateFiles: 0, deletedFiles: 0, lostWorkers: 0, droppedWorkers: 0, keptPatches: 0, deletedPatches: 0 };
	const dir = stateDir();
	if (!existsSync(dir)) return report;
	const referenced = new Set<string>();
	let unreadable = false;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		let state: ProjectState | undefined;
		try {
			state = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			debug({ phase: "state-prune-unreadable", path, message: String(error) });
		}
		if (typeof state?.cwd !== "string" || typeof state.workers !== "object" || state.workers === null) {
			unreadable = true;
			continue;
		}
		report.stateFiles++;
		const holdsPatch = Object.values(state.workers).some(worker => worker.patch && !worker.applied && existsSync(worker.patch));
		if (!existsSync(state.cwd) && !onUnmountedVolume(state.cwd) && !holdsPatch) {
			report.deletedFiles++;
			if (!dry) rmSync(path, { force: true });
			continue;
		}
		const before = JSON.stringify(state);
		report.lostWorkers += markGoneWorkersLost(state, statSync(path).mtimeMs, now);
		report.droppedWorkers += settleWorkers(state, now);
		expireTombstones(state, now);
		if (!dry && JSON.stringify(state) !== before) writeStateFile(path, state);
		for (const worker of Object.values(state.workers)) if (worker.patch) referenced.add(resolve(worker.patch));
	}
	const patchRoot = join(dir, "patches");
	if (!existsSync(patchRoot)) return report;
	for (const group of readdirSync(patchRoot)) {
		const groupDir = join(patchRoot, group);
		if (!statSync(groupDir).isDirectory()) continue;
		for (const file of readdirSync(groupDir)) {
			const patch = join(groupDir, file);
			report.keptPatches++;
			if (unreadable || referenced.has(resolve(patch)) || statSync(patch).mtimeMs > now - STATE_MAX_AGE_MS) continue;
			report.deletedPatches++;
			if (!dry) rmSync(patch, { force: true });
		}
		if (!dry && readdirSync(groupDir).length === 0) rmdirSync(groupDir);
	}
	return report;
}

/** Marks every `running` worker whose `<WorkerId>.md` exists in the session's artifacts dir (the session file without `.jsonl`) as completed, records the size of every finished worker (`measureFinishedWorkers`), and says whether any changed. */
export function settleFinishedWorkers(sessionFile: unknown, state: ProjectState): boolean {
	if (typeof sessionFile !== "string" || !sessionFile.endsWith(".jsonl")) return false;
	const dir = sessionFile.slice(0, -".jsonl".length);
	let changed = false;
	for (const [id, worker] of Object.entries(state.workers)) {
		if (worker.status !== "running" || !existsSync(join(dir, `${id}.md`))) continue;
		worker.status = "completed";
		changed = true;
	}
	return measureFinishedWorkers(sessionFile, state) || changed;
}

function briefLine(brief: string): string {
	const flat = brief.replace(/\s+/g, " ").trim();
	return `  task:  ${flat.length > 80 ? `${flat.slice(0, 80)}…` : flat}`;
}

/** The open-worker report re-injected after a compaction or at a session start (the workers of `session` only), or undefined when none is tracked. */
export function stateSummary(state: ProjectState, previousSession: boolean, session?: string): string | undefined {
	let unapplied = false;
	const lines = workersOfSession(state, session)
		.filter(([, w]) => w.status === "running" || !patchDiscarded(w))
		.map(([id, w]) => {
			if (w.status === "running")
				return `- ${id}: ${previousSession ? "stopped with the previous session (resume only via omp --restore)" : "running"}\n${briefLine(w.brief)}`;
			if (w.patch && !w.applied) {
				unapplied = true;
				return `- ${id}: ${w.status}, patch not applied\n  patch: ${w.patch}${existsSync(w.patch) ? "" : " (file missing)"}\n${briefLine(w.brief)}`;
			}
			return `- ${id}: ${w.status}\n${briefLine(w.brief)}`;
		});
	if (!lines.length) return undefined;
	const discardHint = unapplied ? "\nNot applying a patch? Delete its file and the worker leaves this list." : "";
	return `[orchestrator-guard] ${lines.length} open worker(s) in ${state.cwd}\n${lines.join("\n")}${discardHint}`;
}

/** Copies the captured patch of worker `id` into the state dir and returns the kept path, or `captured` when the copy fails. The folder name is keyed on the project folder and the session, so two sessions that keep a patch of the same worker id each get their own file. */
export function keepPatch(cwd: string, id: string, captured: string, sessionId?: string): string {
	const dir = join(stateDir(), "patches", createHash("sha1").update(sessionId ? `${cwd}\0${sessionId}` : cwd).digest("hex").slice(0, 16));
	const kept = join(dir, `${id}.patch`);
	if (existsSync(kept)) return kept;
	try {
		mkdirSync(dir, { recursive: true });
		copyFileSync(captured, kept);
		return kept;
	} catch (error) {
		debug({ phase: "patch-keep-error", captured, message: String(error) });
		return captured;
	}
}

/** The one-line label of a brief: its non-heading lines joined, without the budget footer, cut at 160 chars. */
export function briefLabel(task: unknown): string {
	return String(task ?? "")
		.split("\n")
		.filter(line => line.trim() && !/^\s*#/.test(line) && !line.includes(BUDGET_MARKER))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}

/**
 * Settles known workers from any tool result: `<task-result id status>` blocks (task, wait, read of agent://) and the
 * `### <id> [<agent>] — <status>` headers of job listings, which is the only record of a worker cancelled through
 * proc://<id>/kill. Unknown ids are only created from task-result blocks, and never for a tombstoned id (`state.settled`):
 * a worker that finished is deleted from the state, and its old task-result block in the history must not resurrect it.
 */
export function settleFromText(state: ProjectState, text: string, sessionId?: string): boolean {
	let changed = false;
	for (const match of text.matchAll(/<task-result\b[^>]*\bid="([^"]+)"[^>]*\bstatus="([^"]+)"[^>]*>([\s\S]*?)<\/task-result>/g)) {
		const [, id, status, body] = match;
		const worker = state.workers[id] ?? (state.settled?.[id] ? undefined : (state.workers[id] = { brief: "(spawned before tracking)", spawnedAt: Date.now(), status: "running", ...(sessionId ? { session: sessionId } : {}) }));
		if (!worker) continue;
		const captured = body.match(/changes captured at `([^`]+\.patch)`/)?.[1];
		const patch = captured && !worker.patch ? keepPatch(state.cwd, id, captured, sessionId) : undefined;
		if (worker.status !== status || (patch && worker.patch !== patch)) {
			worker.status = status;
			if (patch) worker.patch = patch;
			changed = true;
		}
	}
	for (const [, id, status] of text.matchAll(/^###\s+(\S+)\s+\[[^\]]+\]\s+[—-]\s+(cancelled|completed|failed|aborted)\b/gm)) {
		const worker = state.workers[id];
		if (worker?.status === "running") {
			worker.status = status;
			changed = true;
		}
	}
	return changed;
}
