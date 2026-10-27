// The orchestrator's background task workers: what a turn that ended with `[later]` is waiting for. OmO keeps one record per
// task in its task store (<agent dir>/projects/*/senpi-task/tasks/<id>.json: status, spawn time, the Korean one-line
// description the orchestrator wrote at the spawn, end time) and the store outlives the gateway, so this list is read from
// there and a restart rebuilds it by itself. The store's root_session_id ties a worker to the orchestrator's session file
// (the uuid ending its name), as for a session's workers in activity.ts omoTasks.
//
// A worker belongs to the owner message of the turn that spawned it (prompts.ts turnAt); one spawned by no turn of ours (a
// run a worker's result woke, a restart) belongs to the latest still-open deferred message delivered before its spawn.
// Finished workers keep no such message, nothing waits for them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { scrub } from "./activity.ts";
import { failureText } from "./runstate.ts";

type BgWork = {
	id: string;
	/** The short description written at the spawn (Korean, as the orchestrator wrote it). */
	description: string;
	status: "running" | "done" | "failed";
	started_at: number;
	ended_at?: number;
	/** The channel of the open owner message this work serves, when known. */
	target?: string;
	reply_to?: string;
	/** The project folder the worker was briefed for ("Repo: <path>" in its brief, else its working folder), when known. */
	folder?: string;
	/** Why a failed worker failed, as its task record wrote it (a worker that dies at spawn still names the cause there). */
	error?: string;
	/** The model and effort the worker runs on, as the owner reads it ("Opus 5.5 medium"), when its record names one. */
	model?: string;
	/** A failed worker's reason as the owner reads it (runstate.ts failureText), so every screen says the same words. */
	reason?: string;
	/** The owner stopped it (중단), so it is no failure of its own. */
	cancelled?: boolean;
};

/** What 중단 answered: done, or why not (an HTTP status for the route). */
export type CancelResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * The conversation a worker's request came from, as the web names it: the main chat for "web"/"terminal"/none, a mail
 * conversation for its Discord thread, else the target itself (a project ch:<id>, a mail:<key>, a settings:<app>).
 */
export function workConversation(target: string | undefined, keyOfThread: (thread: string) => string | undefined): string {
	if (!target || target === "web" || target === "terminal") return "main";
	const thread = /^th:(\d{15,22})$/.exec(target)?.[1];
	if (thread) {
		const key = keyOfThread(thread);
		return key ? `mail:${key}` : "main";
	}
	return target;
}

/** 다시 맡기기: the request handed to the orchestrator again, in the owner's own words when the inbox still has them. */
export function retryText(w: { description: string; reason?: string; cancelled?: boolean }, original?: string): string {
	const why = w.cancelled ? "중단했던" : `실패한(${w.reason || "이유가 기록되지 않았어요"})`;
	const asked = (original ?? "").trim();
	return [`${why} 백그라운드 작업 "${w.description}"을 다시 맡아 주세요.`, asked ? `처음 요청:\n${asked}` : ""].filter(Boolean).join("\n\n");
}

type RecModel = { provider?: string; model_id?: string; display?: string; variant?: string; reasoning_effort?: string; reasoning?: string };
// "claude-opus-5-5" -> "Opus 5.5", "gpt-5.5" -> "Gpt 5.5"; a record's display name ("Claude Opus 5.5") wins over the id.
const modelName = (m: RecModel): string => {
	const shown = m.display && !m.display.includes("/") ? m.display : (m.model_id ?? m.display ?? "").split("/").at(-1)!;
	const words = shown.replace(/^claude[- ]/i, "").replace(/(\d+)-(\d+)/g, "$1.$2").split(/[-\s]+/).filter(Boolean);
	return words.map(w => w[0]!.toUpperCase() + w.slice(1)).join(" ");
};
/** The model a worker record ran on, as one short label: what OmO really used, else what it resolved or was asked. */
export function workModel(r: { effective_model?: RecModel; resolved_model?: RecModel; requested_model?: RecModel; model?: string }): string | undefined {
	const m = r.effective_model ?? r.resolved_model ?? r.requested_model ?? (r.model ? { model_id: r.model } : undefined);
	const name = m ? modelName(m) : "";
	if (!name) return undefined;
	const effort = m?.reasoning_effort ?? m?.reasoning ?? m?.variant ?? r.resolved_model?.reasoning_effort ?? r.resolved_model?.variant;
	return effort ? `${name} ${effort}` : name;
}

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
	spawn_spec?: { cwd?: string; prompt?: string; isolation?: unknown };
	error_message?: string;
	terminal_reason?: string;
	error?: string;
	model?: string;
	requested_model?: RecModel;
	resolved_model?: RecModel;
	effective_model?: RecModel;
};

// Finished work stays listed this long.
export const FINISHED_KEEP_MS = 3600_000;
// A worker spawned this much before the message it serves was delivered (clock rounding) still belongs to it.
const SPAWN_SLACK_MS = 5_000;
// A running record with no pid and no update for this long is a leftover, not a worker (seen: records from 2026-10-19 still "running").
const NO_PID_STALE_MS = 3 * 3600_000;
const RUNNING = new Set(["running", "queued", "pending"]);
const DONE = new Set(["completed", "done", "succeeded"]);

const stamp = (s?: string) => (s ? Date.parse(s) || 0 : 0);
// The folder a worker works for: orchestrator briefs open with "Repo: <absolute path>"; an isolated copy's own cwd says nothing.
function folderOf(r: Rec): string | undefined {
	const s = r.spawn_spec;
	const repo = /^\s*Repo:\s*(\/[^\s;,()]+)/m.exec((s?.prompt ?? "").slice(0, 600))?.[1];
	return repo ?? (s?.cwd && !s.isolation ? s.cwd : undefined);
}
const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

type BgWorkDeps = {
	/** The orchestrator's session file (empty before its first run). */
	sessionFile: () => string | undefined;
	deferred: () => OpenDeferred[];
	/** The owner message the turn running at that time (ms) was answering (prompts.ts turnAt), when a turn of ours was running. */
	turn?: (at: number) => { target: string; replyTo?: string } | undefined;
	now?: () => number;
	/** Is this process still alive? A record that says running while its process is gone is a worker the restart killed. */
	alive?: (pid: number) => boolean;
	/** The hub log: one line per failed worker, so the reason is kept even after the record leaves the list. */
	log?: (message: string) => void;
	/** Sends a signal to a worker process (default process.kill); 중단 ends the worker with it. */
	kill?: (pid: number, signal: NodeJS.Signals) => void;
};
// 중단 waits this long for a worker to end on SIGTERM before it is killed outright.
const STOP_GRACE_MS = 3_000;

export function createBgWork(deps: BgWorkDeps) {
	const now = deps.now ?? Date.now;
	const alive = deps.alive ?? pidAlive;
	// A record is parsed again only when its file changed; the store keeps every task ever run.
	const cache = new Map<string, { stamp: string; rec?: Rec }>();
	// The conversation a worker was waiting for, kept after it ends (the open message is gone then).
	const served = new Map<string, { target: string; reply_to?: string }>();
	// Failures already written to the log (list() runs on every /api/state read).
	const told = new Set<string>();
	// Workers the owner stopped (중단), with when: OmO's record still says running for a while after its process ended.
	const cancelled = new Map<string, number>();
	const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));

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
		// A worker the owner stopped is listed as stopped from then on, whatever OmO's record says; the workers die with the
		// gateway's process tree, and the record of one that died mid-run is never closed by anyone.
		const stoppedAt = cancelled.get(r.task_id!);
		if (stoppedAt !== undefined && status !== "done") {
			status = "failed";
			ended = stoppedAt;
		} else if (status === "running" && typeof r.pid === "number" && !alive(r.pid) && stamp(r.recovery_deadline_at) <= now()) {
			status = "failed";
			ended = stamp(r.updated_at) || started;
		} else if (status === "running" && typeof r.pid !== "number" && now() - (stamp(r.updated_at) || started) > NO_PID_STALE_MS) {
			status = "failed";
			ended = stamp(r.updated_at) || started;
		}
		const description = scrub(String(r.description || r.task_summary || r.category || r.task_id)).replace(/\s+/g, " ").trim().slice(0, 120);
		const folder = folderOf(r);
		const stopped = stoppedAt !== undefined && status === "failed";
		const why = status === "failed" && !stopped ? [r.error_message, r.terminal_reason, r.error].find(v => typeof v === "string" && v.trim()) : undefined;
		const error = why ? scrub(why).replace(/\s+/g, " ").trim().slice(0, 200) : "";
		const model = workModel(r);
		const reason = stopped ? "직접 중단했어요" : status === "failed" ? failureText(error) : "";
		return { id: r.task_id!, description, status, started_at: started, ...(status === "running" ? {} : { ended_at: ended || started }), ...(folder ? { folder } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}), ...(reason ? { reason } : {}), ...(stopped ? { cancelled: true } : {}) };
	}

	/** Running work (oldest first), then what finished within the last hour (newest first). */
	function list(): BgWork[] {
		const file = deps.sessionFile();
		if (!file) return [];
		const t = now();
		const open = deps.deferred().sort((a, b) => a.at - b.at);
		const works = records(file).map(toWork).filter(w => w.status === "running" || t - (w.ended_at ?? 0) <= FINISHED_KEEP_MS);
		for (const w of works) {
			// The turn that spawned the worker is its message; only a worker no turn of ours spawned falls back to the latest
			// deferred message before it (an answered or newer message is no reason to move it: owner 2026-10-23). A worker that
			// failed at spawn was never seen running, so a finished one still asks the turn at its spawn time (st_01a17c03, 2026-10-27).
			const p: { target: string; replyTo?: string; reply_to?: string } | undefined = w.status === "running"
				? (deps.turn?.(w.started_at) ?? served.get(w.id) ?? open.filter(d => d.at <= w.started_at + SPAWN_SLACK_MS).at(-1))
				: (served.get(w.id) ?? deps.turn?.(w.started_at));
			if (p) {
				w.target = p.target;
				const ref = "reply_to" in p ? p.reply_to : p.replyTo;
				if (ref) w.reply_to = ref;
				served.set(w.id, { target: p.target, ...(ref ? { reply_to: ref } : {}) });
			} else {
				const k = served.get(w.id);
				if (k) Object.assign(w, k);
			}
		}
		// A failed worker's reason goes to the hub log once, while it is still in the list (the record itself stays in OmO's store).
		for (const w of works) {
			if (w.status !== "failed" || w.cancelled || told.has(w.id)) continue;
			told.add(w.id);
			deps.log?.(`background work ${w.id} failed${w.target ? ` in ${w.target}` : ""}: ${w.error || "no reason recorded"}`);
		}
		const running = works.filter(w => w.status === "running").sort((a, b) => a.started_at - b.started_at);
		const finished = works.filter(w => w.status !== "running").sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));
		return [...running, ...finished];
	}

	/**
	 * How many workers still run under one OmO session (default: the orchestrator's). The gateway restart gate reads this: the
	 * same task store as list(), so a worker counts whether or not a deferred message waits for it. OmO sends no worker
	 * frames, so the live subagent map (activity.ts runningSubagents) is always 0 for it.
	 */
	function running(file = deps.sessionFile()): number {
		return runningWork(file).length;
	}

	/** The running workers of one OmO session (default: the orchestrator's), oldest first: what a lane's run line names. */
	function runningWork(file = deps.sessionFile()): BgWork[] {
		return file ? records(file).map(toWork).filter(w => w.status === "running").sort((a, b) => a.started_at - b.started_at) : [];
	}

	/**
	 * 중단: ends a running worker's process (SIGTERM, then SIGKILL when it is still there after a grace period) and lists it as
	 * stopped from then on. A worker with no process id cannot be ended from here, and that is said instead of claimed done.
	 */
	async function cancel(id: string, file = deps.sessionFile()): Promise<CancelResult> {
		const rec = file ? records(file).find(r => r.task_id === id) : undefined;
		if (!rec) return { ok: false, status: 404, error: "이 작업을 찾을 수 없어요" };
		if (toWork(rec).status !== "running") return { ok: false, status: 409, error: "이미 끝난 작업이에요" };
		const pid = rec.pid;
		if (typeof pid !== "number") return { ok: false, status: 409, error: "이 작업은 프로세스를 알 수 없어 여기서 멈출 수 없어요" };
		const gone = async (ms: number) => {
			for (let waited = 0; waited < ms; waited += 100) {
				if (!alive(pid)) return true;
				await Bun.sleep(100);
			}
			return !alive(pid);
		};
		try {
			kill(pid, "SIGTERM");
			if (!(await gone(STOP_GRACE_MS))) {
				kill(pid, "SIGKILL");
				if (!(await gone(1_000))) return { ok: false, status: 500, error: "작업 프로세스가 끝나지 않았어요" };
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") return { ok: false, status: 500, error: `작업을 멈추지 못했어요: ${(e as Error).message}` };
		}
		cancelled.set(id, now());
		deps.log?.(`background work ${id} stopped by the owner (pid ${pid})`);
		return { ok: true };
	}

	return { list, running, runningWork, cancel };
}

const anySession = createBgWork({ sessionFile: () => undefined, deferred: () => [] });
/** Running OmO workers under one session file (a lane's, say); 0 for no session. */
export const runningOmoWorkers = (sessionFile: string | undefined): number => anySession.running(sessionFile);
/** The running OmO workers under one session file (a lane's), as records with description, start and model; none for no session. */
export const runningOmoWork = (sessionFile: string | undefined): BgWork[] => (sessionFile ? anySession.runningWork(sessionFile) : []);
/** 중단 for a worker of another session (a lane's). */
export const cancelOmoWorker = (id: string, sessionFile: string | undefined): Promise<CancelResult> => anySession.cancel(id, sessionFile);
