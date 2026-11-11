// Context-window usage and on-demand compaction of an agent process, shared by the orchestrator and every lane.
// Numbers arrive as the runtime adapter's `usage` events (message usage, and the runtime's own accounting). A compaction
// is requested through the process; a runtime may cut a running turn to compact, so a busy process is queued and
// compacted at its next idle point (the turn_end event).
import { log, now } from "./config.ts";
import type { AgentEvent } from "./runtime/types.ts";

type CompactState = "queued" | "compacting" | "done" | "error";
export type Compaction = { state?: CompactState; at?: string; tokensBefore?: number; error?: string };
// `ahead`: the running compaction was started at rest, ahead of the compaction point; `aborting`: its abort was asked for.
export type Ctx = { tokens: number; window: number; compaction: Compaction; retried?: boolean; ahead?: { who: string; reason: string; tokens: number; t0: number }; aborting?: boolean };

export const newCtx = (): Ctx => ({ tokens: 0, window: 0, compaction: {} });

// How a process is driven: whether it can take a compaction now, how to start one, how to re-read its numbers.
export type CompactPort = { idle: () => boolean; compact: () => void; refreshUsage: () => void; abort?: () => void };

// A conversation at rest (no turn, nothing queued, deferred or held, no worker, quiet for REST_QUIET_MS) past this share of its compaction
// point is compacted ahead of time, while the 1h prompt cache of its last turn is still warm (keepalive pings start at 50 min).
// Replayed on the 15 days of the main session (263 turn ends, median 3.5 min to the next activity, 90 gaps over 10 min): 0.6 after 10 min
// moves the compactions the owner waited behind from 3 to 0 at the price of 7 more compactions in all (11 -> 18), 13 of them at rest.
export const REST_FRACTION = 0.6;
export const REST_QUIET_MS = 10 * 60_000;

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

// A process whose context reached `at` tokens is due a compaction unless one is already queued or running.
export const compactDue = (c: Ctx, at: number): boolean => c.tokens >= at && c.compaction.state !== "queued" && c.compaction.state !== "compacting";

// Due at rest: past the share of the compaction point but not yet at it (the normal trigger takes it from there), after a quiet
// period, with nothing waiting for the process (`busy`: a held, queued or deferred prompt, a worker). A failed compaction is not retried
// every minute at rest; the normal trigger decides from there.
export const restDue = (c: Ctx, at: number, r: { busy: boolean; quietMs: number }): boolean => !r.busy && r.quietMs >= REST_QUIET_MS && c.tokens < at && c.compaction.state !== "error" && compactDue(c, at * REST_FRACTION);

// Set by the hub: the main conversation is not at rest while a prompt for it is queued, open or deferred (the orchestrator cannot see the queue).
export const restGuard = { blocked: (): boolean => false };

// The minute tick of a conversation (`s.ready`: a live idle process that can abort and is not rotating, restarting, paused or failing;
// `s.busy`: a held or unstarted prompt, a worker): starts the compaction ahead of time when it is due at rest.
export function restAhead(c: Ctx, port: CompactPort, who: string, s: { ready: boolean; busy: boolean; quietMs: number }, at: number): void {
	if (s.ready && restDue(c, at, { busy: s.busy || restGuard.blocked(), quietMs: s.quietMs })) requestAhead(c, port, who, `at rest for ${Math.round(s.quietMs / 60_000)} min`);
}

// Starts a compaction at rest; false when the process cannot take it now or cannot abort it later (the owner would wait behind it).
export function requestAhead(c: Ctx, port: CompactPort, who: string, reason: string, at = Date.now()): boolean {
	if (!port.abort || !port.idle() || c.compaction.state === "queued" || c.compaction.state === "compacting") return false;
	c.ahead = { who, reason, tokens: c.tokens, t0: at };
	startNow(c, port);
	return true;
}

// An owner message arrived: a compaction started ahead of time is aborted (the message is delivered once it reports back). False when
// the running compaction is the normal one, or its abort was already asked for.
export function abortAhead(c: Ctx, port: CompactPort): boolean {
	if (c.compaction.state !== "compacting" || !c.ahead || c.aborting || !port.abort) return false;
	c.aborting = true;
	port.abort();
	return true;
}

// One log line per compaction ahead of time: how it ended, tokens before, why it ran, seconds.
function endAhead(c: Ctx, outcome: "done" | "aborted" | "failed"): void {
	if (c.ahead) log(`${c.ahead.who} ahead-of-time compaction ${outcome}: ${c.ahead.tokens} tokens before, ${c.ahead.reason}, ${Math.round((Date.now() - c.ahead.t0) / 1000)} s`);
	c.ahead = undefined;
	c.aborting = false;
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
		endAhead(c, "done");
		c.compaction = { state: "done", at: now(), tokensBefore: ev.tokensBefore };
		c.retried = false;
		port.refreshUsage();
	} else if (ev.type === "compaction" && ev.state === "error" && ev.requested) {
		if (c.aborting) {
			// Aborted for an owner message: nothing failed, the context stays as it was and the next rest tries again.
			endAhead(c, "aborted");
			c.compaction = {};
			return;
		}
		endAhead(c, "failed");
		c.compaction = { state: "error", at: now(), error: ev.error };
		log(`compaction failed: ${c.compaction.error}`);
	}
}

// OmO refuses a summary when the session changed while it was made ("retry compaction"). A requested compaction refused that way
// is queued again once, for the next idle point; a second refusal is a failure. True when it was queued.
export function requeueRefused(c: Ctx, error: string): boolean {
	if (c.retried || c.compaction.state !== "error" || !/retry compaction/i.test(error)) return false;
	c.retried = true;
	c.compaction = { state: "queued", at: now() };
	return true;
}

// The process went away before a queued or running compaction finished.
export function abandonCompact(c: Ctx, reason: string): void {
	const s = c.compaction.state;
	c.ahead = undefined;
	c.aborting = false;
	if (s === "queued" || s === "compacting") c.compaction = { state: "error", at: now(), error: reason };
}

export const ctxView = (c: Ctx) => ({ tokens: c.tokens, window: c.window, percent: percentOf(c), compaction: c.compaction });
