// The Claude Code adapter: runs the user's own `claude` CLI (their login, no API key handled by dotz) as one long-lived
// `claude -p --input-format stream-json --output-format stream-json` process and turns its JSON lines into AgentEvents.
// Everything that knows a Claude Code frame, CLI argument, per-run settings file or session-file layout lives here.
//
// What the CLI does (observed with claude 2.1.x, see fixtures/claude-stream.jsonl):
//  - stdin: one `{"type":"user","message":{"role":"user","content":"..."}}` line per message. A message that arrives
//    while a turn runs is injected at the next tool boundary (steer); `"priority":"later"` queues it behind the turn.
//    `{"type":"control_request","request_id":..,"request":{"subtype":"interrupt"|"get_context_usage"}}` aborts a turn /
//    reports the context size. A `/compact` message compacts the session (slash command).
//  - stdout: `system` frames (init once per turn, compaction, model fallback, task_*), `assistant` frames (one content
//    block each, the same message id for the blocks of one API message, stop_reason always null), `user` frames
//    (--replay-user-messages echoes the prompts; tool results), one `result` frame per turn (stop_reason, usage, window).
//    The CLI keeps no turn-start frame, so `init` / the first echoed prompt / the first assistant block open a turn.
//  - effort: `--effort low|medium|high|xhigh|max`; dotz's off and minimal have no counterpart and run as low, auto leaves
//    the CLI default.
//  - Bash rules: the owner's RULES.md deny lines are enforced by a PreToolUse hook (claude-deny-hook.ts) wired through a
//    per-run `--settings` file; ~/.claude is never edited.
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { summary } from "../activity.ts";
import { DATA_DIR, log, parseSelector } from "../config.ts";
import { isNote } from "../i18n.ts";
import { classifyProviderError } from "../providers.ts";
import { type Probes, makeProbes } from "./claude-probes.ts";
import { detectBinary } from "./detect.ts";
import type { ActivityRow, AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts, SubagentUpdate } from "./types.ts";

const CLAUDE = process.env.DOTZ_CLAUDE ?? "claude";
const DENY_HOOK = join(import.meta.dir, "claude-deny-hook.ts");

// A frame is read through optional chaining; the CLI's frame set grows with its versions, so nothing here is strict.
type Frame = Record<string, any>;

const EFFORT: Record<string, string | undefined> = { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", auto: undefined };

// dotz selector (`anthropic/<id>[:thinking]`) -> what `--model` takes. Only Anthropic models run here.
export function claudeModel(selector: string): string {
	const id = parseSelector(selector).model;
	const slash = id.indexOf("/");
	if (slash < 0) return id;
	if (id.slice(0, slash) !== "anthropic") throw new Error(`the claude runtime runs Anthropic models only; "${selector}" is a ${id.slice(0, slash)} model`);
	return id.slice(slash + 1);
}

const textOfBlocks = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter(b => b?.type === "text" || typeof b === "string").map(b => (typeof b === "string" ? b : b.text ?? "")).join("")
			: "";

// Prompts the CLI echoes that are not the owner's message: local-command output, its own bookkeeping tags.
const INTERNAL_USER = /^<(local-command|command-name|command-message|system-reminder|task-notification)/;

// Frame -> events state machine: what a turn is, which assistant block group is one message, which request is pending.
export class ClaudeFrames {
	busy = false;
	session: string | undefined;
	// A requested /compact is running: its init/result frames are not a turn.
	compacting = false;
	aborting = false;
	private model: string | undefined;
	private pending: { id: string; text: string; tool: boolean } | undefined;
	private apiError: { text: string; code: string } | undefined;
	private compactSettled = false;
	// --autocompact makes the CLI's window the given size (it compacts about 33k tokens below it) and reports that as the
	// window, so the model's own window in `result` frames would flip the number every turn.
	constructor(private readonly autocompact?: number) {}
	private toolNames = new Map<string, string>();
	readonly requests = new Map<string, "usage" | "interrupt">();

	private startTurn(out: AgentEvent[]): void {
		if (this.busy) return;
		this.busy = true;
		if (this.compacting) return;
		out.push({ type: "activity", row: { type: "turn_start", text: "turn started" } }, { type: "turn_start" });
	}

	private flush(out: AgentEvent[], stop: "stop" | "length" | "aborted" | "other"): void {
		const p = this.pending;
		if (!p) return;
		this.pending = undefined;
		out.push({ type: "assistant", text: p.text.trim(), stop: p.tool && stop !== "aborted" ? "other" : stop });
	}

	push(f: Frame): AgentEvent[] {
		const out: AgentEvent[] = [{ type: "alive" }];
		switch (f.type) {
			case "system":
				this.system(f, out);
				break;
			case "user":
				this.user(f, out);
				break;
			case "assistant":
				this.assistant(f, out);
				break;
			case "result":
				this.result(f, out);
				break;
			case "control_response":
				this.control(f, out);
				break;
		}
		return out;
	}

	// The stream ended: an API error that never got its result frame still reaches the hub.
	end(): AgentEvent[] {
		const out: AgentEvent[] = [];
		if (this.apiError) this.emitError(out, this.apiError.text, this.apiError.code);
		return out;
	}

	private system(f: Frame, out: AgentEvent[]): void {
		switch (f.subtype) {
			case "init":
				this.model = typeof f.model === "string" ? f.model : this.model;
				if (typeof f.session_id === "string" && f.session_id !== this.session) {
					this.session = f.session_id;
					out.push({ type: "session", ref: f.session_id });
					if (this.autocompact) out.push({ type: "usage", window: this.autocompact });
				}
				this.startTurn(out);
				break;
			case "status":
				if (f.status === "compacting") {
					if (!this.compacting) out.push({ type: "activity", row: { type: "status", text: "compacting context" } });
				} else if (typeof f.compact_result === "string") {
					if (f.compact_result === "success") out.push({ type: "activity", row: { type: "status", text: "context compacted" } });
					else this.compactError(out, `compaction ${f.compact_result}`);
				}
				break;
			case "compact_boundary": {
				const meta = f.compact_metadata ?? {};
				this.compactSettled = true;
				out.push({ type: "compaction", state: "done", tokensBefore: typeof meta.pre_tokens === "number" ? meta.pre_tokens : undefined });
				if (typeof meta.post_tokens === "number") out.push({ type: "usage", tokens: meta.post_tokens });
				break;
			}
			case "model_fallback":
				out.push({ type: "activity", row: { type: "status", text: String(f.content ?? `switched model: ${f.original_model} -> ${f.fallback_model}`) } });
				out.push({ type: "fallback", from: String(f.original_model ?? ""), to: String(f.fallback_model ?? ""), ...(f.trigger ? { reason: String(f.trigger) } : {}) });
				break;
			case "task_started":
			case "task_progress":
			case "task_notification": {
				const update = subagentUpdate(f);
				if (update) out.push({ type: "subagent", update });
				break;
			}
		}
	}

	private compactError(out: AgentEvent[], error: string): void {
		this.compactSettled = true;
		out.push({ type: "compaction", state: "error", error: error.slice(0, 300), requested: this.compacting });
	}

	private user(f: Frame, out: AgentEvent[]): void {
		if (f.parent_tool_use_id) return; // a task worker's own conversation; its progress arrives as task_* frames
		const content = f.message?.content;
		if (Array.isArray(content) && content.some(b => b?.type === "tool_result")) {
			this.flush(out, "other");
			for (const b of content) {
				if (b?.type !== "tool_result") continue;
				const id = String(b.tool_use_id ?? "");
				out.push({ type: "activity", row: { type: "tool_result", tool: this.toolNames.get(id), call_id: id, text: textOfBlocks(b.content), is_error: Boolean(b.is_error) } });
			}
			return;
		}
		if (f.isReplay !== true) return; // interrupt notices and the post-compaction summary are the CLI's own messages
		const text = textOfBlocks(content).trim();
		if (!text || INTERNAL_USER.test(text)) return;
		this.startTurn(out);
		if (!isNote(text, "youAre")) out.push({ type: "activity", row: { type: "status", text: `> ${text.slice(0, 400)}` } });
		out.push({ type: "user", text });
	}

	private assistant(f: Frame, out: AgentEvent[]): void {
		if (f.parent_tool_use_id) return;
		const m = f.message ?? {};
		if (f.is_api_error_message) {
			this.flush(out, "other");
			this.apiError = { text: textOfBlocks(m.content).trim() || String(f.error ?? "model request failed"), code: String(f.error ?? "").replace(/_/g, " ") };
			return;
		}
		this.startTurn(out);
		const id = String(m.id ?? "");
		if (this.pending && this.pending.id !== id) this.flush(out, "other");
		this.pending ??= { id, text: "", tool: false };
		for (const b of Array.isArray(m.content) ? m.content : []) {
			if (b?.type === "thinking" && String(b.thinking ?? "").trim()) out.push({ type: "activity", row: { type: "thinking", text: b.thinking.trim() } });
			else if (b?.type === "text" && String(b.text ?? "").trim()) {
				this.pending.text += b.text;
				out.push({ type: "activity", row: { type: "text", text: b.text.trim() } });
			} else if (b?.type === "tool_use") {
				this.pending.tool = true;
				this.toolNames.set(String(b.id ?? ""), String(b.name ?? ""));
				out.push({ type: "activity", row: toolCall(b) });
			}
		}
		const u = m.usage;
		if (u && m.model !== "<synthetic>") out.push({ type: "usage", tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) });
	}

	private emitError(out: AgentEvent[], text: string, code: string): void {
		this.apiError = undefined;
		out.push({ type: "activity", row: { type: "error", text, is_error: true } });
		out.push({ type: "assistant", text: "", stop: "error", error: { text, kind: classifyProviderError(`${code} ${text}`), compaction: false } });
	}

	private result(f: Frame, out: AgentEvent[]): void {
		const usage = f.modelUsage && typeof f.modelUsage === "object" ? (f.modelUsage[this.model ?? ""] ?? Object.values(f.modelUsage)[0]) : undefined;
		if (!this.autocompact && typeof usage?.contextWindow === "number" && usage.contextWindow > 0) out.push({ type: "usage", window: usage.contextWindow });
		const wasCompacting = this.compacting;
		const aborted = this.aborting || /abort/i.test(String(f.terminal_reason ?? ""));
		this.busy = false;
		this.compacting = false;
		this.aborting = false;
		if (wasCompacting) {
			this.pending = undefined;
			if (!this.compactSettled) {
				this.compacting = true;
				this.compactError(out, f.is_error ? String(f.result ?? "compaction failed") : "compaction did not run");
				this.compacting = false;
			}
			this.compactSettled = false;
			return;
		}
		if (this.apiError) {
			this.emitError(out, this.apiError.text, `${f.api_error_status ?? ""} ${this.apiError.code}`.trim());
			this.pending = undefined;
		} else if (aborted) {
			if (!this.pending) this.pending = { id: "", text: "", tool: false };
			out.push({ type: "activity", row: { type: "status", text: "aborted" } });
			this.flush(out, "aborted");
		} else if (f.is_error) {
			this.flush(out, "other");
			this.emitError(out, String(f.result ?? "model request failed"), `${f.api_error_status ?? ""} ${f.terminal_reason ?? ""}`.trim());
		} else this.flush(out, f.stop_reason === "end_turn" || f.stop_reason === "stop_sequence" ? "stop" : f.stop_reason === "max_tokens" ? "length" : "other");
		out.push({ type: "activity", row: { type: "turn_end", text: "turn finished" } }, { type: "turn_end" });
	}

	private control(f: Frame, out: AgentEvent[]): void {
		const r = f.response ?? {};
		const kind = this.requests.get(String(r.request_id ?? ""));
		this.requests.delete(String(r.request_id ?? ""));
		if (kind !== "usage" || r.subtype !== "success") return;
		const d = r.response ?? {};
		const tokens = typeof d.totalTokens === "number" ? d.totalTokens : undefined;
		const window = typeof d.maxTokens === "number" && d.maxTokens > 0 ? d.maxTokens : undefined;
		if (tokens !== undefined || window !== undefined) out.push({ type: "usage", tokens, window });
	}
}

function toolCall(b: Frame): ActivityRow {
	const args = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
	// Claude's Bash/Task calls carry `description`, the model's own one-line intent; the other tools show command/path/pattern.
	const label = summary(args, typeof args.description === "string" ? args.description : undefined);
	return { type: "tool_call", tool: b.name, call_id: b.id, intent: label, text: label ? `${b.name}: ${label}` : String(b.name ?? ""), args: JSON.stringify(args, null, 2) };
}

// A task worker (the Agent/Task tool) as `task_*` system frames report it; shell tasks (`local_bash`) are not workers.
function subagentUpdate(f: Frame): SubagentUpdate | undefined {
	if (f.task_type !== "local_agent" && f.subtype !== "task_notification") return undefined;
	const id = String(f.task_id ?? "");
	if (!id) return undefined;
	const raw = String(f.status ?? "").toLowerCase();
	const status = f.subtype !== "task_notification" ? "running" : /fail|error/.test(raw) ? "failed" : /stop|kill|abort|cancel/.test(raw) ? "aborted" : "done";
	return {
		id,
		agent: typeof f.subagent_type === "string" ? f.subagent_type : undefined,
		description: f.description ? String(f.description) : f.summary ? String(f.summary) : undefined,
		status,
		tool: typeof f.last_tool_name === "string" ? f.last_tool_name : undefined,
		intent: f.subtype === "task_progress" && f.description ? String(f.description) : undefined,
		transcript: typeof f.output_file === "string" && f.output_file ? f.output_file : undefined,
	};
}

class ClaudeProcess implements AgentProcess {
	private seq = 0;
	private readonly frames: ClaudeFrames;
	private readonly queue: AgentEvent[] = [];
	private wake: (() => void) | undefined;
	private done = false;
	private stderr = "";
	readonly events: AsyncIterable<AgentEvent> = this.read();
	readonly exited: Promise<number>;
	constructor(private readonly proc: Subprocess<"pipe", "pipe", "pipe">, autocompact?: number) {
		this.frames = new ClaudeFrames(autocompact);
		this.exited = proc.exited;
		void this.pump();
		void this.drainStderr();
	}
	get pid(): number | undefined {
		return this.proc.pid;
	}
	private push(...events: AgentEvent[]): void {
		this.queue.push(...events);
		this.wake?.();
	}
	private async pump(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of this.proc.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					let f: unknown;
					try {
						f = JSON.parse(line);
					} catch {
						continue;
					}
					if (f && typeof f === "object") this.push(...this.frames.push(f as Frame));
				}
			}
			this.push(...this.frames.end());
			const code = await this.proc.exited;
			const tail = this.stderr.trim();
			if (code !== 0 && tail) this.push({ type: "activity", row: { type: "error", text: tail.slice(-500), is_error: true } });
		} finally {
			this.done = true;
			this.wake?.();
		}
	}
	// An undrained stderr pipe would stall the CLI once its buffer fills.
	private async drainStderr(): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of this.proc.stderr) this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-4000);
		} catch {
			// the pipe closed with the process
		}
	}
	private async *read(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
			if (this.done) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			this.wake = resolve;
			await promise;
			this.wake = undefined;
		}
	}
	private write(frame: Record<string, unknown>): void {
		try {
			this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
			this.proc.stdin.flush();
		} catch {
			// the process is gone; `exited` tells the hub
		}
	}
	private control(subtype: string, kind: "usage" | "interrupt"): void {
		const id = `${kind}${++this.seq}`;
		this.frames.requests.set(id, kind);
		this.write({ type: "control_request", request_id: id, request: { subtype } });
	}
	// A message that arrives mid-turn is injected at the next tool boundary (steer); followUp waits behind the turn.
	send(text: string, mode: SendMode): void {
		this.write({ type: "user", message: { role: "user", content: text }, ...(mode === "followUp" ? { priority: "later" } : {}) });
	}
	abort(): void {
		if (this.frames.busy) this.frames.aborting = true;
		this.control("interrupt", "interrupt");
	}
	compact(): void {
		this.frames.compacting = true;
		this.write({ type: "user", message: { role: "user", content: "/compact" } });
	}
	refreshUsage(): void {
		this.control("get_context_usage", "usage");
	}
	// The session id is only known after the first turn started; init frames announce it by themselves.
	refreshSession(): void {
		if (this.frames.session) this.push({ type: "session", ref: this.frames.session });
	}
	// Task workers are always reported (task_* frames).
	watchSubagents(): void {}
	kill(force?: boolean): void {
		if (force) this.proc.kill(9);
		else this.proc.kill();
	}
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Per-run settings for --settings (merged over the user's own, which stay untouched): a PreToolUse hook on Bash (and file edits) that
// applies the dotz/RULES.md deny lines and the install's code lock, and `disableAllHooks: false` so a project's .claude/settings cannot switch that
// hook off. Written at every spawn so the hook path and data dir follow the run.
function writeSettings(dir: string, name: string, dataDir: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	// Any exit other than 0 (allow) becomes 2 (block): a hook that crashes or fails to load must not let the command through.
	const command = `DOTZ_DIR=${shq(dataDir)} ${shq(process.execPath)} ${shq(DENY_HOOK)} || exit 2`;
	writeFileSync(file, `${JSON.stringify({ disableAllHooks: false, hooks: { PreToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command, timeout: 10 }] }] } }, null, 2)}\n`);
	return file;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

// Claude Code keeps a session at <config>/projects/<cwd with / and . as ->/<session id>.jsonl; the id is searched in every
// project directory so the lookup does not depend on the cwd the session ran in.
function sessionFile(ref: string): string | undefined {
	if (ref.endsWith(".jsonl")) return existsSync(ref) ? ref : undefined;
	if (!SESSION_ID.test(ref)) return undefined;
	const root = projectsDir();
	for (const dir of readdirSync(root)) {
		const file = join(root, dir, `${ref}.jsonl`);
		if (existsSync(file)) return file;
	}
	return undefined;
}

// The most recent user messages and final answers of a saved session (oldest first, ~9000 chars), the body of a handover
// into a fresh session; only `end_turn`/`max_tokens` assistant messages are answers (a tool-use step is mid-turn
// monologue). undefined when the session cannot be read.
export function recentExchanges(ref: string): string | undefined {
	const turns: string[] = [];
	try {
		const file = sessionFile(ref);
		if (!file) return undefined;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
			const entry: Frame = JSON.parse(line);
			const m = entry.message;
			if (!m || entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
			if (m.role === "assistant" && m.stop_reason !== "end_turn" && m.stop_reason !== "max_tokens") continue;
			const t = textOfBlocks(m.content).trim();
			if (!t || INTERNAL_USER.test(t) || t.startsWith("This session is being continued") || t.startsWith("[keepalive]") || t === "ok" || isNote(t, "youAre") || t.includes("\n[dotz lane ")) continue;
			turns.push(`${m.role === "user" ? "IN" : "YOU"}: ${t.length > 700 ? `${t.slice(0, 700)}...` : t}`);
		}
	} catch {
		return undefined;
	}
	const tail: string[] = [];
	for (let i = turns.length - 1, size = 0; i >= 0 && size + turns[i].length < 9000; size += turns[i].length, i--) tail.unshift(turns[i]);
	return tail.join("\n\n");
}

function args(o: SpawnOpts, settings: string, autocompact: number | undefined): string[] {
	const { thinking } = parseSelector(o.model);
	const effort = EFFORT[thinking];
	const fallback = (o.fallback ?? []).flatMap(selector => {
		try {
			return [claudeModel(selector)];
		} catch (e) {
			log(`claude: fallback ${selector} skipped: ${(e as Error).message}`);
			return [];
		}
	});
	return [
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--replay-user-messages",
		"--permission-mode", "bypassPermissions",
		"--settings", settings,
		"--model", claudeModel(o.model),
		...(effort ? ["--effort", effort] : []),
		...(fallback.length ? ["--fallback-model", fallback.join(",")] : []),
		...(autocompact ? ["--autocompact", String(autocompact)] : []),
		// Only a Claude session id resumes; a reference from another runtime (an omp session file) starts fresh.
		...(o.resume && SESSION_ID.test(o.resume) ? ["--resume", o.resume] : []),
	];
}

const base: RuntimeAdapter = {
	id: "claude",
	caps: { steer: "native", subagents: "live", contextNumbers: "exact", compact: "slash", sessionTranscript: true, promptCacheKeepalive: true },
	start(o) {
		if (o.role === "lane" && !o.lane) throw new Error("a lane needs its lane options");
		const dataDir = o.env.DOTZ_DIR ?? DATA_DIR;
		const settings = o.lane ? writeSettings(o.lane.dir, "claude-settings.json", dataDir) : writeSettings(join(dataDir, "runtime"), "claude-orchestrator-settings.json", dataDir);
		// lane.workerModel has no counterpart: the model itself picks the model of each Agent-tool call (an env override and
		// a --agents definition were both ignored by claude 2.1.296), so workers are not pinned to the lane's worker model.
		// The CLI compacts itself at a token count (100k..1M); keepRecent has no counterpart.
		const autocompact = o.lane ? Math.min(1_000_000, Math.max(100_000, o.lane.compactAt)) : undefined;
		const proc = Bun.spawn([CLAUDE, ...args(o, settings, autocompact)], {
			cwd: o.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...o.env },
		});
		return new ClaudeProcess(proc, autocompact);
	},
	classifyError: classifyProviderError,
	recentExchanges,
	detect: () => detectBinary(CLAUDE),
};

export const claude: RuntimeAdapter & { probes: Probes } = Object.assign(base, { probes: makeProbes(base) });
export const probes = claude.probes;
