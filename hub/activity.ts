// Terminal-view activity: stamps and scrubs the rows a runtime adapter emits, keeps the task-worker lists, and maps saved
// omp session transcripts to the same shape.
import { broadcast, emitActivity } from "./events.ts";
import { mask, secretValues } from "./providers.ts";
import { now } from "./config.ts";
import { isNote } from "./i18n.ts";
import type { AgentEvent, SubagentUpdate } from "./runtime/types.ts";

export type Block = { type?: string; text?: string; thinking?: string };

const MAX = 4000;
// Credential-shaped tokens that could surface in tool output (the saved keys themselves are redacted exactly).
const TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g;

export function scrub(text: string): string {
	let out = text.replace(TOKEN_RE, m => mask(m));
	for (const secret of secretValues()) out = out.split(secret).join(mask(secret));
	return out.length > MAX ? `${out.slice(0, MAX)}…` : out;
}

export const blocks = (content: Block[] | string | undefined): Block[] => (Array.isArray(content) ? content : []);
export const joined = (content: Block[] | string | undefined) => (typeof content === "string" ? content : blocks(content).filter(b => b.type === "text").map(b => b.text ?? "").join("")).trim();

// A short plain label for a collapsed tool call: the model's own intent (`i`; omp moves it out of the args into the
// frame's `intent` field) when present, else the first line of the command / path / pattern, cut to one short line.
export function summary(args: unknown, intent?: string): string {
	const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const v = a.i ?? a.intent ?? intent ?? a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url;
	if (typeof v !== "string" || !v.trim()) return "";
	const line = v.trim().split("\n")[0].trim();
	return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

// Stamps a runtime's activity row with time and source, scrubs secrets from it, and feeds the terminal view; task-worker
// updates go to the subagent lists. Other events are not display material.
export function emitEventActivity(source: string, ev: AgentEvent): void {
	if (ev.type === "subagent") return trackSubagent(source, ev.update);
	if (ev.type !== "activity") return;
	const a = ev.row;
	emitActivity({ ts: now(), kind: "activity", source, ...a, text: scrub(a.text), ...(a.args !== undefined ? { args: scrub(a.args) } : {}), ...(a.intent ? { intent: scrub(a.intent) } : {}) });
}

// Subagents (task-tool workers) of each agent process, from the runtime's subagent events. Kept as one current list
// per source (finished ones for 10 min) and streamed whole on every change.
export type Subagent = { id: string; agent?: string; description?: string; status: "running" | "done" | "failed" | "aborted"; tool?: string; intent?: string; started_at: number; updated_at: number };
const subagents = new Map<string, Map<string, Subagent>>();
// Transcript file of each subagent (`<source>\n<id>` -> path); server-side only, never sent to the UI.
const transcripts = new Map<string, string>();
const FINISHED_KEEP_MS = 10 * 60_000;

function trackSubagent(source: string, u: SubagentUpdate): void {
	let list = subagents.get(source);
	if (!list) subagents.set(source, (list = new Map()));
	const prev = list.get(u.id);
	if (u.transcript) transcripts.set(`${source}\n${u.id}`, u.transcript);
	list.set(u.id, {
		id: u.id,
		agent: u.agent ?? prev?.agent,
		description: u.description ? scrub(u.description).slice(0, 120) : prev?.description,
		status: u.status,
		tool: u.tool ?? prev?.tool,
		intent: u.intent ? scrub(u.intent).slice(0, 120) : prev?.intent,
		started_at: prev?.started_at ?? Date.now(),
		updated_at: Date.now(),
	});
	for (const [key, s] of list) {
		if (s.status === "running" || Date.now() - s.updated_at <= FINISHED_KEEP_MS) continue;
		list.delete(key);
		transcripts.delete(`${source}\n${key}`);
	}
	broadcast({ kind: "subagents", source, items: [...list.values()] });
}

// Task workers still running under one omp process (a lane's turn can end while its background workers keep going).
export const runningSubagents = (source: string): number => [...(subagents.get(source)?.values() ?? [])].filter(s => s.status === "running").length;
// The process is gone, so are its workers; their entries would otherwise stay "running" forever.
export function endSubagents(source: string): void {
	const list = subagents.get(source);
	if (!list) return;
	for (const s of list.values()) if (s.status === "running") s.status = "aborted";
	broadcast({ kind: "subagents", source, items: [...list.values()] });
}

export function subagentLists(): Record<string, Subagent[]> {
	return Object.fromEntries([...subagents].map(([source, list]) => [source, [...list.values()]]));
}

export type TranscriptItem = { ts: string; type: "status" | "thinking" | "text" | "tool_call" | "tool_result"; text: string; tool?: string; intent?: string; args?: string; is_error?: boolean };
const TRANSCRIPT_MAX = 200;
// The fields read from an omp session transcript line; every field is optional and checked before use.
type TranscriptBlock = Block & { name?: string; arguments?: unknown; intent?: string };
type TranscriptEntry = { type?: string; timestamp?: string; message?: { role?: string; content?: TranscriptBlock[] | string; toolName?: string; isError?: boolean } };

// An omp session transcript (a subagent's, or a lane's after its live activity is gone) mapped to activity-shaped
// items, oldest first, the last `max` of them.
export async function transcriptItems(file: string | undefined, max = TRANSCRIPT_MAX): Promise<TranscriptItem[]> {
	const items: TranscriptItem[] = [];
	const lines = file && (await Bun.file(file).exists()) ? (await Bun.file(file).text()).split("\n") : [];
	for (const line of lines) {
		let e: TranscriptEntry;
		try {
			e = JSON.parse(line) as TranscriptEntry;
		} catch {
			continue;
		}
		const m = e?.type === "message" ? e.message : undefined;
		if (!m) continue;
		const ts = String(e.timestamp ?? "");
		if (m.role === "user") {
			const text = joined(m.content);
			if (text) items.push({ ts, type: "status", text: `> ${scrub(text).slice(0, 2000)}` });
		} else if (m.role === "assistant") {
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b.type === "thinking" && b.thinking?.trim()) items.push({ ts, type: "thinking", text: scrub(b.thinking.trim()) });
				else if (b.type === "text" && b.text?.trim()) items.push({ ts, type: "text", text: scrub(b.text.trim()) });
				else if (b.type === "toolCall") {
					const label = summary(b.arguments, b.intent);
					items.push({ ts, type: "tool_call", tool: b.name, intent: scrub(label), text: label ? `${b.name}: ${scrub(label)}` : String(b.name ?? ""), args: scrub(JSON.stringify(b.arguments ?? {}, null, 2)) });
				}
			}
		} else if (m.role === "toolResult") items.push({ ts, type: "tool_result", tool: m.toolName, text: scrub(joined(m.content)), is_error: Boolean(m.isError) });
	}
	return items.slice(-max);
}

// One subagent with its own transcript.
export async function subagentDetail(source: string, id: string): Promise<(Subagent & { items: TranscriptItem[] }) | undefined> {
	const sub = subagents.get(source)?.get(id);
	return sub && { ...sub, items: await transcriptItems(transcripts.get(`${source}\n${id}`)) };
}

export function statusActivity(source: string, text: string): void {
	emitActivity({ ts: now(), kind: "activity", source, type: "status", text });
}
