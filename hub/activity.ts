// Maps omp RPC frames to terminal-view Activity events (complete blocks only: message end, tool end; no token deltas).
import { type Activity, broadcast, emitActivity } from "./events.ts";
import { mask, secretValues } from "./providers.ts";
import { now } from "./config.ts";

type Block = { type?: string; text?: string; thinking?: string };
export type Frame = {
	type?: string;
	message?: { role?: string; content?: Block[] | string; stopReason?: string; errorMessage?: string };
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
	payload?: Record<string, any>;
};

const MAX = 4000;
// Credential-shaped tokens that could surface in tool output (the saved keys themselves are redacted exactly).
const TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g;

export function scrub(text: string): string {
	let out = text.replace(TOKEN_RE, m => mask(m));
	for (const secret of secretValues()) out = out.split(secret).join(mask(secret));
	return out.length > MAX ? `${out.slice(0, MAX)}…` : out;
}

const blocks = (content: Block[] | string | undefined): Block[] => (Array.isArray(content) ? content : []);
const joined = (content: Block[] | string | undefined) => (typeof content === "string" ? content : blocks(content).filter(b => b.type === "text").map(b => b.text ?? "").join("")).trim();

// A short plain label for a collapsed tool call: the model's own intent (`i`; omp moves it out of the args into the
// frame's `intent` field) when present, else the first line of the command / path / pattern, cut to one short line.
function summary(args: unknown, intent?: string): string {
	const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const v = a.i ?? a.intent ?? intent ?? a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url;
	if (typeof v !== "string" || !v.trim()) return "";
	const line = v.trim().split("\n")[0].trim();
	return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

export function activityFromFrame(f: Frame): Omit<Activity, "ts" | "kind" | "source">[] {
	switch (f.type) {
		case "agent_start":
			return [{ type: "turn_start", text: "turn started" }];
		case "agent_end":
			return [{ type: "turn_end", text: "turn finished" }];
		case "message_end": {
			const m = f.message;
			if (m?.role === "user") {
				const text = joined(m.content);
				return text && !text.startsWith("[dotz gateway] You are") ? [{ type: "status", text: `> ${text.slice(0, 400)}` }] : [];
			}
			if (m?.role !== "assistant") return [];
			const out: Omit<Activity, "ts" | "kind" | "source">[] = [];
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
			return [{ type: "tool_result", tool: f.toolName, call_id: f.toolCallId, text, is_error: Boolean(f.isError) }];
		}
		case "auto_retry_start":
			return [{ type: "status", text: `retrying${f.attempt ? ` (attempt ${f.attempt}${f.maxAttempts ? `/${f.maxAttempts}` : ""})` : ""}${f.errorMessage ? `: ${f.errorMessage}` : ""}` }];
		case "auto_compaction_start":
			return [{ type: "status", text: "compacting context" }];
		case "auto_compaction_end":
			return [{ type: "status", text: "context compacted" }];
		case "extension_error":
			return [{ type: "error", text: String(f.error ?? "extension error"), is_error: true }];
		default:
			return [];
	}
}

export function emitFrameActivity(source: string, f: Frame): void {
	if (f.type === "subagent_lifecycle" || f.type === "subagent_progress") return trackSubagent(source, f.payload ?? {});
	for (const a of activityFromFrame(f)) emitActivity({ ts: now(), kind: "activity", source, ...a, text: scrub(a.text), ...(a.args !== undefined ? { args: scrub(a.args) } : {}), ...(a.intent ? { intent: scrub(a.intent) } : {}) });
}

// Subagents (task-tool workers) of each omp process, from the frames sent after `set_subagent_subscription` at level
// "progress". Kept as one current list per source (finished ones for 10 min) and streamed whole on every change.
export type Subagent = { id: string; agent?: string; description?: string; status: "running" | "done" | "failed" | "aborted"; tool?: string; intent?: string; updated_at: number };
const subagents = new Map<string, Map<string, Subagent>>();
const FINISHED_KEEP_MS = 10 * 60_000;

function trackSubagent(source: string, p: Record<string, any>): void {
	const progress = p.progress ?? {};
	const id = String(progress.id ?? p.id ?? "");
	if (!id) return;
	let list = subagents.get(source);
	if (!list) subagents.set(source, (list = new Map()));
	const prev = list.get(id);
	const raw = String(progress.status ?? p.status ?? "").toLowerCase();
	const status = /fail|error/.test(raw) ? "failed" : /abort|cancel/.test(raw) ? "aborted" : /done|complete|finish|success|end/.test(raw) ? "done" : "running";
	const description = progress.description ?? p.description;
	list.set(id, {
		id,
		agent: p.agent ?? prev?.agent,
		description: description ? scrub(String(description)).slice(0, 120) : prev?.description,
		status,
		tool: progress.currentTool ?? prev?.tool,
		intent: progress.lastIntent ? scrub(String(progress.lastIntent)).slice(0, 120) : prev?.intent,
		updated_at: Date.now(),
	});
	for (const [key, s] of list) if (s.status !== "running" && Date.now() - s.updated_at > FINISHED_KEEP_MS) list.delete(key);
	broadcast({ kind: "subagents", source, items: [...list.values()] });
}

export function subagentLists(): Record<string, Subagent[]> {
	return Object.fromEntries([...subagents].map(([source, list]) => [source, [...list.values()]]));
}

export function statusActivity(source: string, text: string): void {
	emitActivity({ ts: now(), kind: "activity", source, type: "status", text });
}
