// The orchestrator's background task workers: what a turn that ended with `[later]` is waiting for. OmO keeps one record per
// task in its task store (<agent dir>/projects/*/senpi-task/tasks/<id>.json: status, spawn time, the Korean one-line
// description the orchestrator wrote at the spawn, end time) and the store outlives the gateway, so this list is read from
// there and a restart rebuilds it by itself. The store's root_session_id ties a worker to the orchestrator's session file
// (the uuid ending its name), as for a session's workers in activity.ts omoTasks.
//
// A worker belongs to the owner message of the turn that spawned it (prompts.ts turnAt); one spawned by no turn of ours (a
// run a worker's result woke, a restart) belongs to the latest still-open deferred message delivered before its spawn.
// Finished workers keep no such message, nothing waits for them.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { scrub } from "./activity.ts";
import { expand } from "./config.ts";
import { fileLinePaths } from "./files.ts";
import { failureText } from "./runstate.ts";
import { previewSource } from "./tone.ts";

type BgWork = {
	id: string;
	/** The short description written at the spawn (Korean, as the orchestrator wrote it). */
	description: string;
	/** stalled: OmO still says running, but the worker no longer works (its last event an error, or no activity for a while). */
	status: "running" | "stalled" | "done" | "failed";
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
	/** A stalled worker's own working folder (its worktree), for the session to finish or relaunch it there. */
	workdir?: string;
	/** The owner stopped it (중단), so it is no failure of its own. */
	cancelled?: boolean;
	/** A finished worker's result files: the `[file]` lines of its report that name an existing file (the web shows them as file chips). */
	files?: WorkFile[];
	/** A failure the session already took up: one of its turns ended after the worker failed (it read OmO's failure notice, or the
	 * gateway's handover below). Nothing is asked of the owner about it. */
	handled?: boolean;
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
	/** The worker's last message (its report): OmO says "completed" for a worker that ended on its token cap and reported [fail]. */
	final_response?: string;
	model?: string;
	requested_model?: RecModel;
	resolved_model?: RecModel;
	effective_model?: RecModel;
};

type WorkFile = { path: string; name: string; size: number };
const RESULT_FILES_MAX = 6;
// A report names its outputs in `[file]` lines, or as a backticked absolute path to a document, page, sheet or image it made.
const RESULT_EXT = /\.(md|markdown|txt|pdf|html?|csv|tsv|xlsx?|docx?|pptx?|hwpx?|png|jpe?g|gif|webp|svg|json|zip)$/i;
const backtickPaths = (text: string) => [...text.matchAll(/`((?:~|\/)[^`\n]+?)`/g)].map(m => m[1]!).filter(p => RESULT_EXT.test(p));
function resultFiles(report: string | undefined): WorkFile[] {
	const out: WorkFile[] = [];
	for (const line of report ? new Set([...fileLinePaths(report), ...backtickPaths(report)]) : []) {
		const path = expand(line);
		if (!path.startsWith("/") || !existsSync(path) || out.some(f => f.path === path)) continue;
		const st = statSync(path);
		if (st.isFile()) out.push({ path, name: basename(path), size: st.size });
		if (out.length === RESULT_FILES_MAX) break;
	}
	return out;
}

// Finished work stays listed this long.
export const FINISHED_KEEP_MS = 3600_000;
// A worker spawned this much before the message it serves was delivered (clock rounding) still belongs to it.
const SPAWN_SLACK_MS = 5_000;
// A running record with no pid and no update for this long is a leftover, not a worker (seen: records from 2026-10-19 still "running").
const NO_PID_STALE_MS = 3 * 3600_000;
const RUNNING = new Set(["running", "queued", "pending"]);
// A running worker with no transcript or task-log activity for this long is stalled (DOTZ_WORKER_STALL_MIN, default 15).
export const STALL_IDLE_MS = Number(process.env.DOTZ_WORKER_STALL_MIN ?? 15) * 60_000;
// A worker whose task log ends on an error is stalled once no retry or fallback followed it for this long (OmO retries in seconds).
export const STALL_ERROR_MS = 2 * 60_000;
// OmO's task-log events that end a worker's run while its record stays "running" (st_01a19af7, 2026-11-02: a usage limit, then
// 1.5 h idle and still running, holding the gateway restart and "지금 진행 중").
const ERROR_EVENTS = new Set(["child_error", "retry_fallback_exhausted"]);
// Only the end of a task log is read.
const LOG_TAIL_BYTES = 8 * 1024;
const DONE = new Set(["completed", "done", "succeeded"]);

const stamp = (s?: string) => (s ? Date.parse(s) || 0 : 0);
// A report whose status line is [fail] (after an optional "Ask: ..." handoff block, as custom.ts reportHead reads it): that line, unmarked.
const MARK_LINE = /^\s*(?:[-*]\s*)?\**\s*\[(done|run|ask|fail|later|완료)\]\**\s*/i;
function failLine(text: string | undefined): string | undefined {
	const line = previewSource(String(text ?? "")).split("\n").find(l => MARK_LINE.test(l));
	const m = line ? MARK_LINE.exec(line) : null;
	return m && m[1]!.toLowerCase() === "fail" ? line!.slice(m[0].length).replace(/\*\*/g, "").trim() || "[fail]" : undefined;
}
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
	/** When the session's last turn ended (ms): a failure before it was taken up by that turn. */
	turnEndedAt?: () => number;
	/** Is the session in a turn now? A failure is handed over only to an idle session (a running one reads OmO's notice itself). */
	busy?: () => boolean;
	/** The safety net for a failure the session never took up: hand it to the session to fix and finish (owner 2026-10-29: "왜
	 * 재요청을 나에게 물어보지? 알아서 수정해서 목표 달성해야지"). Called once per worker. */
	handover?: (w: BgWork) => void;
	/** Is the session paused on a usage limit? A stalled worker is then named in its resume note instead of a wake of its own. */
	paused?: () => boolean;
	/** Wakes the session once per stalled worker, so it finishes or relaunches the work; the worker itself is never killed. */
	stalled?: (w: BgWork) => void;
	/** No activity for this long makes a running worker stalled (default STALL_IDLE_MS). */
	stallMs?: number;
	/** Sends a signal to a worker process (default process.kill); 중단 ends the worker with it. */
	kill?: (pid: number, signal: NodeJS.Signals) => void;
};
// A failure no turn took up this long after it ended is handed over (OmO's own notice wakes the session within seconds).
export const HANDOVER_AFTER_MS = 3 * 60_000;
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
	// Failures already handed to the session (once each; a restart re-reads turnEndedAt, which the handed turn moved past them).
	const handed = new Set<string>();
	// Workers the owner stopped (중단), with when: OmO's record still says running for a while after its process ended.
	const cancelled = new Map<string, number>();
	// The OmO store (<project>/senpi-task) each record was read from: its task log and transcripts live there.
	const storeOf = new Map<string, string>();
	// The last event of each task log, read again only when the log changed.
	const lastEvent = new Map<string, { stamp: string; type?: string; message?: string }>();
	// Stalled workers already logged, and already woken for (by a wake or a resume note).
	const stallTold = new Set<string>();
	const woken = new Set<string>();
	const stallMs = deps.stallMs ?? STALL_IDLE_MS;
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
				if (hit.rec?.root_session_id === root && hit.rec.task_id) {
					out.push(hit.rec);
					storeOf.set(hit.rec.task_id, join(projects, project, "senpi-task"));
				}
			}
		}
		return out;
	}

	// Why a worker OmO still lists as running no longer works, and since when; undefined while it works or nothing shows either
	// way (no task log, no transcript). Reads the task log's tail and the newest transcript's time only, never a whole file.
	function stallOf(id: string): { reason: string; error?: string; since: number } | undefined {
		const store = storeOf.get(id);
		if (!store) return undefined;
		const mtime = (file: string) => {
			try {
				return statSync(file).mtimeMs;
			} catch {
				return 0;
			}
		};
		const log = join(store, "logs", `${id}.jsonl`);
		const logAt = mtime(log);
		const dir = join(store, "children", id, "sessions", id);
		let seen = logAt;
		try {
			for (const n of readdirSync(dir)) if (n.endsWith(".jsonl")) seen = Math.max(seen, mtime(join(dir, n)));
		} catch {}
		if (!seen) return undefined;
		const t = now();
		const last = logAt ? lastLogEvent(log) : undefined;
		if (last?.type && ERROR_EVENTS.has(last.type) && t - logAt >= STALL_ERROR_MS) {
			const error = scrub(last.message || last.type).replace(/\s+/g, " ").trim().slice(0, 200);
			return { reason: failureText(error), error, since: logAt };
		}
		if (t - seen >= stallMs) return { reason: `${Math.round((t - seen) / 60_000)}분째 활동이 없어요`, since: seen };
		return undefined;
	}
	function lastLogEvent(file: string): { type?: string; message?: string } | undefined {
		let size: number, changed: string;
		try {
			const s = statSync(file);
			size = s.size;
			changed = `${s.mtimeMs}:${s.size}`;
		} catch {
			return undefined;
		}
		const hit = lastEvent.get(file);
		if (hit?.stamp === changed) return hit;
		const len = Math.min(size, LOG_TAIL_BYTES);
		const buf = Buffer.alloc(len);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buf, 0, len, size - len);
		} finally {
			closeSync(fd);
		}
		let found: { stamp: string; type?: string; message?: string } = { stamp: changed };
		for (const line of buf.toString("utf8").split("\n").reverse()) {
			try {
				const e = JSON.parse(line) as { type?: string; payload?: { message?: unknown } };
				found = { stamp: changed, type: e.type, ...(typeof e.payload?.message === "string" ? { message: e.payload.message } : {}) };
				break;
			} catch {}
		}
		lastEvent.set(file, found);
		return found;
	}

	function toWork(r: Rec): BgWork {
		const started = stamp(r.started_at) || stamp(r.created_at) || stamp(r.updated_at);
		const raw = (r.status ?? "").toLowerCase();
		let status: BgWork["status"] = RUNNING.has(raw) ? "running" : DONE.has(raw) ? "done" : "failed";
		let ended = stamp(r.terminal_at) || stamp(r.updated_at);
		// OmO's "completed" only says the process ended; a worker that stopped on its token cap or an error reports [fail] (st_01a19616).
		const reported = status === "done" ? failLine(r.final_response) : undefined;
		if (reported) status = "failed";
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
		const stall = status === "running" ? stallOf(r.task_id!) : undefined;
		if (stall) {
			status = "stalled";
			ended = stall.since;
		}
		const description = scrub(String(r.description || r.task_summary || r.category || r.task_id)).replace(/\s+/g, " ").trim().slice(0, 120);
		const folder = folderOf(r);
		if (stall) {
			const model = workModel(r);
			const workdir = r.spawn_spec?.cwd;
			return { id: r.task_id!, description, status, started_at: started, ended_at: stall.since, ...(folder ? { folder } : {}), ...(workdir ? { workdir } : {}), ...(stall.error ? { error: stall.error } : {}), ...(model ? { model } : {}), reason: stall.reason };
		}
		const stopped = stoppedAt !== undefined && status === "failed";
		const why = status === "failed" && !stopped ? [r.error_message, r.terminal_reason, r.error, reported].find(v => typeof v === "string" && v.trim()) : undefined;
		const error = why ? scrub(why).replace(/\s+/g, " ").trim().slice(0, 200) : "";
		const model = workModel(r);
		const reason = stopped ? "직접 중단했어요" : status === "failed" ? failureText(error) : "";
		const files = status === "done" ? resultFiles(r.final_response) : [];
		return { id: r.task_id!, description, status, started_at: started, ...(status === "running" ? {} : { ended_at: ended || started }), ...(folder ? { folder } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}), ...(reason ? { reason } : {}), ...(stopped ? { cancelled: true } : {}), ...(files.length ? { files } : {}) };
	}

	/** Running work (oldest first), then what finished within the last hour (newest first). */
	function list(): BgWork[] {
		const file = deps.sessionFile();
		if (!file) return [];
		const t = now();
		const open = deps.deferred().sort((a, b) => a.at - b.at);
		const works = records(file).map(toWork).filter(w => w.status === "running" || w.status === "stalled" || t - (w.ended_at ?? 0) <= FINISHED_KEEP_MS);
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
		const ended = deps.turnEndedAt?.() ?? 0;
		for (const w of works) {
			if (w.status !== "failed" || w.cancelled) continue;
			if (ended > (w.ended_at ?? 0)) {
				w.handled = true;
				continue;
			}
			if (!deps.handover || handed.has(w.id) || t - (w.ended_at ?? 0) < HANDOVER_AFTER_MS || deps.busy?.()) continue;
			handed.add(w.id);
			deps.log?.(`background work ${w.id} failed and no turn took it up: handed to the session to fix and finish`);
			deps.handover(w);
		}
		wake(works);
		const running = works.filter(w => w.status === "running").sort((a, b) => a.started_at - b.started_at);
		const finished = works.filter(w => w.status !== "running").sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));
		return [...running, ...finished];
	}

	// A stalled worker is logged once and its session woken once, while it is idle and not paused on a usage limit (the resume
	// note names it then, takeStalled). It is never stopped from here: the session decides.
	function wake(works: BgWork[]): void {
		for (const w of works) {
			if (w.status !== "stalled") continue;
			if (!stallTold.has(w.id)) {
				stallTold.add(w.id);
				deps.log?.(`background work ${w.id} stalled (still running in OmO's store): ${w.error || w.reason}`);
			}
			if (!deps.stalled || woken.has(w.id) || deps.busy?.() || deps.paused?.()) continue;
			woken.add(w.id);
			deps.stalled(w);
		}
	}

	/** The stalled workers no wake named yet, marked as named: what the usage-limit resume note lists. */
	function takeStalled(file = deps.sessionFile()): BgWork[] {
		const out = file ? records(file).map(toWork).filter(w => w.status === "stalled" && !woken.has(w.id)) : [];
		for (const w of out) woken.add(w.id);
		return out;
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
		if (!file) return [];
		const works = records(file).map(toWork);
		// The restart gate polls this while it waits: a stalled worker it no longer waits for is handed to its session from here too.
		wake(works);
		return works.filter(w => w.status === "running").sort((a, b) => a.started_at - b.started_at);
	}

	/**
	 * 중단: ends a running worker's process (SIGTERM, then SIGKILL when it is still there after a grace period) and lists it as
	 * stopped from then on. A worker with no process id cannot be ended from here, and that is said instead of claimed done.
	 */
	async function cancel(id: string, file = deps.sessionFile()): Promise<CancelResult> {
		const rec = file ? records(file).find(r => r.task_id === id) : undefined;
		if (!rec) return { ok: false, status: 404, error: "이 작업을 찾을 수 없어요" };
		const st = toWork(rec).status;
		if (st !== "running" && st !== "stalled") return { ok: false, status: 409, error: "이미 끝난 작업이에요" };
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

	return { list, running, runningWork, takeStalled, cancel };
}

const anySession = createBgWork({ sessionFile: () => undefined, deferred: () => [] });
/** Running OmO workers under one session file (a lane's, say); 0 for no session. */
export const runningOmoWorkers = (sessionFile: string | undefined): number => anySession.running(sessionFile);
/** The running OmO workers under one session file (a lane's), as records with description, start and model; none for no session. */
export const runningOmoWork = (sessionFile: string | undefined): BgWork[] => (sessionFile ? anySession.runningWork(sessionFile) : []);
/** 중단 for a worker of another session (a lane's). */
export const cancelOmoWorker = (id: string, sessionFile: string | undefined): Promise<CancelResult> => anySession.cancel(id, sessionFile);
