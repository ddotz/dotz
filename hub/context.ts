// Context-window usage and on-demand compaction of an agent process, shared by the orchestrator and every lane.
// Numbers arrive as the runtime adapter's `usage` events (message usage, and the runtime's own accounting). A compaction
// is requested through the process; a runtime may cut a running turn to compact, so a busy process is queued and
// compacted at its next idle point (the turn_end event).
import { log, now } from "./config.ts";
import type { AgentEvent } from "./runtime/types.ts";

export type CompactState = "queued" | "compacting" | "done" | "error";
export type Compaction = { state?: CompactState; at?: string; tokensBefore?: number; error?: string };
export type Ctx = { tokens: number; window: number; compaction: Compaction };

export const newCtx = (): Ctx => ({ tokens: 0, window: 0, compaction: {} });

// How a process is driven: whether it can take a compaction now, how to start one, how to re-read its numbers.
export type CompactPort = { idle: () => boolean; compact: () => void; refreshUsage: () => void };

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
	port.compact();
}

// Compacts now when the process is idle, otherwise queues it for the next turn_end.
export function requestCompact(c: Ctx, port: CompactPort): Compaction {
	const s = c.compaction.state;
	if (s === "queued" || s === "compacting") return c.compaction;
	if (port.idle()) startNow(c, port);
	else c.compaction = { state: "queued", at: now() };
	return c.compaction;
}

// Called at each point the process becomes idle (turn_end, start-up): starts a queued compaction.
export function flushCompact(c: Ctx, port: CompactPort): void {
	if (c.compaction.state === "queued" && port.idle()) startNow(c, port);
}

// Context numbers and the outcome of a requested compaction, from the adapter's events; the numbers are re-read right
// after a finished compaction.
export function noteEvent(c: Ctx, ev: AgentEvent, port: CompactPort): void {
	if (ev.type === "usage") {
		if (ev.tokens !== undefined) c.tokens = ev.tokens;
		if (ev.window !== undefined) c.window = ev.window;
	} else if (ev.type === "compaction" && ev.state === "done") {
		c.compaction = { state: "done", at: now(), tokensBefore: ev.tokensBefore };
		port.refreshUsage();
	} else if (ev.type === "compaction" && ev.state === "error" && ev.requested) {
		c.compaction = { state: "error", at: now(), error: ev.error };
		log(`compaction failed: ${c.compaction.error}`);
	}
}

// The process went away before a queued or running compaction finished.
export function abandonCompact(c: Ctx, reason: string): void {
	const s = c.compaction.state;
	if (s === "queued" || s === "compacting") c.compaction = { state: "error", at: now(), error: reason };
}

export const ctxView = (c: Ctx) => ({ tokens: c.tokens, window: c.window, percent: percentOf(c), compaction: c.compaction });
