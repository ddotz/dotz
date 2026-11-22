import { createHash } from "node:crypto";
import { type NoticeText, say } from "../notice.ts";
import type { AcceptedComment } from "./escape.ts";
import type { Preexisting } from "./types.ts";

/** The same unsatisfied state is refused this many times in a row before the stop passes as unsatisfied. */
export const MAX_BLOCKS = 3;

/** One run, from prompt to allowed stop, is refused this many times in total for failures, findings and missing evidence, whatever those were. */
export const MAX_REFUSALS = 8;

/** One run is refused this many times in total only because a check is still running; every check is bounded by its own `timeoutSec`, which counts as a failure, so waiting needs only a loose cap. */
export const MAX_WAITS = 30;

/** What a refusal for work ends with, and a check's failure that arrives after a stop: fix the cause and finish again, and make the reply after the fix the final report, since that reply is what the user reads. */
export const CLOSING = "Fix the cause and finish again; do not edit the gate file or the check to get through. The reply you write after the fix is what the user reads, so write it as the final report.";
const WAIT_CLOSING = "Finish again to wait for it: each stop waits for the check and the next one collects its result. End this turn with one short line, not a report; once the check is in, the gate asks for the final report.";
const STAGE_ORDER: readonly string[] = ["escape", "rules", "defaults", "mistakes", "verify", "cite", "plain", "ask", "leftover", "report"];

/** What a stop came to for one repo. `running` is a refusal made only to wait for a check; `deferred` is a stop an interactive session was let through while a check of the repo was still running, whose result arrives when the check ends. */
export type Outcome = "clean" | "pass" | "blocked" | "fixed" | "waived" | "user-waived" | "unsatisfied" | "no-gate" | "error" | "running" | "deferred";

/**
 * One reason to refuse a stop. A `finding` is what a stage (escape, rules, mistakes) found, with `name` the stage; the other
 * kinds are a failed or still running check and missing evidence, with `name` the check or evidence entry. `classes` counts
 * what the item stands for per `stage:class`, and `label` is how a notice names it when it has to be let through.
 */
export interface Problem {
	kind: "check" | "evidence" | "running" | "finding";
	repo: string;
	name: string;
	state: string;
	text: string;
	classes: Record<string, number>;
	label?: string;
}

/** What one repo came to at a stop; `accepted` are the why comments the anti-escape stage let stay in it, `unscanned` the changed files it could not read, `preexisting` the rule occurrences outside the session's changes. */
export interface RepoResult {
	repo: string;
	changed: number;
	gated: boolean;
	problems: Problem[];
	waived: string[];
	warnings: string[];
	accepted: AcceptedComment[];
	unscanned: string[];
	preexisting: Preexisting[];
	blockedBefore: boolean;
	stageErrors: string[];
	error?: string;
}

export interface Streak {
	signature: string;
	blocks: number;
}

export interface RunMemory {
	streak?: Streak;
	refusals: number;
	waits: number;
}

export type Decision =
	| { block: false; outcomes: Record<string, Outcome>; streak: Streak | undefined; notices: string[] }
	| { block: true; running: boolean; reason: string; outcomes: Record<string, Outcome>; streak: Streak | undefined; notices: string[] };

const describe = (problem: Problem): string => `${problem.repo}: ${problem.label ?? problem.name}`;

function stageRank(problem: Problem): number {
	const rank = STAGE_ORDER.indexOf(problem.name);
	return rank === -1 ? STAGE_ORDER.length : rank;
}

/**
 * Turns the per-repo results of a stop into allow or refuse. A refusal only for a check that is still running (`running`) does
 * not count towards the same-state streak or the run's refusal total; it counts towards its own total. Every other refusal
 * counts towards the refusal total. A refusal lists what the stages found first (escape, rules, mistakes), then a running
 * check, then failed checks and missing evidence.
 */
export function decideStop(results: readonly RepoResult[], memory: RunMemory): Decision {
	const settled = (r: RepoResult): Outcome => {
		if (r.error !== undefined || r.stageErrors.length > 0) return "error";
		if (r.waived.length) return "waived";
		if (r.blockedBefore) return "fixed";
		if (!r.gated) return "no-gate";
		return r.changed > 0 ? "pass" : "clean";
	};
	const outcomes: Record<string, Outcome> = {};
	const mark = (pick: (r: RepoResult) => Outcome) => {
		for (const r of results) outcomes[r.repo] = pick(r);
	};
	const notices = results.filter(r => r.waived.length).map(r => say({ en: `done-gate: ${r.repo} passed by waiver (${r.waived.join("; ")}).`, ko: `done-gate: ${r.repo}은(는) 면제로 통과했습니다(${r.waived.join("; ")}).` }));
	const all = results.flatMap(r => r.problems);
	const staged = all.filter(p => p.kind === "finding").sort((a, b) => stageRank(a) - stageRank(b));
	const verdicts = all.filter(p => p.kind === "check" || p.kind === "evidence");
	const waiting = all.filter(p => p.kind === "running");
	const hard = [...staged, ...verdicts];
	if (hard.length === 0 && waiting.length === 0) {
		mark(settled);
		return { block: false, outcomes, streak: undefined, notices };
	}
	const letThrough = (why: NoticeText): Decision => {
		mark(r => (r.problems.length ? "unsatisfied" : settled(r)));
		const left = [...hard, ...waiting].map(describe).join("; ");
		notices.push(say({ en: `done-gate: ${why.en}; letting the session finish with it (${left}).`, ko: `done-gate: ${why.ko}. 이 상태 그대로 세션을 끝내도록 허용합니다(${left}).` }));
		return { block: false, outcomes, streak: undefined, notices };
	};
	const reasonOf = (problems: readonly Problem[], closing: string) => `${problems.map(p => p.text).join("\n\n")}\n\n${closing}`;
	if (hard.length > 0 && memory.refusals >= MAX_REFUSALS) return letThrough({ en: `this run was refused ${MAX_REFUSALS} times`, ko: `이번 실행에서 ${MAX_REFUSALS}번 거절했습니다` });
	if (waiting.length > 0) {
		if (hard.length === 0 && memory.waits >= MAX_WAITS) return letThrough({ en: `this run was refused ${MAX_WAITS} times only because a check was still running`, ko: `이번 실행에서 검사가 아직 실행 중이라는 이유만으로 ${MAX_WAITS}번 거절했습니다` });
		mark(r => (r.problems.some(p => p.kind !== "running") ? "blocked" : r.problems.length ? "running" : settled(r)));
		return { block: true, running: hard.length === 0, reason: reasonOf([...staged, ...waiting, ...verdicts], hard.length ? CLOSING : WAIT_CLOSING), outcomes, streak: memory.streak, notices };
	}
	const signature = createHash("sha256").update(hard.map(p => `${p.repo}|${p.kind}|${p.name}|${p.state}`).sort().join("\n")).digest("hex");
	if (memory.streak?.signature === signature && memory.streak.blocks >= MAX_BLOCKS) return letThrough({ en: `the same unsatisfied state was refused ${MAX_BLOCKS} times`, ko: `같은 미충족 상태를 ${MAX_BLOCKS}번 거절했습니다` });
	mark(r => (r.problems.length ? "blocked" : settled(r)));
	return { block: true, running: false, reason: reasonOf(hard, CLOSING), outcomes, streak: { signature, blocks: memory.streak?.signature === signature ? memory.streak.blocks + 1 : 1 }, notices };
}

/** The decision for a stop the user waived with /gate-ok: allowed, every repo logged as user-waived, and whatever the stages found named in a notice. */
export function waivedStop(results: readonly RepoResult[], reason: string): Decision {
	const outcomes: Record<string, Outcome> = {};
	for (const r of results) outcomes[r.repo] = "user-waived";
	const carried = results.flatMap(r => r.problems).sort((a, b) => stageRank(a) - stageRank(b));
	const names = carried.map(describe).join("; ");
	const en = `done-gate: /gate-ok let this stop through (${reason})${carried.length ? `; it carried ${names}` : ""}.`;
	const ko = `done-gate: /gate-ok로 이 종료를 허용했습니다(${reason})${carried.length ? `. 이 종료에는 ${names}이(가) 남아 있었습니다` : ""}.`;
	return { block: false, outcomes, streak: undefined, notices: [say({ en, ko })] };
}
