// Token cap on OmO task workers of the orchestrator and of lanes (owner 2026-10-29: two railway CLI workers on 10-28 spent
// ~2M tokens each, ~40 turns re-reading a 70-80K context, and delivered nothing). Every provider turn's tokens (input, cache
// read and write, output: the token audit's "토큰" column) are summed; past `guard.task_token_cap` every further tool call is
// blocked with a [fail] note, so the worker's next answer is its final one (what it spent, partial state, the handoff file)
// and goes back to the parent like any task result. A worker that keeps calling tools after BLOCKS_BEFORE_ABORT blocked calls
// is aborted. Past WARN_AT of the cap (owner 2026-11-05) one hidden steer tells it to write a handoff file (done, remaining,
// the exact next step, changed paths) and wrap up, so a parent can continue by spawning a worker with that file instead of
// redoing the work. A turn that ran no tools is skipped: it is the worker's final answer, and a steer there would start
// another turn that replaces it.
// Cost per worker turn is its whole context re-read from cache (97% of worker tokens, 7-day scan 2026-11-05: 47 of 362
// workers hit the cap, 35% of all worker tokens), so a worker whose context passes `guard.task_compact_tokens` at a turn end
// between tool steps compacts itself once (OmO's 1M window never triggers its own auto compaction). Replay of 7 days of real
// worker logs, with the 78K context a real compaction left and the re-written prefix priced as a cache write: 150K saves 23% of
// the tokens and 6% of the cost and leaves 2 of 39 cap hits; 120K saves 28% and 3% (twice the compactions); 200K saves 14% and
// 5% and leaves 10. The compaction's summary request re-sends the whole context, so it is counted against the cap. ctx.compact aborts the running turn and only continues a session that has queued input, and a message
// queued before it finishes starts a run that compaction then waits behind (seen on a real rpc run, where the compaction
// ran after the whole task), so the hidden message that continues the worker is sent when the compaction ends, done or
// failed, unless the worker's last turn was already its final answer (a message then would start a turn that replaces the
// report; OmO's post-compact-restoration message rides on the next turn start and starts none itself). The runtime ends an
// aborted or superseded compaction with neither callback, so a tool turn that ends while one is pending re-arms it.
// The orchestrator and lanes have their own compaction path and never load this file.
// OmO itself has no per-task token budget (its tokenBudget is the goal tool's only), so the cap lives here.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGuardConfig } from "./guard-config.ts";

const BLOCKS_BEFORE_ABORT = 3;
const WARN_AT = 0.75;
// After a compaction, failed or not, the next try waits until the context is this much above what it was then.
const REARM_GROWTH = 50_000;
const k = (n: number) => `${Math.round(n / 1000).toLocaleString("en-US")}K`;

export const turnTokens = (message: any): number => {
	const u = message?.role === "assistant" ? message.usage : undefined;
	return u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0) : 0;
};

// The context a turn sent: everything but its output.
const contextTokens = (message: any): number => {
	const u = message?.role === "assistant" ? message.usage : undefined;
	return u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
};

// One handoff file per worker session, outside the repo so it is never committed.
export const handoffPath = (ctx: any) => join(tmpdir(), "dotz-handoff", `${ctx?.sessionManager?.getSessionId?.() ?? `pid-${process.pid}`}.md`);

export const capReason = (spent: number, cap: number, turns: number, handoff: string) =>
	`[fail] dotz task token cap: this worker has used ${k(spent)} tokens over ${turns} turns (cap ${k(cap)}, guard.task_token_cap) without finishing. Tools are disabled. Write your final answer now, starting with "[fail] token cap ${k(spent)}": what is done (changed paths), the last state you reached, what blocked progress, and what remains, then the line "handoff: ${handoff}" (the file you wrote at the 75% warning, or "handoff: none" if you did not).`;

export const capWarning = (spent: number, cap: number, handoff: string) =>
	`[dotz] task token budget: this worker has used ${k(spent)} of its ${k(cap)} token cap (guard.task_token_cap); at the cap its tools are disabled. Now write a handoff file at ${handoff} (create the folder if needed, at most 30 lines): done, remaining, the exact next step, changed paths. Then commit what you have, finish or report the remainder, and do not start new long runs.`;

const compactNote = (tokens: number, done: boolean) =>
	`[dotz] your context (${k(tokens)}) ${done ? "was compacted" : "could not be compacted"} to keep turns cheap. Continue the task from ${done ? "the summary and " : ""}your last step; re-read a file only when you need its exact text.`;

// A completed assistant answer that ended the run: stopReason "stop" (not aborted, not a tool-use turn) and no tool call in it.
const isFinalAnswer = (message: any): boolean =>
	message?.role === "assistant" && message.stopReason === "stop" && !(Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall"));

type Host = { on: (name: string, fn: (event: any, ctx: any) => any) => void; sendMessage: (message: any, options?: any) => unknown };

export function installTaskCap(pi: Host, cap = loadGuardConfig().task_token_cap, compactAt = loadGuardConfig().task_compact_tokens): void {
	if (!(cap > 0) && !(compactAt > 0)) return;
	let spent = 0;
	let turns = 0;
	let blocked = 0;
	let warned = false;
	// A context size at or above which the next turn end compacts; Infinity while a compaction is pending.
	let compactFrom = compactAt;
	let compacted = false;
	// Whether the latest turn was the worker's final answer; a compaction that ends after it must not start another turn.
	let finalAnswer = false;
	pi.on("turn_end", (event: any, ctx: any) => {
		finalAnswer = isFinalAnswer(event?.message);
		const t = turnTokens(event?.message);
		if (t > 0) {
			spent += t;
			turns++;
		}
		if (event?.toolResults?.length === 0) return;
		const context = contextTokens(event?.message);
		if (compactAt > 0) {
			if (compacted) {
				compacted = false;
				compactFrom = Math.max(compactAt, context + REARM_GROWTH);
			} else if (compactFrom === Number.POSITIVE_INFINITY) {
				// A tool turn ran while a compaction was pending: the runtime ended it with neither onComplete nor onError (aborted or superseded), so re-arm.
				compactFrom = Math.max(compactAt, context + REARM_GROWTH);
			} else if (context >= compactFrom && !(cap > 0 && spent >= cap)) {
				compactFrom = Number.POSITIVE_INFINITY;
				spent += context;
				const resume = (done: boolean) => finalAnswer || pi.sendMessage({ customType: "dotz-task-compact", content: compactNote(context, done), display: false }, { triggerTurn: true, deliverAs: "followUp" });
				ctx.compact({
					onComplete: () => {
						compacted = true;
						resume(true);
					},
					onError: () => {
						compactFrom = context + REARM_GROWTH;
						resume(false);
					},
				});
			}
		}
		if (!(cap > 0) || warned || spent < cap * WARN_AT || spent >= cap) return;
		warned = true;
		pi.sendMessage({ customType: "dotz-task-cap", content: capWarning(spent, cap, handoffPath(ctx)), display: false }, { deliverAs: "steer" });
	});
	if (!(cap > 0)) return;
	pi.on("tool_call", (_event: any, ctx: any) => {
		if (spent < cap) return;
		if (++blocked > BLOCKS_BEFORE_ABORT) ctx?.abort?.();
		return { block: true, reason: capReason(spent, cap, turns, handoffPath(ctx)) };
	});
}
