import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessDir } from "../agent-home.ts";
import { setupCommit } from "../gate/log.ts";
import { lastStopReason } from "../guard/limit-lift.ts";
import { say } from "../notice.ts";

/** Why a session restarts: the agent asked for it and goes on after it (`asked`), or the installed harness changed under it (`deployed`); `stopped` when its last run was aborted or ended in an error, so nothing is restarted for it; `clean` when its last run ended normally and nothing has run since, so a deploy restart starts no turn. */
export interface RestartRequest {
	sessionId: string;
	cause: "asked" | "deployed";
	reason: string;
	at: number;
	stopped?: boolean;
	clean?: boolean;
}

/** What the session is doing when a restart is considered: `jobs` counts its running background jobs, `submits` says the composer sends to this session (not to a viewed subagent) and can submit now. */
export interface Moment {
	idle: boolean;
	pending: boolean;
	jobs: number;
	submits: boolean;
	draft: string;
}

/** The part of omp's TUI composer a restart drives: its draft, whether it can submit and which agent it shows, and the native `send` event that submits text as if the user typed it, slash commands included. */
export interface Composer {
	getText(): string;
	handleNativeEvent(event: { type: "send"; text: string }): void;
	readonly nativeSendable?: boolean;
	composerState?(): { viewing?: readonly unknown[] };
}

/** A composer class built the way omp builds its default one, from the theme. */
export type ComposerClass = new (theme: never) => Composer;
type EditorFactory = (tui: unknown, theme: never, keys: unknown) => Composer;

interface Ctx {
	mode?: string;
	agent?: { kind?: string };
	sessionManager?: { getSessionId?(): string; getSessionFile?(): string | undefined; isSessionOnDisk?(): boolean };
	isIdle?(): boolean;
	hasPendingMessages?(): boolean;
	getAsyncJobSnapshot?(): { running?: readonly unknown[] } | null;
	ui?: {
		notify(text: string, level: "info" | "warning"): void;
		getEditorComponent?(): EditorFactory | undefined;
		setEditorComponent?(factory: EditorFactory): void;
	};
}

interface Schema {
	optional(): Schema;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}

/** The omp extension API surface the restart watcher uses. */
export interface RestartApi {
	zod: { object(shape: Record<string, Schema>): Schema; string(): Schema };
	on(event: "session_start" | "session_switch" | "session_shutdown" | "agent_end", handler: (event: { willContinue?: boolean; messages?: readonly unknown[] }, ctx: Ctx) => void | Promise<void>): void;
	registerTool<P>(tool: { name: string; label: string; description: string; parameters: Schema; execute(id: string, params: P | undefined, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<ToolResult> }): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: false }): void;
	sendUserMessage(content: string, options: { attribution: "agent" }): void;
}

/** The restart watcher of one omp process; `check` restarts now when a restart is due and the session is ready for it. */
export interface SessionRestart {
	check(): void;
}

const STALE_MS = 10 * 60_000;
const POLL_MS = 2000;
const RESTART = "/restart";

/** Where the request of a session waits for the process that resumes it; `HARNESS_RESTART_DIR` overrides it for tests. */
export const restartDir = (): string => process.env.HARNESS_RESTART_DIR ?? join(harnessDir(), "state", "restart");

const fileOf = (dir: string, sessionId: string) => join(dir, `${sessionId}.json`);

export function saveRequest(dir: string, request: RestartRequest): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(fileOf(dir, request.sessionId), JSON.stringify(request));
}

/** The request the session left before it restarted, removed as it is read; undefined when there is none or it is older than ten minutes. */
export function takeRequest(dir: string, sessionId: string, now = Date.now()): RestartRequest | undefined {
	let found: RestartRequest;
	try {
		found = JSON.parse(readFileSync(fileOf(dir, sessionId), "utf8")) as RestartRequest;
	} catch {
		return undefined;
	}
	rmSync(fileOf(dir, sessionId), { force: true });
	return found.sessionId === sessionId && now - found.at <= STALE_MS ? found : undefined;
}

/** A restart waits until the session is idle with nothing queued, no background job running, and a composer that submits to it; one for a deploy also waits until nothing is typed in the composer. */
export function readyFor(cause: RestartRequest["cause"], moment: Moment): boolean {
	if (!moment.idle || moment.pending || moment.jobs > 0 || !moment.submits) return false;
	return cause === "asked" || moment.draft.trim() === "";
}

/** The session file omp was relaunched to restore (`--restore <file>` or `--restore=<file>`, how `/restart` re-execs), from the process arguments; undefined for a plain start. */
export function restoredFileOf(argv: readonly string[]): string | undefined {
	for (const [at, arg] of argv.entries()) {
		if (arg.startsWith("--restore=")) return arg.slice("--restore=".length) || undefined;
		if (arg === "--restore") return argv[at + 1]?.startsWith("-") === false ? argv[at + 1] : undefined;
	}
	return undefined;
}

/**
 * The session file this process restores because `/restart` re-exec'd it in place, or undefined. A re-exec keeps the pid and the
 * kernel's process start time (`started`), so a marker of both, left under `dir/pids` by the process before, tells it from an
 * `omp --restore` started from a shell. The marker is written for the next re-exec, and markers of processes no longer alive are removed.
 */
export function markRelaunch(dir: string, pid: number, started: string, argv: readonly string[]): string | undefined {
	const pids = join(dir, "pids");
	mkdirSync(pids, { recursive: true });
	const marker = join(pids, String(pid));
	let previous: string | undefined;
	try {
		previous = readFileSync(marker, "utf8");
	} catch {
		previous = undefined;
	}
	writeFileSync(marker, started);
	for (const name of readdirSync(pids)) if (name !== String(pid) && !alive(Number(name))) rmSync(join(pids, name), { force: true });
	return previous === started ? restoredFileOf(argv) : undefined;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** What the resumed session is told: an asked restart goes on with the task; after a deploy or a `/restart` the user typed (`undefined`), the agent continues unfinished work or says in one line that nothing is left; after a deploy that came while the last run stood stopped, or had ended normally, it waits for the user. */
export function resumedText(request: RestartRequest | undefined, loaded: string | undefined): string {
	const harness = loaded === undefined ? "" : ` Harness ${loaded} is loaded.`;
	if (request?.cause === "asked") return `session-restart: omp restarted as you asked (${request.reason}).${harness} Continue the task from where you left off; do not redo finished steps.`;
	if (request?.stopped === true) return `session-restart: omp restarted to load the deployed harness.${harness} The last run was stopped (aborted or errored) before it, so nothing was resumed; wait for the user.`;
	if (request?.clean === true) return `session-restart: omp restarted to load the deployed harness.${harness} The last run ended normally before it, so no turn was started; wait for the user.`;
	const why = request === undefined ? "omp was restarted" : "omp restarted to load the deployed harness";
	return `session-restart: ${why}.${harness} If the task you were on is unfinished (open todos, a pending step, a worker or check result you were waiting for), continue it now without redoing finished steps; if everything is done, reply with one short line that says so.`;
}

const text = (body: string, isError = false): ToolResult => ({ content: [{ type: "text", text: body }], details: {}, ...(isError ? { isError } : {}) });

/**
 * Lets an interactive main session restart itself the way `/restart` does, by submitting `/restart` through its own composer:
 * when the agent asks (`session_restart`, once the run ends; the resumed session gets a turn to continue; a run the user stops
 * or that errors drops the request), and when the harness deployed on this machine is no longer the one this process loaded
 * (once the session is idle with nothing typed). Either waits while `pendingWork` (done-gate checks left running after a stop)
 * is not zero, since a restart would lose their results. The resumed session is told once it has started and is idle, never
 * from inside `session_start`, so the turn runs on the settled tool devices. An asked restart and a `/restart` the user typed
 * (the first session of a process whose `restoredFile` is its own file) resume with a turn, sent as a prompt attributed to
 * the agent rather than a custom message: omp recalls memory only for a prompt, and a turn without that block runs on a
 * system prompt unlike the next turn's, so both turns would rewrite the whole context. The turn continues unfinished work or
 * says in one line that nothing is left; a deploy restart after a run that ended normally, or that was stopped, only adds the
 * message to the context. Workers, print, RPC and ACP sessions are left alone. A restart that does not happen is not tried
 * again for the same commit.
 */
export function createSessionRestart(pi: RestartApi, loadComposer: () => Promise<ComposerClass>, pendingWork: () => number, restoredFile: () => string | undefined): SessionRestart {
	let restoreChecked = false;
	const dir = restartDir();
	const loaded = setupCommit();
	let ctx: Ctx | undefined;
	let sessionId: string | undefined;
	let composer: Composer | undefined;
	let asked: RestartRequest | undefined;
	let resume: { content: string; turn: boolean } | undefined;
	let runEnded = true;
	let stopped = false;
	let clean = false;
	let tried: string | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;

	const restart = (request: RestartRequest) => {
		if (ctx?.sessionManager?.isSessionOnDisk?.() !== false) saveRequest(dir, { ...request, at: Date.now() });
		composer?.handleNativeEvent({ type: "send", text: RESTART });
	};

	const check = () => {
		if (ctx === undefined || sessionId === undefined) return;
		const idle = ctx.isIdle?.() === true && ctx.hasPendingMessages?.() !== true;
		if (resume !== undefined) {
			if (!idle) return;
			const { content, turn } = resume;
			resume = undefined;
			if (turn) pi.sendUserMessage(content, { attribution: "agent" });
			else pi.sendMessage({ customType: "session-restart", content, display: true }, { triggerTurn: false });
			return;
		}
		if (composer === undefined) return;
		const moment: Moment = {
			idle: ctx.isIdle?.() === true,
			pending: ctx.hasPendingMessages?.() === true,
			jobs: (ctx.getAsyncJobSnapshot?.()?.running?.length ?? 0) + pendingWork(),
			submits: composer.nativeSendable !== false && (composer.composerState?.().viewing?.length ?? 0) === 0,
			draft: composer.getText(),
		};
		if (asked !== undefined) {
			if (!runEnded || !readyFor("asked", moment)) return;
			const request = asked;
			asked = undefined;
			restart(request);
			return;
		}
		const deployed = setupCommit();
		if (loaded === undefined || deployed === undefined || deployed === loaded || deployed === tried || !readyFor("deployed", moment)) return;
		tried = deployed;
		restart({ sessionId, cause: "deployed", reason: `harness ${deployed} deployed`, at: Date.now(), ...(stopped ? { stopped } : {}), ...(clean ? { clean } : {}) });
	};

	const leave = () => {
		clearInterval(poll);
		poll = undefined;
		ctx = undefined;
		sessionId = undefined;
		composer = undefined;
		asked = undefined;
		resume = undefined;
		runEnded = true;
		stopped = false;
		clean = false;
	};

	const join = async (next: Ctx) => {
		leave();
		const id = next.sessionManager?.getSessionId?.();
		const ui = next.ui;
		if (next.agent?.kind !== "main" || next.mode !== "tui" || id === undefined || ui?.setEditorComponent === undefined) return;
		const resumed = takeRequest(dir, id);
		const typed = !restoreChecked && resumed === undefined && restoredFile() !== undefined && restoredFile() === next.sessionManager?.getSessionFile?.();
		restoreChecked = true;
		clean = resumed?.clean === true;
		if (resumed !== undefined || typed) {
			const turn = resumed?.stopped !== true && !(resumed?.cause === "deployed" && resumed.clean === true);
			resume = { content: resumedText(resumed, loaded), turn };
		}
		ctx = next;
		sessionId = id;
		if (process.env.HARNESS_RESTART_WATCH !== "0") {
			poll = setInterval(check, POLL_MS);
			poll.unref?.();
		}
		let Base: ComposerClass;
		try {
			Base = await loadComposer();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ui.notify(say({ en: `session-restart: the TUI composer could not be loaded (${reason}); this session cannot restart itself.`, ko: `session-restart: TUI 입력창을 불러오지 못했습니다(${reason}). 이 세션은 스스로 재시작할 수 없습니다.` }), "warning");
			return;
		}
		const previous = ui.getEditorComponent?.();
		ui.setEditorComponent((tui, theme, keys) => {
			const made = previous === undefined ? new Base(theme) : previous(tui, theme, keys);
			composer = made;
			return made;
		});
	};

	pi.on("session_start", (_event, started) => join(started));
	pi.on("session_switch", (_event, switched) => join(switched));
	pi.on("session_shutdown", () => leave());
	pi.on("agent_end", event => {
		if (event.willContinue === true) return;
		const reason = lastStopReason(event.messages);
		stopped = reason === "aborted" || reason === "error";
		clean = reason === "stop";
		if (stopped) asked = undefined;
		runEnded = true;
		check();
	});

	pi.registerTool<{ reason?: string }>({
		name: "session_restart",
		label: "Restart this session",
		description:
			"Restart omp the way /restart does, so changed extensions or a freshly deployed harness are loaded, and go on: the restart runs once this turn ends, resumes this session, and starts a new turn telling you to continue. Use it instead of asking the user to run /restart. After calling it, end the turn with one short line.",
		parameters: pi.zod.object({ reason: pi.zod.string() }),
		async execute(_id, params) {
			if (composer === undefined || sessionId === undefined) return text("session_restart: only an interactive (TUI) main session can restart itself; this one cannot.", true);
			asked = { sessionId, cause: "asked", reason: String(params?.reason ?? "").trim() || "no reason given", at: Date.now() };
			runEnded = false;
			return text("Restart queued: it runs once this turn ends and the session is idle; the resumed session starts a turn asking you to continue. End this turn now with one short line.");
		},
	});

	return { check };
}
