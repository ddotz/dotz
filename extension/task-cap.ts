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
// 5% and leaves 10. Raised 2026-11-13 to 400K with the cap doubled (24M, step 6M, ceiling 48M): 150K compacted 61% of workers, where
// same-model workers outside dotz ran to 290K without one; a replay of 2026-11-06..13 predicts 12 capped workers instead of 22. The compaction's summary request re-sends the whole context, so it is counted against the cap. ctx.compact aborts the running turn and only continues a session that has queued input, and a message
// queued before it finishes starts a run that compaction then waits behind (seen on a real rpc run, where the compaction
// ran after the whole task), so the hidden message that continues the worker is sent when the compaction ends, done or
// failed, unless the worker's last turn was already its final answer (a message then would start a turn that replaces the
// report; OmO's post-compact-restoration message rides on the next turn start and starts none itself). The runtime ends an
// aborted or superseded compaction with neither callback, so a tool turn that ends while one is pending re-arms it.
// Growth (task-cap-grow.ts, guard.task_cap_grow): the cap is not a wall for a worker that is getting somewhere. At the 75% warning point
// and again before each grown cap the worker's own signals since the last checkpoint (commits and changed paths from one git read, edited
// files, finished todo items, against repeated calls and a long run without a write; no model call) are judged: progress raises the cap by
// guard.task_cap_step up to guard.task_cap_ceiling and the handoff steer waits, no progress warns and blocks as before. The allowance
// restarts when a follow-up reaches a worker that had given its final answer; an `Estimate: N%` line of the brief sets the starting cap
// and little room in the subscription windows shrinks the step. Each growth and the stop are one line the worker is told to copy to the end
// of its final answer: that answer is the only channel to the parent. Switched off (false), nothing of this runs.
// The orchestrator and lanes have their own compaction path and never load this file.
// OmO itself has no per-task token budget (its tokenBudget is the goal tool's only), so the cap lives here.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGuardConfig } from "./guard-config.ts";
import { type CapEvent, type Growth, growLine, growthFor } from "./task-cap-grow.ts";

const BLOCKS_BEFORE_ABORT = 3;
// Past the cap, read-only collection calls (a file, a background session's output, a detached cell's result) still run, so the
// final answer can report what a run it started ended with; they count no block, up to this many.
const READS_AT_CAP = 10;
const collects = (name: unknown, input: any) => name === "read" || name === "bash_output" || (name === "eval" && input?.action === "peek");
// Whether this process's task worker has reached its cap (bg-guard.ts stops re-prompting it then); false with no cap installed.
let reached = () => false;
export const capReached = (): boolean => reached();
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

const copyLines = (lines: string[]) => (lines.length ? ` End the answer with these lines, verbatim:\n${lines.join("\n")}` : "");

export const capReason = (spent: number, cap: number, turns: number, handoff: string, lines: string[] = []) =>
	`[fail] dotz task token cap: this worker has used ${k(spent)} tokens over ${turns} turns (cap ${k(cap)}, guard.task_token_cap) without finishing. Tools are disabled. Write your final answer now, starting with "[fail] token cap ${k(spent)}": what is done (changed paths), the last state you reached, what blocked progress, and what remains, then the line "handoff: ${handoff}" (the file you wrote at the 75% warning, or "handoff: none" if you did not).${copyLines(lines)}`;

export const capWarning = (spent: number, cap: number, handoff: string, lines: string[] = []) =>
	`[dotz] task token budget: this worker has used ${k(spent)} of its ${k(cap)} token cap (guard.task_token_cap); at the cap its tools are disabled. Now write a handoff file at ${handoff} (create the folder if needed, at most 30 lines): done, remaining, the exact next step, changed paths. Then commit what you have, finish or report the remainder, and do not start new long runs.${copyLines(lines)}`;

const capGrown = (line: string) => `[dotz] task token budget grown, keep working and write no handoff yet. End your final answer with this line, verbatim:\n${line}`;

// The two events that reach the worker as a hidden steer; a stop is delivered by the blocked call itself.
function announce(pi: Host, ctx: any, event: CapEvent | undefined, growth: Growth): void {
	const content = event?.kind === "warn" ? capWarning(event.spent, event.cap, handoffPath(ctx), growth.lines()) : event?.kind === "grow" ? capGrown(growLine(event)) : undefined;
	if (content) pi.sendMessage({ customType: "dotz-task-cap", content, display: false }, { deliverAs: "steer" });
}

const compactNote = (tokens: number, done: boolean) =>
	`[dotz] your context (${k(tokens)}) ${done ? "was compacted" : "could not be compacted"} to keep turns cheap. Continue the task from ${done ? "the summary and " : ""}your last step; re-read a file only when you need its exact text.`;

// A completed assistant answer that ended the run: stopReason "stop" (not aborted, not a tool-use turn) and no tool call in it.
const isFinalAnswer = (message: any): boolean =>
	message?.role === "assistant" && message.stopReason === "stop" && !(Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall"));

type Host = { on: (name: string, fn: (event: any, ctx: any) => any) => void; sendMessage: (message: any, options?: any) => unknown };

export function installTaskCap(pi: Host, cap = loadGuardConfig().task_token_cap, compactAt = loadGuardConfig().task_compact_tokens, growth: Growth = growthFor(cap)): void {
	if (!(cap > 0) && !(compactAt > 0)) return;
	let spent = 0;
	let turns = 0;
	let blocked = 0;
	// A context size at or above which the next turn end compacts; Infinity while a compaction is pending.
	let compactFrom = compactAt;
	let compacted = false;
	// Whether the latest turn was the worker's final answer; a compaction that ends after it must not start another turn.
	let finalAnswer = false;
	pi.on("turn_end", (event: any, ctx: any) => {
		finalAnswer = isFinalAnswer(event?.message);
		if (finalAnswer) growth.finished();
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
			} else if (context >= compactFrom && !(cap > 0 && spent >= growth.cap())) {
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
		if (cap > 0) announce(pi, ctx, growth.turn(spent), growth);
	});
	if (!(cap > 0)) return;
	reached = () => spent >= growth.cap();
	let reads = 0;
	if (growth.enabled)
		pi.on("before_agent_start", (event: any) => {
			if (!event?.preview && growth.prompt(event?.prompt, spent) === "revived") blocked = reads = 0;
		});
	pi.on("tool_call", (event: any, ctx: any) => {
		growth.note(event?.toolName, event?.input);
		announce(pi, ctx, growth.atCap(spent), growth);
		if (spent < growth.cap()) return;
		if (collects(event?.toolName, event?.input) && reads++ < READS_AT_CAP) return;
		if (++blocked > BLOCKS_BEFORE_ABORT) ctx?.abort?.();
		return { block: true, reason: capReason(spent, growth.cap(), turns, handoffPath(ctx), growth.lines()) };
	});
}
