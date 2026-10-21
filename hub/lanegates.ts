import { splitThinking } from "./config.ts";
import { basename } from "node:path";

const BRIEF_MAX = 8000;
const DONE_RE = /(done[- ]?when|done\s*=|acceptance|완료\s*조건)/i;

// A lane is for multi-hour, multi-step project work (the 오모냥 rule): anything shorter the orchestrator does itself or
// with task subagents, whose results come back into its own session, so no channel, worktree or report relay is spent on
// it. The launch must say why a lane is needed and how long the work is expected to take; under LANE_MIN_HOURS it is
// refused unless the owner asked for a lane.
export const LANE_MIN_HOURS = 1;
export function laneJustification(why: unknown, hours: unknown, ownerAsked: boolean): string | undefined {
	const reason = typeof why === "string" ? why.trim() : "";
	if (reason.length < 15) return "say why this needs a lane (why): a lane is only for multi-hour, multi-step project work; do shorter work yourself or with task subagents, whose results come back into your session";
	if (ownerAsked) return undefined;
	const h = Number(hours);
	if (!Number.isFinite(h) || h <= 0) return "give the expected duration in hours (hours)";
	if (h < LANE_MIN_HOURS) return `a ${h}h job does not get a lane (lanes start at ${LANE_MIN_HOURS}h): do it yourself or with task subagents, whose results come back into your session`;
	return undefined;
}

export function checkBrief(brief: string): string | undefined {
	if (!brief.trim()) return "brief is empty";
	if (brief.length > BRIEF_MAX) return `brief is ${brief.length} chars (max ${BRIEF_MAX}): pass paths, not pasted contents`;
	if (!DONE_RE.test(brief)) return "brief needs an observable done-condition line (\"Done when: ...\")";
	return undefined;
}

// Fable, or any model at xhigh/max effort, is spent only when the owner asked for it.
export const isExpensive = (selector: string) => /fable/i.test(selector) || /^(max|xhigh)$/i.test(splitThinking(selector).thinking ?? "");

// Budget gate (owner rule 2026-10-18): a job is assumed to use `est` % of the 5h window (default 15) and 10% must stay.
// The 7d window never gates; its remaining % is only shown in the message.
export const DEFAULT_EST = 15;
// The share of the 5h window that must stay after a job's estimate (budget gate).
export const BUDGET_MARGIN = 10;
export const BUDGET_WINDOW_HOURS = 5; // the provider window the gate reads (anthropic:<n>h)
// `est` (launch arg) wins over an "Estimate: N%" line in the brief; absent or invalid -> DEFAULT_EST.
export function estimateOf(est: unknown, brief = ""): number {
	const n = Number(est ?? /^\s*Estimate:\s*(\d+(?:\.\d+)?)\s*%?/im.exec(brief)?.[1]);
	return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_EST;
}
export function budgetVerdict(five: number | undefined, week: number | undefined, est: number): string | undefined {
	if (typeof five !== "number" || five - est >= BUDGET_MARGIN) return undefined;
	return `${BUDGET_WINDOW_HOURS}h window ${five}% left; this job is assumed to use ~${est}%, leaving under ${BUDGET_MARGIN}%${typeof week === "number" ? `; 7d window ${week}% left (info only)` : ""}`;
}

export type BudgetOutcome = "go" | "blocked" | "forced" | "unknown";
// One audit line per lane-launch gate decision; unfetched windows print as "?".
export function budgetLine(name: string, est: number, five: number | undefined, week: number | undefined, outcome: BudgetOutcome): string {
	const left = (v: number | undefined) => (typeof v === "number" ? `${v}% left` : "? left");
	return `budget gate: lane ${name} est ${est}% 5h ${left(five)} 7d ${left(week)} -> ${outcome}`;
}

// The owner-facing title of a lane or work channel (docs/layers.md §2): 2-4 plain words of the work, never the key, the
// folder or repo basename, or anything codename-shaped. A reason in one line for the agent to retry with, else undefined.
const CODENAME = /^[a-z0-9._-]+$/;
export function titleProblem(title: unknown, ctx: { key?: string; cwd?: string; repo?: string } = {}): string | undefined {
	const t = typeof title === "string" ? title.trim() : "";
	const hint = "use 2-4 plain words of the work in the owner's language (e.g. 디스코드 설정)";
	if (!t) return `title required: ${hint}`;
	const same = [ctx.key, ctx.cwd && basename(ctx.cwd.replace(/\/+$/, "")), ctx.repo && basename(ctx.repo.replace(/\/+$/, ""))].filter(Boolean).map(s => s!.toLowerCase());
	if (same.includes(t.toLowerCase())) return `title "${t}" is the key or a folder name, not a title: ${hint}`;
	if (CODENAME.test(t)) return `title "${t}" looks like a codename (only a-z, 0-9, . _ -): ${hint}`;
	return undefined;
}
