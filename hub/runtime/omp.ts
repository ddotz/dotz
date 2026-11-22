// The omp adapter: runs `omp --mode rpc` and turns its JSONL frames into AgentEvents. Everything that knows an omp frame,
// an omp command, an omp CLI argument or the omp session-file layout lives here. Frames carry complete blocks only
// (message end, tool end), never token deltas, so the terminal view shows finished steps.
import type { Subprocess } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Block, blocks, failedCall, joined, ownIntent, summary } from "../activity.ts";
import { withoutApiKeys } from "../apikey-policy.ts";
import { OMP, splitThinking } from "../config.ts";
import { codingHarnessEnv, codingHarnessFiles, withoutPayloadEnv } from "../done-gate.ts";
import { ownerView } from "../gateway-added.ts";
import { isNote } from "../i18n.ts";
import { classifyProviderError } from "../providers.ts";
import { stripSteerMark } from "../steer-mark.ts";
import { killAgent, spawnAgent, writeQuietly } from "./agent-proc.ts";
import { detectBinary } from "./detect.ts";
import { touchedPath, withTouchedFiles } from "./handover-files.ts";
import { lastCompactionSummary, summaryStale } from "./omo-summary.ts";
import { keyProviderOf, startModelOf, writeOverlay } from "./omp-overlay.ts";
import { RunKeys } from "./omp-runs.ts";
import { RetryGate } from "./omp-retry.ts";
import { realTurn, type SessionMessage } from "./real-turn.ts";
import type { ActivityRow, AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts, SubagentUpdate } from "./types.ts";

// The slice of an omp RPC frame this adapter reads (OmO speaks the same pi RPC protocol; omo.ts reuses this reader).
export type Frame = {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	message?: { role?: string; customType?: string; content?: Block[] | string; details?: { jobs?: AsyncJob[] }; stopReason?: string; errorMessage?: string; usage?: Usage };
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	intent?: string;
	result?: unknown;
	isError?: boolean;
	errorMessage?: string;
	attempt?: number;
	maxAttempts?: number;
	error?: string | { message?: string; code?: string };
	status?: string;
	// retry_fallback_applied
	from?: string;
	to?: string;
	role?: string;
	reason?: string;
	payload?: Record<string, any>;
	data?: { sessionFile?: string; contextUsage?: { tokens?: number; contextWindow?: number }; model?: { contextWindow?: number }; tokensBefore?: number; hasPendingAsyncWork?: boolean; cancelled?: boolean };
	aborted?: boolean;
	skipped?: boolean;
	isTerminal?: boolean;
	awaitingAsyncWork?: boolean;
	yielded?: boolean;
};
type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; cost?: { total?: number } };
type AsyncJob = { jobId?: string; type?: string; status?: string; agentId?: string };

export const EXTENSION = join(import.meta.dir, "..", "..", "extension", "index.ts");

function activityFromFrame(f: Frame): ActivityRow[] {
	switch (f.type) {
		case "agent_start":
			return [{ type: "turn_start", text: "turn started" }];
		case "agent_end":
			return yielded(f) ? [{ type: "turn_end", text: "turn finished" }] : [];
		case "message_end": {
			const m = f.message;
			if (m?.role === "user") {
				const text = ownerView(joined(m.content));
				return text && !isNote(text, "youAre") ? [{ type: "status", text: `> ${text.slice(0, 400)}` }] : [];
			}
			if (m?.role !== "assistant") return [];
			const out: ActivityRow[] = [];
			for (const b of blocks(m.content)) {
				if (b.type === "thinking" && b.thinking?.trim()) out.push({ type: "thinking", text: b.thinking.trim() });
				else if (b.type === "text" && b.text?.trim()) out.push({ type: "text", text: b.text.trim() });
			}
			if (m.stopReason === "error") out.push({ type: "error", text: m.errorMessage || "model request failed", is_error: true });
			else if (m.stopReason === "aborted") out.push({ type: "status", text: "aborted" });
			return out;
		}
		case "tool_execution_start": {
			const label = summary(f.args, f.intent);
			return [{ type: "tool_call", tool: f.toolName, call_id: f.toolCallId, intent: label, ...(ownIntent(f.args, f.intent) ? { said: true } : {}), text: label ? `${f.toolName}: ${label}` : String(f.toolName ?? ""), args: typeof f.args === "string" ? f.args : JSON.stringify(f.args ?? {}, null, 2) }];
		}
		case "tool_execution_end": {
			const r = f.result as { content?: Block[] | string } | string | undefined;
			const text = typeof r === "string" ? r : joined(r?.content);
			return [{ type: "tool_result", tool: f.toolName, call_id: f.toolCallId, text, is_error: failedCall(f.toolName, text, f.isError) }];
		}
		case "auto_retry_start":
			return [{ type: "status", text: `retrying${f.attempt ? ` (attempt ${f.attempt}${f.maxAttempts ? `/${f.maxAttempts}` : ""})` : ""}${f.errorMessage ? `: ${f.errorMessage}` : ""}` }];
		case "auto_compaction_start":
			return [{ type: "status", text: "compacting context" }];
		case "auto_compaction_end":
			return [{ type: "status", text: "context compacted" }];
		case "retry_fallback_applied":
			return f.from && f.to ? [{ type: "status", text: `model fallback: ${f.from} → ${f.to}${f.reason ? ` (${f.reason.replace(/\s+/g, " ").slice(0, 160)})` : ""}` }] : [];
		case "extension_error":
			return [{ type: "error", text: String(f.error ?? "extension error"), is_error: true }];
		default:
			return [];
	}
}

const textOf = (m: Frame["message"]): string =>
	(Array.isArray(m?.content) ? m.content : [])
		.filter(b => b?.type === "text")
		.map(b => b.text)
		.join("")
		.trim();

// A task worker's frame (`subagent_lifecycle` / `subagent_progress`, sent after `set_subagent_subscription` at level
// "progress"); both shapes carry the fields either at the top of the payload or under `progress`.
function subagentUpdate(p: Record<string, any>): SubagentUpdate | undefined {
	const progress = p.progress ?? {};
	const id = String(progress.id ?? p.id ?? "");
	if (!id) return undefined;
	const raw = String(progress.status ?? p.status ?? "").toLowerCase();
	const status = /fail|error/.test(raw) ? "failed" : /abort|cancel/.test(raw) ? "aborted" : /\b(?:done|completed?|finished?|success(?:ful)?|ended?)\b/.test(raw) ? "done" : "running";
	const description = progress.description ?? p.description;
	return {
		id,
		agent: p.agent,
		description: description ? String(description) : undefined,
		status,
		tool: progress.currentTool,
		intent: progress.lastIntent ? String(progress.lastIntent) : undefined,
		transcript: typeof p.sessionFile === "string" ? p.sessionFile : undefined,
		model: typeof progress.resolvedModel === "string" ? progress.resolvedModel : undefined,
		thinking: typeof progress.resolvedThinkingLevel === "string" ? progress.resolvedThinkingLevel : undefined,
	};
}

// why(protocol): omp's background task result is "Spawned agent `<id>` (job `<jobId>`)." and, for a batch, one "- `<id>` (job `<jobId>`)" line per agent (omp@18.22.0 docs/tools/task.md "Background response")
const OMP_SPAWNED = [/Spawned agent `([^`]+)`/g, /^\s*- `([^`]+)` \(job `[^`]+`\)/gm];
const ompWorkers = (text: string) => [...new Set(OMP_SPAWNED.flatMap(re => [...text.matchAll(re)].map(m => m[1]!)))].map(id => ({ id }));
const TASK_ID = /\bst_[0-9a-z]{6,}\b/g;
// OmO's task result: "Started task <description> (st_x, running)...", or for a batch numbered lines naming each id.
function spawnedWorkers(text: string): { id: string; description?: string }[] {
	const single = /^Started task (.+) \((st_[0-9a-z]+),/.exec(text);
	if (single) return [{ id: single[2]!, description: single[1]! }];
	const omo = [...new Set(text.match(TASK_ID) ?? [])].map(id => ({ id }));
	return omo.length ? omo : ompWorkers(text);
}
// OmO's wake after a worker ended: one "task completion name:<n> id:st_x ..." per worker (a wake can carry several).
const finishedWorkers = (text: string) => [...text.matchAll(/task completion name:\S+ id:(st_[0-9a-z]+)/g)].map(m => m[1]!);

// why(protocol): omp wakes a session with a custom `async-result` message whose details.jobs lists every delivered job (omp@18.22.0, observed in hub/runtime/fixtures/omp-rpc.jsonl)
function doneWorkers(jobs: AsyncJob[] | undefined): AgentEvent[] {
	const ids = new Set<string>();
	for (const job of Array.isArray(jobs) ? jobs : []) {
		const id = job?.agentId ?? job?.jobId;
		if (typeof id === "string" && id) ids.add(id);
	}
	return ids.size ? [{ type: "workers_done", ids: [...ids] }] : [];
}

type ToolDetails = { async?: { state?: string; jobId?: string; type?: string }; message?: { op?: string; receipts?: { to?: string; outcome?: string }[] } };

// why(protocol): omp's tool results carry details.async = {state:"running", jobId, type} for a call it ran as a background job, and `write agent://<name>` details.message = {op:"send", receipts:[{to, outcome}]} with outcome "injected" (a running worker took the message) or "woken" (an ended worker started a new run) (omp@18.22.0, hub/runtime/fixtures/omp-rpc.jsonl and omp-sessions/revived)
function jobEvents(result: unknown): AgentEvent[] {
	const details: ToolDetails | undefined = result && typeof result === "object" && "details" in result ? (result.details as ToolDetails | undefined) : undefined;
	const job = details?.async;
	if (job?.state === "running" && job.type !== "task" && typeof job.jobId === "string" && job.jobId) return [{ type: "workers_spawned", workers: [{ id: job.jobId }] }];
	if (details?.message?.op !== "send") return [];
	const named = (outcome: string) => (details.message?.receipts ?? []).flatMap(r => (r?.outcome === outcome && typeof r.to === "string" && r.to ? [r.to] : []));
	const events: AgentEvent[] = [];
	const woken = named("woken");
	if (woken.length) events.push({ type: "workers_spawned", workers: woken.map(id => ({ id })) });
	const injected = named("injected");
	if (injected.length) events.push({ type: "workers_steered", ids: injected });
	return events;
}

// Everything one omp frame means to the hub, in the order the hub must apply it. A task worker that moved to a fallback
// model has no frame of its own: its progress reports the model it resolved to (`resolvedModel`, flagged
// `resolvedModelIsFallback`), so a change of that field is the worker's fallback. `workers` remembers it per worker id.
export function eventsFromFrame(f: Frame, workers: Map<string, string>): AgentEvent[] {
	const out: AgentEvent[] = [{ type: "alive" }];
	if (f.type === "subagent_lifecycle" || f.type === "subagent_progress") {
		const update = subagentUpdate(f.payload ?? {});
		if (update) out.push({ type: "subagent", update });
		const progress = f.payload?.progress ?? {};
		const resolved = typeof progress.resolvedModel === "string" ? progress.resolvedModel : undefined;
		if (update && resolved) {
			const before = workers.get(update.id);
			workers.set(update.id, resolved);
			if (before && before !== resolved && progress.resolvedModelIsFallback === true) out.push({ type: "fallback", from: before, to: resolved, worker: true });
		}
		return out;
	}
	for (const row of activityFromFrame(f)) out.push({ type: "activity", row });
	switch (f.type) {
		case "tool_execution_end": {
			if (f.isError) break;
			if (f.toolName !== "task" && f.toolName !== "task_send") {
				out.push(...jobEvents(f.result));
				break;
			}
			const r = f.result as { content?: Block[] | string } | string | undefined;
			const said = typeof r === "string" ? r : joined(r?.content);
			if (f.toolName === "task_send") {
				// OmO's result names the worker by id even when the call named it by task name: "Delivered to st_x as steer.", "Revived st_x ...".
				const ids = said.match(TASK_ID);
				if (ids) out.push({ type: "workers_steered", ids: [...new Set(ids)] });
				break;
			}
			const workers = spawnedWorkers(said);
			if (workers.length) out.push({ type: "workers_spawned", workers });
			break;
		}
		case "agent_start":
			out.push({ type: "turn_start" });
			break;
		case "agent_end":
			if (yielded(f)) out.push({ type: "turn_end" });
			break;
		case "message_end": {
			const m = f.message;
			if (m?.role === "user") out.push({ type: "user", text: textOf(m) || (typeof m.content === "string" ? m.content.trim() : "") });
			else if (m?.role === "custom") {
				const said = textOf(m) || (typeof m.content === "string" ? m.content : "");
				if (m.customType === "omo-senpi:wake") {
					const ids = finishedWorkers(said);
					if (ids.length) out.push({ type: "workers_done", ids });
				} else if (m.customType === "async-result") out.push(...doneWorkers(m.details?.jobs));
			}
			else if (m?.role === "assistant") {
				const u = m.usage;
				if (u) {
					const tokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
					out.push({ type: "usage", tokens });
					// What this request cost (omp prices it from the model catalog; 0 = unpriced), for the hub's per-entry spend caps.
					out.push({ type: "spend", tokens, ...(u.cost?.total ? { usd: u.cost.total } : {}) });
				}
				const text = textOf(m);
				const err = String(m.errorMessage ?? "");
				if (m.stopReason === "error") {
					const compaction = /compaction/i.test(err);
					out.push({ type: "assistant", text, stop: "error", error: { text: err, kind: classifyProviderError(err), compaction } });
					if (compaction) out.push({ type: "compaction", state: "error", error: err.slice(0, 300), requested: false });
				} else out.push({ type: "assistant", text, stop: m.stopReason === "stop" || m.stopReason === "length" || m.stopReason === "aborted" ? m.stopReason : "other" });
			}
			break;
		}
		case "auto_compaction_end":
			if (f.errorMessage) out.push({ type: "compaction", state: "error", error: String(f.errorMessage).slice(0, 300), requested: false });
			// omp's own threshold compaction: the retain nudge (lanes.ts, orchestrator.ts) must follow it like a requested one.
			else if (!f.aborted && !f.skipped) out.push({ type: "compaction", state: "done" });
			break;
		case "retry_fallback_applied":
			if (f.from && f.to) out.push({ type: "fallback", from: f.from, to: f.to, ...(f.reason ? { reason: f.reason } : {}), ...(f.role === "task" ? { worker: true } : {}) });
			break;
		case "response":
			// get_state / get_session_stats: contextUsage {tokens, contextWindow, percent}, and the model window.
			if (f.success && (f.command === "get_state" || f.command === "get_session_stats")) {
				const usage = f.data?.contextUsage;
				const window = usage?.contextWindow ?? f.data?.model?.contextWindow;
				const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
				const sized = typeof window === "number" && window > 0 ? window : undefined;
				if (tokens !== undefined || sized !== undefined) out.push({ type: "usage", tokens, window: sized });
			}
			if (f.command === "compact") {
				if (f.success) out.push({ type: "compaction", state: "done", tokensBefore: typeof f.data?.tokensBefore === "number" ? f.data.tokensBefore : undefined });
				else out.push({ type: "compaction", state: "error", error: String(f.error ?? "compaction failed").slice(0, 300), requested: true });
			}
			if (f.command === "get_state" && f.data?.sessionFile) out.push({ type: "session", ref: f.data.sessionFile });
			break;
	}
	return out;
}

export { writeQuietly };

const yielded = (f: Frame): boolean => f.yielded ?? f.isTerminal !== false;

export class OmpProcess implements AgentProcess {
	private seq = 0;
	private restoreId?: string;
	private readonly gate = new RetryGate();
	private readonly workerModels = new Map<string, string>();
	readonly events: AsyncIterable<AgentEvent> = this.read();
	readonly exited: Promise<number>;
	constructor(
		private readonly proc: Subprocess<"pipe", "pipe", "pipe">,
		// Request ids only tell the hub's two kinds of process apart in a wire log: `o` orchestrator, `h` lane.
		private readonly idPrefix: string,
		// Rewrites a frame of another pi-family runtime into the omp shape before it is read (omo.ts).
		private readonly translate: (f: Frame) => Frame = f => f,
	) {
		this.exited = proc.exited;
	}
	get pid(): number | undefined {
		return this.proc.pid;
	}
	private async *read(): AsyncGenerator<AgentEvent> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.proc.stdout) {
			buffer += decoder.decode(chunk);
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				let f: unknown;
				try {
					f = JSON.parse(stripSteerMark(line));
				} catch {
					continue;
				}
				if (!f || typeof f !== "object") continue;
				const frame = this.translate(f as Frame);
				if (this.restoreId !== undefined && frame.type === "response" && frame.id === this.restoreId && frame.success === false) this.write({ type: "abort" });
				this.observe(frame);
				yield* this.rekey(this.gate.pass(frame, eventsFromFrame(frame, this.workerModels)));
			}
		}
		yield* this.rekey(this.gate.release());
	}
	protected write(frame: Record<string, unknown>): string {
		const id = `${this.idPrefix}${++this.seq}`;
		writeQuietly(this.proc.stdin, `${JSON.stringify({ id, ...frame })}\n`);
		return id;
	}
	protected observe(_frame: Frame): void {}
	protected rekey(events: AgentEvent[]): AgentEvent[] {
		return events;
	}
	send(text: string, mode: SendMode): void {
		if (mode === "steer") this.write({ type: "steer", message: text });
		else this.write({ type: "prompt", message: text, ...(mode === "followUp" ? { streamingBehavior: "followUp" } : {}) });
	}
	abort(clearQueue?: boolean): void {
		if (clearQueue) this.restoreId = this.write({ type: "abort_and_restore_queue" });
		else this.write({ type: "abort" });
	}
	// omp aborts a running turn to compact, so the hub only calls this when idle.
	compact(instructions?: string): void {
		this.write({ type: "compact", ...(instructions ? { customInstructions: instructions } : {}) });
	}
	refreshUsage(): void {
		this.write({ type: "get_session_stats" });
	}
	refreshSession(): void {
		this.write({ type: "get_state" });
	}
	// The model is chosen after the process is up (a provider the dotz extension registers is unknown to `--model`), and is
	// switched back through the same frame after a fallback. A thinking suffix also sets the level (a fallback walk may have moved it).
	setModel(selector: string): void {
		const { model: id, thinking } = splitThinking(selector);
		const slash = id.indexOf("/");
		this.write({ type: "set_model", provider: id.slice(0, slash), modelId: id.slice(slash + 1) });
		if (thinking) this.write({ type: "set_thinking_level", level: thinking });
	}
	watchSubagents(): void {
		this.write({ type: "set_subagent_subscription", level: "progress" });
	}
	kill(force?: boolean): void {
		killAgent(this.proc, force);
	}
}

const CANCEL_WAIT_MS = 10_000;

// why(protocol): omp says whether outside work can still wake a session: a non-terminal `agent_end` with awaitingAsyncWork, `get_state` hasPendingAsyncWork, and `session_settled` once nothing can; `cancel_subagent` answers `{ cancelled }` (omp@18.22.0 docs/rpc.md "Yield vs settled", "Cancelling subagents"). OmO speaks the same pi RPC without them, so it stays on OmpProcess.
class OmpRuntimeProcess extends OmpProcess {
	private pending = false;
	private readonly runs = new RunKeys();
	private ended = false;
	private readonly cancels = new Map<string, (cancelled: boolean) => void>();
	constructor(proc: Subprocess<"pipe", "pipe", "pipe">, idPrefix: string) {
		super(proc, idPrefix);
		const gone = () => {
			this.ended = true;
			for (const answer of [...this.cancels.values()]) answer(false);
		};
		void this.exited.then(gone, gone);
	}
	awaitingAsync(): boolean {
		return this.pending && !this.ended;
	}
	cancelWorker(id: string): Promise<{ cancelled: boolean }> {
		if (this.ended) return Promise.resolve({ cancelled: false });
		const { promise, resolve } = Promise.withResolvers<{ cancelled: boolean }>();
		const request = this.write({ type: "cancel_subagent", subagentId: this.runs.nameOf(id) });
		const answer = (cancelled: boolean) => {
			clearTimeout(timer);
			this.cancels.delete(request);
			resolve({ cancelled });
		};
		const timer = setTimeout(() => answer(false), CANCEL_WAIT_MS);
		this.cancels.set(request, answer);
		return promise;
	}
	protected rekey(events: AgentEvent[]): AgentEvent[] {
		return this.runs.rekey(events);
	}
	protected observe(f: Frame): void {
		if (f.type === "agent_end") {
			if (f.awaitingAsyncWork === true) this.pending = true;
			else if (f.isTerminal !== false) this.pending = false;
		} else if (f.type === "session_settled") this.pending = false;
		else if (f.type === "response") {
			if (f.command === "get_state" && f.success && typeof f.data?.hasPendingAsyncWork === "boolean") this.pending = f.data.hasPendingAsyncWork;
			if (f.id) this.cancels.get(f.id)?.(f.success === true && f.data?.cancelled === true);
		}
	}
}

// The most recent user messages and assistant final answers of a saved omp session (oldest first, ~9000 chars), the
// body of a handover into a fresh session, then the paths its edit and write calls touched. Assistant text from a
// tool-use step is mid-turn monologue, not an answer, so only `stop`/`length` assistant messages count. undefined when
// the session file cannot be read.
export function recentExchanges(sessionFile: string): string | undefined {
	const turns: string[] = [];
	const files: string[] = [];
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
			const parsed: { message?: SessionMessage } = JSON.parse(line);
			const m = parsed.message;
			if (!m) continue;
			if (m.role === "assistant" && Array.isArray(m.content))
				for (const b of m.content) {
					const p = b?.type === "toolCall" && (b.name === "edit" || b.name === "write") ? touchedPath(b.arguments?.path) : undefined;
					if (p) files.push(p);
				}
			const t = realTurn(m);
			if (t === undefined) continue;
			turns.push(`${m.role === "user" ? "IN" : "YOU"}: ${t.length > 700 ? `${t.slice(0, 700)}...` : t}`);
		}
	} catch {
		return undefined;
	}
	const tail: string[] = [];
	for (let i = turns.length - 1, size = 0; i >= 0 && size + turns[i].length < 9000; size += turns[i].length, i--) tail.unshift(turns[i]);
	return withTouchedFiles(tail.join("\n\n"), files);
}

/**
 * The whole argv of one omp process, binary first; calling it writes the session's overlay file that `--config=` names.
 * An API-key entry's provider only exists once the dotz extension has registered it (hub/fallback.ts keyEnv): the process
 * starts on the entry's own model and is switched to the key provider's copy before the first prompt (RPC commands run in order).
 * A process that names `codingHarness` (any role) loads that payload's extension files after the dotz extension, then the payload folder itself,
 * which is what makes omp read its rules and agents (hub/done-gate.ts); a payload that is not usable throws.
 */
export function ompArgv(o: SpawnOpts): string[] {
	if (o.role === "lane" && !o.lane) throw new Error("a lane needs its lane options");
	const coding = o.codingHarness ? codingHarnessFiles(o.codingHarness) : undefined;
	if (o.codingHarness && !coding) throw new Error(`the coding harness ${o.codingHarness} is not an absolute folder holding extensions/done-gate.ts and harness/gate/bootstrap.ts`);
	const loaded = coding ? [...coding.extensions.flatMap(file => ["--extension", file]), "--extension", coding.dir] : [];
	return [OMP, "--mode", "rpc", "--model", startModelOf(o), "--no-extensions", "--extension", EXTENSION, ...loaded, `--config=${writeOverlay(o, coding)}`, ...(o.systemNote ? ["--append-system-prompt", o.systemNote] : []), ...(o.resume ? ["--resume", o.resume] : [])];
}

export const omp: RuntimeAdapter = {
	id: "omp",
	// why(protocol): omp@18.22.0 runs RPC commands on a serialized queue, so an abort sent during compact is read after the compaction ends and there is no abortCompact (docs/rpc.md "Ordinary commands run on a serialized queue"; frames: hub/runtime/fixtures/omp-compact-queue.jsonl)
	caps: { steer: "native", subagents: "live", contextNumbers: "exact", compact: "rpc", sessionTranscript: true, promptCacheKeepalive: true, contextLimit: "compact", restCompact: true, extension: true, modeInSystem: true, doneGate: true },
	start(o) {
		const key = keyProviderOf(o);
		const proc = spawnAgent(ompArgv(o), {
			cwd: o.cwd,
			env: withoutApiKeys({ PI_CACHE_RETENTION: "long", ...withoutPayloadEnv(process.env), ...o.env, ...(o.codingHarness ? codingHarnessEnv(o.codingHarness) : {}), DOTZ_RUNTIME: "omp" }),
		});
		const agent = new OmpRuntimeProcess(proc, o.role === "orchestrator" ? "o" : "h");
		if (key) agent.setModel(`${key.id}/${key.models[0].id}`);
		return agent;
	},
	classifyError: classifyProviderError,
	recentExchanges,
	lastCompactionSummary,
	summaryStale,
	detect: () => detectBinary(OMP),
};
