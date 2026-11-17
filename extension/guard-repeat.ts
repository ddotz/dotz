// Repeat guard, ported from oh-my-hermes tool_bursts.py: a model that reads a refusal and re-issues the same call 100+ times
// burns the session. Per session we keep digests of the last calls (tool + canonical args) and of what each returned, so
// the same call whose output changes (a poll: `gh pr checks`) is not a loop. A cycle of period 1..4 at the history end
// engages stage 1 (block) when the call about to run would complete the required laps; after REPEAT_ESCALATION_ATTEMPTS
// ignored blocks stage 2 asks a human (ctx.ui.confirm) or, with nobody to ask, tells the model to stop and report.
import { createHash } from "node:crypto";
import type { GuardConfig } from "./guard-config.ts";
import { debug } from "./guard-debug.ts";

const REPEAT_MAX_PERIOD = 4;
export const REPEAT_MIN_LAPS = 3;
export const REPEAT_ESCALATION_ATTEMPTS = 4;
export const REPEAT_HISTORY = 16;
export const REPEAT_MAX_SESSIONS = 64;
export const REPEAT_WINDOW_MS = 300_000;
const REPEAT_ARGS_MAX_CHARS = 1024 * 1024;
const REPEAT_RESULT_PREFIX = 8192;

export interface RepeatCall { tool: string; args: string; result: string; id: string }
export interface RepeatEngaged { sig: string; elements: RepeatCall[]; ran: number; compared: boolean }
export interface RepeatRow { calls: RepeatCall[]; blocked: number; engaged?: RepeatEngaged; seen: number }

// Tools that are legitimately re-invoked with identical args (waiting on background jobs).
const isPollerTool = (tool: string) => tool === "wait" || /_(get_result|poll)$/.test(tool);
const digestOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function canonicalJson(value: unknown): string {
	// Sorted keys: the same call must hash the same however the model ordered its arguments.
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v) ?? "";
}

// "" = unknown identity (circular, unserializable or oversized input): such a call is never counted as a repeat.
export function repeatArgsDigest(tool: string, input: unknown): string {
	try {
		const canonical = canonicalJson(input);
		return canonical.length > REPEAT_ARGS_MAX_CHARS ? "" : digestOf(`${tool}\0${canonical}`);
	} catch {
		return "";
	}
}

// Length plus a bounded prefix: a growing log changes length even when its first 8 KiB does not.
export function repeatResultDigest(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const text = content.map((b: { text?: string }) => (typeof b?.text === "string" ? b.text : "")).join("\n");
	return digestOf(`${text.length}:${text.slice(0, REPEAT_RESULT_PREFIX)}`);
}

// An unknown result (not yet back, or never observed) is no evidence of change: compare on arguments alone.
const sameCall = (a: RepeatCall, b: RepeatCall) =>
	a.tool === b.tool && a.args === b.args && (!a.result || !b.result || a.result === b.result);

// Shortest repeating cycle at the END of the history as [period, laps], or undefined. Laps count back-to-back repeats.
export function detectCycle(history: RepeatCall[]): [number, number] | undefined {
	const size = history.length;
	for (let period = 1; period <= REPEAT_MAX_PERIOD && size >= period * 2; period++) {
		let laps = 1;
		let start = size - period;
		while (start - period >= 0 && history.slice(start, start + period).every((call, i) => sameCall(history[start - period + i], call))) {
			laps++;
			start -= period;
		}
		if (laps < 2) continue;
		// A cycle made only of pollers is not a loop; try a longer period.
		if (history.slice(-period).every(call => isPollerTool(call.tool))) continue;
		return [period, laps];
	}
}

export const repeatSubject = (elements: RepeatCall[], ran: number) => {
	const tools = elements.map(call => `\`${call.tool}\``);
	return elements.length === 1 ? `${tools[0]} ran ${ran} times in a row with identical arguments` : `the same cycle of ${elements.length} calls (${tools.join(", ")}) ran ${ran} calls in a row with identical arguments`;
};
export const repeatBlockReason = (engaged: RepeatEngaged) =>
	`orchestrator-guard repeat guard: ${repeatSubject(engaged.elements, engaged.ran)}${engaged.compared ? ", and every one returned the same result" : ""}. Running it again will not produce anything new. Change the arguments or the approach (read the file directly, list what exists, use a different tool), or stop and report what blocks you. If you are waiting on something that changes, do other work between checks.`;
export const repeatStopReason = (engaged: RepeatEngaged, blocked: number) =>
	`[ask] orchestrator-guard repeat guard: ${repeatSubject(engaged.elements, engaged.ran)}, and ${blocked} further attempts were blocked. Stop now and do not retry it: report the loop to the owner in your final answer (the call, what you were trying to achieve, what you tried instead) and wait for direction.`;

export type RepeatEvent = { toolName?: unknown; toolCallId?: unknown; input?: unknown; content?: unknown };
export type RepeatCtx = { agent?: { id?: unknown }; sessionManager?: { getSessionId?: () => unknown }; hasUI?: boolean; ui?: { confirm?: (title: string, message: string, options: { timeout: number }) => Promise<unknown> } };

/** The repeat guard of one installed guard: its session rows and the two hooks that use them. `record` stores what a call returned, so an identical call whose output changes (a poll) is no loop. `check` is evaluated after every other block of a tool_call handler so existing blocks win; a blocked call is never recorded (the history freezes, so ignored blocks are counted instead of laps); a failure in it allows the call, because a guard bug must not veto work. A cycle of period p needs max(3, ceil(repeat_block_threshold / p)) laps before stage 1 (8, 8, 9, 12 calls for p = 1..4 at the default), so a coincidental A,B,A,B never reads as a loop. */
export function createRepeatGuard(config: GuardConfig) {
	const rows = new Map<string, RepeatRow>();
	const keyOf = (ctx: RepeatCtx | undefined) => String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.agent?.id ?? "");
	const requiredLaps = (period: number) => Math.max(REPEAT_MIN_LAPS, Math.ceil(config.repeat_block_threshold / period));
	return {
		record(event: RepeatEvent | undefined, ctx: RepeatCtx | undefined): void {
			try {
				const id = String(event?.toolCallId ?? "");
				const call = [...(rows.get(keyOf(ctx))?.calls ?? [])].reverse().find(c => (id ? c.id === id : !c.result && c.tool === event?.toolName && c.args === repeatArgsDigest(c.tool, event?.input)));
				if (call) call.result = repeatResultDigest(event?.content);
			} catch (error) {
				debug({ phase: "repeat-result-error", message: String(error) });
			}
		},
		async check(event: RepeatEvent | undefined, ctx: RepeatCtx | undefined): Promise<{ block: true; reason: string } | undefined> {
			try {
				const tool = String(event?.toolName ?? "");
				const args = repeatArgsDigest(tool, event?.input);
				if (!args) return;
				const now = Date.now();
				const key = keyOf(ctx);
				let row = rows.get(key);
				if (!row || now - row.seen > REPEAT_WINDOW_MS) row = { calls: [], blocked: 0, seen: now };
				row.seen = now;
				rows.delete(key);
				rows.set(key, row);
				if (rows.size > REPEAT_MAX_SESSIONS) rows.delete(rows.keys().next().value as string);
				const cand: RepeatCall = { tool, args, result: "", id: String(event?.toolCallId ?? "") };
				const tentative = [...row.calls, cand];
				const cycle = detectCycle(tentative);
				let engaged = row.engaged;
				if (cycle && cycle[1] >= requiredLaps(cycle[0])) {
					const [period, laps] = cycle;
					const elements = tentative.slice(-period);
					const sig = elements.map(c => `${c.tool}\0${c.args}`).sort().join("\n");
					if (engaged?.sig !== sig) row.blocked = 0;
					engaged = row.engaged = { sig, elements, ran: period * laps - 1, compared: tentative.slice(-period * laps, -1).every(c => c.result) };
				} else if (!engaged?.elements.some(c => c.tool === tool && c.args === args)) {
					row.calls = tentative.slice(-REPEAT_HISTORY);
					row.engaged = undefined;
					row.blocked = 0;
					return;
				}
				if (!engaged) return;
				const ignored = row.blocked++;
				debug({ phase: "repeat-block", agent: ctx?.agent?.id, tool, ignored, ran: engaged.ran });
				if (ignored < REPEAT_ESCALATION_ATTEMPTS) return { block: true, reason: repeatBlockReason(engaged) };
				const ui = ctx?.ui;
				// why(platform): an omp rpc session reports hasUI yet nobody answers its extension UI requests, so a confirm would hang the call forever (omp@18.22.0)
				const headless = !ctx?.hasUI || typeof ui?.confirm !== "function" || !!process.env.DOTZ_LANE || process.env.DOTZ_ORCHESTRATOR === "1";
				if (headless) return { block: true, reason: repeatStopReason(engaged, ignored) };
				const allowed = await ui?.confirm?.("Repeat guard", `${repeatSubject(engaged.elements, engaged.ran)}, and ${ignored} further attempts were blocked. Allow this call once more? Denying ends the repetition.`, { timeout: 60_000 });
				if (allowed !== true) return { block: true, reason: `orchestrator-guard repeat guard: the owner denied (or did not answer) this repeated call. ${repeatBlockReason(engaged)}` };
				row.calls = [cand];
				row.engaged = undefined;
				row.blocked = 0;
			} catch (error) {
				debug({ phase: "repeat-error", message: String(error) });
			}
		},
	};
}
