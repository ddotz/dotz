// Context-window usage and on-demand compaction of an omp RPC process, shared by the orchestrator and every lane.
// Numbers come from the assistant usage of each message_end and from omp's own accounting: the `get_state` and
// `get_session_stats` responses carry `contextUsage` {tokens, contextWindow, percent}. Compaction is the RPC
// `{type:"compact"}`; omp aborts a running turn to compact, so a busy process is queued and compacted after agent_end.
import { readFileSync } from "node:fs";
import { log, now } from "./config.ts";

export type CompactState = "queued" | "compacting" | "done" | "error";
export type Compaction = { state?: CompactState; at?: string; tokensBefore?: number; error?: string };
export type Ctx = { tokens: number; window: number; compaction: Compaction };

// The slice of an omp RPC frame this module reads.
export type Frame = {
	type?: string;
	command?: string;
	success?: boolean;
	error?: string;
	errorMessage?: string;
	message?: { role?: string; stopReason?: string; errorMessage?: string };
	data?: { contextUsage?: { tokens?: number; contextWindow?: number }; model?: { contextWindow?: number }; tokensBefore?: number };
};
type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };

export const newCtx = (): Ctx => ({ tokens: 0, window: 0, compaction: {} });

// How a process is driven: whether it can take a compaction now, how to send it a frame, how to re-read its numbers.
export type CompactPort = { idle: () => boolean; send: (frame: Record<string, unknown>) => void };

// Context size of a message's usage block: everything the request carried plus what it produced.
export function noteMessageUsage(c: Ctx, message: { usage?: Usage }): void {
	const u = message.usage;
	if (u) c.tokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
}

// `get_state` / `get_session_stats` responses: contextUsage {tokens, contextWindow, percent}, and the model window.
export function noteResponse(c: Ctx, f: Frame): void {
	if (f.type !== "response" || !f.success) return;
	if (f.command !== "get_state" && f.command !== "get_session_stats") return;
	const usage = f.data?.contextUsage;
	if (typeof usage?.tokens === "number") c.tokens = usage.tokens;
	const window = usage?.contextWindow ?? f.data?.model?.contextWindow;
	if (typeof window === "number" && window > 0) c.window = window;
}

export const percentOf = (c: Ctx): number | null => (c.window > 0 ? Math.round((c.tokens / c.window) * 1000) / 10 : null);
export const kTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function describeCtx(c: Ctx): string {
	const pct = percentOf(c);
	const n = (v: number) => v.toLocaleString("en-US");
	return `${n(c.tokens)} tokens${c.window ? ` of ${n(c.window)}${pct != null ? ` (${pct}%)` : ""}` : ""}`;
}

export function describeCompaction(c: Compaction): string {
	const at = c.at ? new Date(c.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
	if (c.state === "queued") return "compaction queued (after the current turn)";
	if (c.state === "compacting") return "compacting";
	if (c.state === "done") return `compacted at ${at}${c.tokensBefore ? ` (was ${kTokens(c.tokensBefore)})` : ""}`;
	if (c.state === "error") return `compaction failed at ${at}: ${c.error ?? "unknown error"}`;
	return "";
}

function startNow(c: Ctx, port: CompactPort): void {
	c.compaction = { state: "compacting", at: now() };
	port.send({ type: "compact" });
}

// Compacts now when the process is idle, otherwise queues it for the next agent_end.
export function requestCompact(c: Ctx, port: CompactPort): Compaction {
	const s = c.compaction.state;
	if (s === "queued" || s === "compacting") return c.compaction;
	if (port.idle()) startNow(c, port);
	else c.compaction = { state: "queued", at: now() };
	return c.compaction;
}

// Called at each point the process becomes idle (agent_end, start-up): sends a queued compaction.
export function flushCompact(c: Ctx, port: CompactPort): void {
	if (c.compaction.state === "queued" && port.idle()) startNow(c, port);
}

// The `compact` response arrives when omp finishes (or fails); numbers are re-read right after.
export function noteCompactResponse(c: Ctx, f: Frame, port: CompactPort): void {
	if (f.type !== "response" || f.command !== "compact") return;
	if (f.success) {
		c.compaction = { state: "done", at: now(), tokensBefore: typeof f.data?.tokensBefore === "number" ? f.data.tokensBefore : undefined };
		port.send({ type: "get_session_stats" });
	} else {
		c.compaction = { state: "error", at: now(), error: String(f.error ?? "compaction failed").slice(0, 300) };
		log(`compaction failed: ${c.compaction.error}`);
	}
}

// A compaction that failed, from any of the three places omp reports it: the `compact` response, the end of an
// automatic compaction, or an assistant message that ended in a compaction error (how a turn dies mid-compaction).
export function compactionError(f: Frame): string | undefined {
	if (f.type === "response" && f.command === "compact" && !f.success) return String(f.error ?? "compaction failed").slice(0, 300);
	if (f.type === "auto_compaction_end" && f.errorMessage) return String(f.errorMessage).slice(0, 300);
	if (f.type === "message_end" && f.message?.role === "assistant" && f.message.stopReason === "error" && /compaction/i.test(f.message.errorMessage ?? "")) return String(f.message.errorMessage).slice(0, 300);
}

// The process went away before a queued or running compaction finished.
export function abandonCompact(c: Ctx, reason: string): void {
	const s = c.compaction.state;
	if (s === "queued" || s === "compacting") c.compaction = { state: "error", at: now(), error: reason };
}

export const ctxView = (c: Ctx) => ({ tokens: c.tokens, window: c.window, percent: percentOf(c), compaction: c.compaction });

// The most recent user/assistant exchanges of a saved omp session (oldest first, ~9000 chars), the body of a handover
// into a fresh session. undefined when the session file cannot be read.
type SessionMessage = { role?: string; content?: string | Array<{ type?: string; text?: string }> };
export function recentExchanges(sessionFile: string): string | undefined {
	const turns: string[] = [];
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
			const parsed: { message?: SessionMessage } = JSON.parse(line);
			const m = parsed.message;
			if (!m) continue;
			const t = (Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join("") : (m.content ?? "")).trim();
			if (!t || t.startsWith("[keepalive]") || t === "ok" || t.startsWith("[dotz gateway] You are") || t.includes("\n[dotz lane ")) continue;
			turns.push(`${m.role === "user" ? "IN" : "YOU"}: ${t.length > 700 ? `${t.slice(0, 700)}...` : t}`);
		}
	} catch {
		return undefined;
	}
	const tail: string[] = [];
	for (let i = turns.length - 1, size = 0; i >= 0 && size + turns[i].length < 9000; size += turns[i].length, i--) tail.unshift(turns[i]);
	return tail.join("\n\n");
}
