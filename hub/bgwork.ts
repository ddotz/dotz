// The orchestrator's background task workers: what a turn that ended with `[later]` is waiting for. OmO keeps one record per
// task in its task store (<agent dir>/projects/*/senpi-task/tasks/<id>.json: status, spawn time, the Korean one-line
// description the orchestrator wrote at the spawn, end time) and the store outlives the gateway, so this list is read from
// there and a restart rebuilds it by itself. The store's root_session_id ties a worker to the orchestrator's session file
// (the uuid ending its name), as for a session's workers in activity.ts omoTasks.
//
// A worker belongs to the owner message it was spawned for when that message is still open (deferred, prompts.ts): the
// latest deferred message delivered before the worker's spawn. Finished workers keep no such message, nothing waits for them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { scrub } from "./activity.ts";

export type BgWork = {
	id: string;
	/** The short description written at the spawn (Korean, as the orchestrator wrote it). */
	description: string;
	status: "running" | "done" | "failed";
	started_at: number;
	ended_at?: number;
	/** The channel of the open owner message this work serves, when known. */
	target?: string;
	reply_to?: string;
};

/** An owner message whose turn ended with `[later]` and is still waiting for its answer. */
export type OpenDeferred = { target: string; replyTo?: string; at: number };

type Rec = {
	task_id?: string;
	status?: string;
	root_session_id?: string;
	created_at?: string;
	started_at?: string;
	updated_at?: string;
	terminal_at?: string;
	description?: string;
	task_summary?: string;
	category?: string;
	pid?: number;
	recovery_deadline_at?: string;
};

// Finished work stays listed this long.
export const FINISHED_KEEP_MS = 3600_000;
// A worker spawned this much before the message it serves was delivered (clock rounding) still belongs to it.
const SPAWN_SLACK_MS = 5_000;
const RUNNING = new Set(["running", "queued", "pending"]);
const DONE = new Set(["completed", "done", "succeeded"]);

const stamp = (s?: string) => (s ? Date.parse(s) || 0 : 0);
const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

export type BgWorkDeps = {
	/** The orchestrator's session file (empty before its first run). */
	sessionFile: () => string | undefined;
	deferred: () => OpenDeferred[];
	now?: () => number;
	/** Is this process still alive? A record that says running while its process is gone is a worker the restart killed. */
	alive?: (pid: number) => boolean;
};

export function createBgWork(deps: BgWorkDeps) {
	const now = deps.now ?? Date.now;
	const alive = deps.alive ?? pidAlive;
	// A record is parsed again only when its file changed; the store keeps every task ever run.
	const cache = new Map<string, { stamp: string; rec?: Rec }>();

	function records(sessionFile: string): Rec[] {
		const root = /_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(sessionFile)?.[1];
		const projects = join(dirname(dirname(dirname(sessionFile))), "projects");
		if (!root || !existsSync(projects)) return [];
		const out: Rec[] = [];
		for (const project of readdirSync(projects)) {
			const tasks = join(projects, project, "senpi-task", "tasks");
			if (!existsSync(tasks)) continue;
			for (const name of readdirSync(tasks).filter(n => n.endsWith(".json"))) {
				const file = join(tasks, name);
				let changed: string;
				try {
					const s = statSync(file);
					changed = `${s.mtimeMs}:${s.size}`;
				} catch {
					continue;
				}
				let hit = cache.get(file);
				if (!hit || hit.stamp !== changed) {
					let rec: Rec | undefined;
					try {
						rec = JSON.parse(readFileSync(file, "utf8")) as Rec;
					} catch {
						rec = undefined;
					}
					cache.set(file, (hit = { stamp: changed, rec }));
				}
				if (hit.rec?.root_session_id === root && hit.rec.task_id) out.push(hit.rec);
			}
		}
		return out;
	}

	function toWork(r: Rec): BgWork {
		const started = stamp(r.started_at) || stamp(r.created_at) || stamp(r.updated_at);
		const raw = (r.status ?? "").toLowerCase();
		let status: BgWork["status"] = RUNNING.has(raw) ? "running" : DONE.has(raw) ? "done" : "failed";
		let ended = stamp(r.terminal_at) || stamp(r.updated_at);
		// The workers die with the gateway's process tree; the record of one that died mid-run is never closed by anyone.
		if (status === "running" && typeof r.pid === "number" && !alive(r.pid) && stamp(r.recovery_deadline_at) <= now()) {
			status = "failed";
			ended = stamp(r.updated_at) || started;
		}
		const description = scrub(String(r.description || r.task_summary || r.category || r.task_id)).replace(/\s+/g, " ").trim().slice(0, 120);
		return { id: r.task_id!, description, status, started_at: started, ...(status === "running" ? {} : { ended_at: ended || started }) };
	}

	/** Running work (oldest first), then what finished within the last hour (newest first). */
	function list(): BgWork[] {
		const file = deps.sessionFile();
		if (!file) return [];
		const t = now();
		const open = deps.deferred().sort((a, b) => a.at - b.at);
		const works = records(file).map(toWork).filter(w => w.status === "running" || t - (w.ended_at ?? 0) <= FINISHED_KEEP_MS);
		for (const w of works) {
			if (w.status !== "running") continue;
			const p = open.filter(d => d.at <= w.started_at + SPAWN_SLACK_MS).at(-1);
			if (p) {
				w.target = p.target;
				if (p.replyTo) w.reply_to = p.replyTo;
			}
		}
		const running = works.filter(w => w.status === "running").sort((a, b) => a.started_at - b.started_at);
		const finished = works.filter(w => w.status !== "running").sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));
		return [...running, ...finished];
	}

	return { list };
}
