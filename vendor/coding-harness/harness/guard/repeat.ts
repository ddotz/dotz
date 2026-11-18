import { createHash } from "node:crypto";
import { textBlocks } from "./host-types.ts";

const REPEAT_BLOCK_THRESHOLD = 8;
const REPEAT_MAX_PERIOD = 4;
const REPEAT_MIN_LAPS = 3;
const REPEAT_ARGS_MAX_CHARS = 1024 * 1024;
const REPEAT_RESULT_PREFIX = 8192;

export const REPEAT_ESCALATION_ATTEMPTS = 4;
export const REPEAT_HISTORY = 16;
export const REPEAT_MAX_SESSIONS = 64;
export const REPEAT_WINDOW_MS = 300_000;

/** One call in a session's history: tool, digest of its canonical arguments, digest of what it returned ("" until the result is back) and its call id. */
export interface RepeatCall { tool: string; args: string; result: string; id: string }
/** A cycle the guard is blocking: its signature, its calls, how many calls of it ran, and whether every one of them had a known result. */
export interface RepeatEngaged { sig: string; elements: RepeatCall[]; ran: number; compared: boolean }
/**
 * Per-session repeat-guard state, ported from oh-my-hermes tool_bursts.py: a model that reads a refusal and re-issues the
 * same call 100+ times burns the session. A session keeps digests of its last calls (tool + canonical args) and of what each
 * returned, so the same call whose output changes (a poll: `gh pr checks`) is not a loop. A cycle of period 1..4 at the
 * history end engages stage 1 (block) when the call about to run would complete the required laps; after
 * REPEAT_ESCALATION_ATTEMPTS ignored blocks stage 2 asks a human (ctx.ui.confirm) or, with nobody to ask, tells the model
 * to stop and report.
 */
export interface RepeatRow { calls: RepeatCall[]; blocked: number; engaged?: RepeatEngaged; seen: number }

/** Laps of a `period`-long cycle before stage 1: period 1 -> 8 laps, 2 -> 4, 3 -> 3, 4 -> 3 (8, 8, 9, 12 calls). The laps floor keeps a coincidental A,B,A,B from reading as a loop. */
export const requiredLaps = (period: number) => Math.max(REPEAT_MIN_LAPS, Math.ceil(REPEAT_BLOCK_THRESHOLD / period));

const isPollerTool = (tool: string) => tool === "wait" || /_(get_result|poll)$/.test(tool);
const digestOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v) ?? "";
}

/** Digest of a call's tool and arguments with sorted keys, so the same call hashes the same however the model ordered them. "" = unknown identity (circular, unserializable or oversized input): such a call is never counted as a repeat. */
export function repeatArgsDigest(tool: string, input: unknown): string {
	try {
		const canonical = canonicalJson(input);
		return canonical.length > REPEAT_ARGS_MAX_CHARS ? "" : digestOf(`${tool}\0${canonical}`);
	} catch {
		return "";
	}
}

/** Digest of a result's length plus a bounded prefix: a growing log changes length even when its first 8 KiB does not. */
export function repeatResultDigest(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const text = textBlocks(content).join("\n");
	return digestOf(`${text.length}:${text.slice(0, REPEAT_RESULT_PREFIX)}`);
}

const sameCall = (a: RepeatCall, b: RepeatCall) =>
	a.tool === b.tool && a.args === b.args && (!a.result || !b.result || a.result === b.result);

/** Shortest repeating cycle at the END of the history as [period, laps], or undefined. Laps count back-to-back repeats; an unknown result is no evidence of change, so calls compare on arguments alone; a cycle made only of pollers (`wait`, `*_get_result`, `*_poll`) is not a loop. */
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
		if (history.slice(-period).every(call => isPollerTool(call.tool))) continue;
		return [period, laps];
	}
}

/** The sentence naming what ran: one call, or a cycle of several. */
export const repeatSubject = (elements: RepeatCall[], ran: number) => {
	const tools = elements.map(call => `\`${call.tool}\``);
	return elements.length === 1 ? `${tools[0]} ran ${ran} times in a row with identical arguments` : `the same cycle of ${elements.length} calls (${tools.join(", ")}) ran ${ran} calls in a row with identical arguments`;
};

/** The stage 1 refusal text. */
export const repeatBlockReason = (engaged: RepeatEngaged) =>
	`orchestrator-guard repeat guard: ${repeatSubject(engaged.elements, engaged.ran)}${engaged.compared ? ", and every one returned the same result" : ""}. Running it again will not produce anything new. Change the arguments or the approach (read the file directly, list what exists, use a different tool), or stop and report what blocks you. If you are waiting on something that changes, do other work between checks.`;

/** The stage 2 refusal text for a session with nobody to ask. */
export const repeatStopReason = (engaged: RepeatEngaged, blocked: number) =>
	`[ask] orchestrator-guard repeat guard: ${repeatSubject(engaged.elements, engaged.ran)}, and ${blocked} further attempts were blocked. Stop now and do not retry it: report the loop to the owner in your final answer (the call, what you were trying to achieve, what you tried instead) and wait for direction.`;
