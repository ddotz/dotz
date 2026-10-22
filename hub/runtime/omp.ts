// The omp adapter: runs `omp --mode rpc` and turns its JSONL frames into AgentEvents. Everything that knows an omp frame,
// an omp command, an omp CLI argument or the omp session-file layout lives here. Frames carry complete blocks only
// (message end, tool end), never token deltas, so the terminal view shows finished steps.
import type { Subprocess } from "bun";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Block, blocks, failedCall, joined, summary } from "../activity.ts";
import { DATA_DIR, OMP, parseSelector, splitThinking } from "../config.ts";
import { isNote } from "../i18n.ts";
import { keyedWorker } from "../fallback.ts";
import { classifyProviderError } from "../providers.ts";
import { detectBinary } from "./detect.ts";
import type { ActivityRow, AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts, SubagentUpdate } from "./types.ts";

// The slice of an omp RPC frame this adapter reads (OmO speaks the same pi RPC protocol; omo.ts reuses this reader).
export type Frame = {
	type?: string;
	command?: string;
	success?: boolean;
	message?: { role?: string; content?: Block[] | string; stopReason?: string; errorMessage?: string; usage?: Usage };
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	intent?: string;
	result?: unknown;
	isError?: boolean;
	errorMessage?: string;
	attempt?: number;
	maxAttempts?: number;
	error?: string;
	// retry_fallback_applied
	from?: string;
	to?: string;
	role?: string;
	reason?: string;
	payload?: Record<string, any>;
	data?: { sessionFile?: string; contextUsage?: { tokens?: number; contextWindow?: number }; model?: { contextWindow?: number }; tokensBefore?: number };
	aborted?: boolean;
	skipped?: boolean;
};
type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; cost?: { total?: number } };

export const EXTENSION = join(import.meta.dir, "..", "..", "extension", "index.ts");

function activityFromFrame(f: Frame): ActivityRow[] {
	switch (f.type) {
		case "agent_start":
			return [{ type: "turn_start", text: "turn started" }];
		case "agent_end":
			return [{ type: "turn_end", text: "turn finished" }];
		case "message_end": {
			const m = f.message;
			if (m?.role === "user") {
				const text = joined(m.content);
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
			return [{ type: "tool_call", tool: f.toolName, call_id: f.toolCallId, intent: label, text: label ? `${f.toolName}: ${label}` : String(f.toolName ?? ""), args: typeof f.args === "string" ? f.args : JSON.stringify(f.args ?? {}, null, 2) }];
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
	const status = /fail|error/.test(raw) ? "failed" : /abort|cancel/.test(raw) ? "aborted" : /done|complete|finish|success|end/.test(raw) ? "done" : "running";
	const description = progress.description ?? p.description;
	return {
		id,
		agent: p.agent,
		description: description ? String(description) : undefined,
		status,
		tool: progress.currentTool,
		intent: progress.lastIntent ? String(progress.lastIntent) : undefined,
		transcript: typeof p.sessionFile === "string" ? p.sessionFile : undefined,
	};
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
		case "agent_start":
			out.push({ type: "turn_start" });
			break;
		case "agent_end":
			out.push({ type: "turn_end" });
			break;
		case "message_end": {
			const m = f.message;
			if (m?.role === "user") out.push({ type: "user", text: textOf(m) || (typeof m.content === "string" ? m.content.trim() : "") });
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

export class OmpProcess implements AgentProcess {
	private seq = 0;
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
					f = JSON.parse(line);
				} catch {
					continue;
				}
				if (f && typeof f === "object") yield* eventsFromFrame(this.translate(f as Frame), this.workerModels);
			}
		}
	}
	protected write(frame: Record<string, unknown>): void {
		this.proc.stdin.write(`${JSON.stringify({ id: `${this.idPrefix}${++this.seq}`, ...frame })}\n`);
		this.proc.stdin.flush();
	}
	send(text: string, mode: SendMode): void {
		if (mode === "steer") this.write({ type: "steer", message: text });
		else this.write({ type: "prompt", message: text, ...(mode === "followUp" ? { streamingBehavior: "followUp" } : {}) });
	}
	abort(): void {
		this.write({ type: "abort" });
	}
	// omp aborts a running turn to compact, so the hub only calls this when idle.
	compact(): void {
		this.write({ type: "compact" });
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
		if (force) this.proc.kill(9);
		else this.proc.kill();
	}
}

// `retry.fallbackChains` for a per-run overlay: omp walks the chain of the exact `provider/id` that failed (an exact key
// beats a role), and a task worker's chain by role `task` (the overlay points that role at the worker model). Empty
// chains write nothing, so a process without fallbacks sees the same settings as before.
function retryYaml(chains: Array<[key: string, models: string[] | undefined]>): string {
	const used = chains.filter((c): c is [string, string[]] => c[1] !== undefined && (c[1].length > 0 || c[0] !== "task"));
	if (!used.length) return "";
	return `retry:\n  modelFallback: true\n  fallbackChains:\n${used.map(([key, models]) => (models.length ? `    ${JSON.stringify(key)}:\n${models.map(m => `      - ${JSON.stringify(m)}\n`).join("")}` : `    ${JSON.stringify(key)}: []\n`)).join("")}`;
}

// The chain omp walks for the process's own model: the given bare models, or an explicit empty chain when the hub does the
// switching itself (so no chain of the owner's own omp settings moves it behind the hub's back); undefined = leave omp's settings alone.
const nativeChain = (o: Pick<SpawnOpts, "fallback" | "hubSwitches">): string[] | undefined => (o.fallback?.length ? o.fallback : o.hubSwitches ? [] : undefined);

// Per-run omp config overlay of the orchestrator (--config): its model's fallback chain, written at every start so a
// changed chain applies the next time the process starts. No chain, no overlay: the orchestrator then starts with the
// arguments it always had.
function orchestratorOverlay(o: SpawnOpts): string[] {
	// On a keyed entry that lets its workers use the key, the task role points at the key provider's copy of the worker model.
	const onKey = keyedWorker(o.env);
	const yaml = `${onKey ? `modelRoles:\n  task: ${JSON.stringify(onKey)}\n` : ""}${retryYaml([[parseSelector(o.model).model, nativeChain(o)]])}`;
	if (!yaml) return [];
	const file = join(DATA_DIR, "omp-orchestrator-overlay.yml");
	writeFileSync(file, `# Written by the dotz gateway each time the orchestrator starts; passed to omp as --config.\n${yaml}`);
	return [`--config=${file}`];
}

// Per-run omp config overlay (--config): points the `task` role at the lane's worker model, so the lane plans and
// reviews on its own model while task workers (implementation, tests, renders, grind) run on the cheaper one, and
// sets omp's auto-compaction for both models to `compactAt` tokens (keeping the last `keepRecent`); the fallback
// chains of the lane's model and of its workers go in too. Written at every spawn so changed lanes.* settings apply
// the next time the lane starts or resumes.
function writeOverlay(o: SpawnOpts, lane: NonNullable<SpawnOpts["lane"]>): string {
	const model = o.model;
	const file = join(lane.dir, "omp-overlay.yml");
	mkdirSync(lane.dir, { recursive: true });
	const thresholds = [...new Set([parseSelector(model).model, parseSelector(lane.workerModel).model])].map(m => `    ${JSON.stringify(m)}: ${JSON.stringify(`f${lane.compactAt}`)}\n`).join("");
	writeFileSync(file, `# Written by the dotz gateway each time lane ${lane.name} starts; passed to omp as --config.\nmodelRoles:\n  task: ${JSON.stringify(lane.workerModel)}\ntask:\n  agentModelOverrides:\n    task: "@task"\n    scout: "@task"\ncompaction:\n  modelThresholds:\n${thresholds}  keepRecentTokens: ${lane.keepRecent}\n${retryYaml([[parseSelector(model).model, nativeChain(o)], ["task", lane.workerFallback]])}`);
	return file;
}

// The most recent user messages and assistant final answers of a saved omp session (oldest first, ~9000 chars), the
// body of a handover into a fresh session. Assistant text from a tool-use step is mid-turn monologue, not an answer, so
// only `stop`/`length` assistant messages count. undefined when the session file cannot be read.
type SessionMessage = { role?: string; stopReason?: string; content?: string | Array<{ type?: string; text?: string }> };
export function recentExchanges(sessionFile: string): string | undefined {
	const turns: string[] = [];
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
			const parsed: { message?: SessionMessage } = JSON.parse(line);
			const m = parsed.message;
			if (!m) continue;
			if (m.role === "assistant" && m.stopReason !== "stop" && m.stopReason !== "length") continue;
			const t = (Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join("") : (m.content ?? "")).trim();
			if (!t || t.startsWith("[keepalive]") || t === "ok" || isNote(t, "youAre") || t.includes("\n[dotz lane ")) continue;
			turns.push(`${m.role === "user" ? "IN" : "YOU"}: ${t.length > 700 ? `${t.slice(0, 700)}...` : t}`);
		}
	} catch {
		return undefined;
	}
	const tail: string[] = [];
	for (let i = turns.length - 1, size = 0; i >= 0 && size + turns[i].length < 9000; size += turns[i].length, i--) tail.unshift(turns[i]);
	return tail.join("\n\n");
}

export const omp: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "live", contextNumbers: "exact", compact: "rpc", sessionTranscript: true, promptCacheKeepalive: true },
	start(o) {
		if (o.role === "lane" && !o.lane) throw new Error("a lane needs its lane options");
		const mode = o.role === "orchestrator" ? ["--extension", EXTENSION, ...orchestratorOverlay(o)] : [`--config=${writeOverlay(o, o.lane!)}`];
		// An API-key entry's provider only exists once the dotz extension has registered it (hub/fallback.ts keyEnv): the process
		// starts on the entry's own model and is switched to the key provider's copy before the first prompt (RPC commands run in order).
		const key = o.env.DOTZ_KEY_PROVIDER && o.env.DOTZ_KEY_VALUE ? (JSON.parse(o.env.DOTZ_KEY_PROVIDER) as { id: string; baseModel: string; models: Array<{ id: string }> }) : undefined;
		const startModel = key ? `${key.baseModel}:${parseSelector(o.model).thinking}` : o.model;
		const proc = Bun.spawn([OMP, "--mode", "rpc", "--model", startModel, ...mode, ...(o.resume ? ["--resume", o.resume] : [])], {
			cwd: o.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...o.env },
		});
		const agent = new OmpProcess(proc, o.role === "orchestrator" ? "o" : "h");
		if (key) agent.setModel(`${key.id}/${key.models[0].id}`);
		return agent;
	},
	classifyError: classifyProviderError,
	recentExchanges,
	detect: () => detectBinary(OMP),
};
