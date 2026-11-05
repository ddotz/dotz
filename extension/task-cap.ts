// Token cap on OmO task workers of the orchestrator and of lanes (owner 2026-10-29: two private-project CLI workers on 10-28 spent
// ~2M tokens each, ~40 turns re-reading a 70-80K context, and delivered nothing). Every provider turn's tokens (input, cache
// read and write, output: the token audit's "토큰" column) are summed; past `guard.task_token_cap` every further tool call is
// blocked with a [fail] note, so the worker's next answer is its final one (what it spent, partial state) and goes back to
// the parent like any task result. A worker that keeps calling tools after BLOCKS_BEFORE_ABORT blocked calls is aborted.
// Past WARN_AT of the cap (owner 2026-11-05) one hidden steer tells it to wrap up. A turn that ran no tools is skipped: it is
// the worker's final answer, and a steer there would start another turn that replaces it.
// OmO itself has no per-task token budget (its tokenBudget is the goal tool's only), so the cap lives here.
import { loadGuardConfig } from "./guard-config.ts";

const BLOCKS_BEFORE_ABORT = 3;
const WARN_AT = 0.75;
const k = (n: number) => `${Math.round(n / 1000).toLocaleString("en-US")}K`;

export const turnTokens = (message: any): number => {
	const u = message?.role === "assistant" ? message.usage : undefined;
	return u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0) : 0;
};

export const capReason = (spent: number, cap: number, turns: number) =>
	`[fail] dotz task token cap: this worker has used ${k(spent)} tokens over ${turns} turns (cap ${k(cap)}, guard.task_token_cap) without finishing. Tools are disabled. Write your final answer now, starting with "[fail] token cap ${k(spent)}": what is done (changed paths), the last state you reached, what blocked progress, and what remains.`;

export const capWarning = (spent: number, cap: number) =>
	`[dotz] task token budget: this worker has used ${k(spent)} of its ${k(cap)} token cap (guard.task_token_cap); at the cap its tools are disabled. Commit what you have now, finish or report the remainder, and do not start new long runs.`;

export function installTaskCap(pi: { on: (name: string, fn: (event: any, ctx: any) => any) => void; sendMessage: (message: any, options?: any) => unknown }, cap = loadGuardConfig().task_token_cap): void {
	if (!(cap > 0)) return;
	let spent = 0;
	let turns = 0;
	let blocked = 0;
	let warned = false;
	pi.on("turn_end", (event: any) => {
		const t = turnTokens(event?.message);
		if (t > 0) {
			spent += t;
			turns++;
		}
		if (warned || spent < cap * WARN_AT || spent >= cap || event?.toolResults?.length === 0) return;
		warned = true;
		pi.sendMessage({ customType: "dotz-task-cap", content: capWarning(spent, cap), display: false }, { deliverAs: "steer" });
	});
	pi.on("tool_call", (_event: any, ctx: any) => {
		if (spent < cap) return;
		if (++blocked > BLOCKS_BEFORE_ABORT) ctx?.abort?.();
		return { block: true, reason: capReason(spent, cap, turns) };
	});
}
