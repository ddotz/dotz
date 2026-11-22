import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentHome } from "../agent-home.ts";
import { BUDGET_MARKER } from "./briefs.ts";
import { debug } from "./debug.ts";

export type WorkerState = { brief: string; spawnedAt: number; status: string; patch?: string; applied?: boolean };
export type ProjectState = { cwd: string; lane?: string; workers: Record<string, WorkerState>; settled?: Record<string, number>; reviewerNamed?: string[] };

const STATE_MAX_AGE_MS = 7 * 24 * 3600_000;
const SETTLED_MAX_AGE_MS = 30 * 24 * 3600_000;

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

/**
 * Writes `state` after dropping the workers that finished (and whose patch, if any, was applied or discarded) or are older than 7 days.
 * A dropped worker leaves a tombstone in `settled` for 30 days, because old task-result blocks in the session history
 * would otherwise recreate it as unapplied; a `lost` worker gets none, since it never produced a result block and must be
 * tracked if it does finish after all. Tombstones another omp process (a second session in this lane) wrote since this one
 * loaded the file are kept.
 */
export function saveState(state: ProjectState): void {
	const now = Date.now();
	const cutoff = now - STATE_MAX_AGE_MS;
	for (const [id, worker] of Object.entries(state.workers)) {
		const finished = worker.status !== "running" && (!worker.patch || worker.applied || patchDiscarded(worker));
		if (finished || worker.spawnedAt < cutoff) {
			delete state.workers[id];
			if (worker.status !== "lost") (state.settled ??= {})[id] = now;
		}
	}
	const onDisk = readStateFile(state.cwd, state.lane);
	for (const [id, at] of Object.entries(onDisk?.settled ?? {})) if (!state.workers[id]) (state.settled ??= {})[id] ??= at;
	if (state.settled) {
		for (const [id, at] of Object.entries(state.settled)) if (at < now - SETTLED_MAX_AGE_MS) delete state.settled[id];
	}
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(statePath(state.cwd, state.lane), `${JSON.stringify(state, null, 2)}\n`);
}

/** Marks every `running` worker whose `<WorkerId>.md` exists in the session's artifacts dir (the session file without `.jsonl`) as completed, and says whether any changed. */
export function settleFinishedWorkers(sessionFile: unknown, state: ProjectState): boolean {
	if (typeof sessionFile !== "string" || !sessionFile.endsWith(".jsonl")) return false;
	const dir = sessionFile.slice(0, -".jsonl".length);
	let changed = false;
	for (const [id, worker] of Object.entries(state.workers)) {
		if (worker.status !== "running" || !existsSync(join(dir, `${id}.md`))) continue;
		worker.status = "completed";
		changed = true;
	}
	return changed;
}

function briefLine(brief: string): string {
	const flat = brief.replace(/\s+/g, " ").trim();
	return `  task:  ${flat.length > 80 ? `${flat.slice(0, 80)}…` : flat}`;
}

/** The open-worker report re-injected after a compaction or at a session start, or undefined when no worker is tracked. */
export function stateSummary(state: ProjectState, previousSession: boolean): string | undefined {
	let unapplied = false;
	const lines = Object.entries(state.workers)
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

/** Copies the captured patch of worker `id` into the state dir and returns the kept path, or `captured` when the copy fails. */
export function keepPatch(cwd: string, id: string, captured: string): string {
	const dir = join(stateDir(), "patches", createHash("sha1").update(cwd).digest("hex").slice(0, 16));
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
export function settleFromText(state: ProjectState, text: string): boolean {
	let changed = false;
	for (const match of text.matchAll(/<task-result\b[^>]*\bid="([^"]+)"[^>]*\bstatus="([^"]+)"[^>]*>([\s\S]*?)<\/task-result>/g)) {
		const [, id, status, body] = match;
		const worker = state.workers[id] ?? (state.settled?.[id] ? undefined : (state.workers[id] = { brief: "(spawned before tracking)", spawnedAt: Date.now(), status: "running" }));
		if (!worker) continue;
		const captured = body.match(/changes captured at `([^`]+\.patch)`/)?.[1];
		const patch = captured && !worker.patch ? keepPatch(state.cwd, id, captured) : undefined;
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
