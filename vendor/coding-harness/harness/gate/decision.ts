import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { type NoticeText, say } from "../notice.ts";
import type { AcceptedComment } from "./escape.ts";
import { gateFilePath, matchesAny, readGateFile } from "./gate-file.ts";
import { readPassed } from "./log.ts";
import { fingerprint, git, takeSnapshot } from "./snapshot.ts";
import type { Finding, Preexisting } from "./types.ts";
import { isRecord, message } from "./util.ts";

/** The same unsatisfied state is refused this many times in a row before the stop passes as unsatisfied. */
export const MAX_BLOCKS = 3;

/** One run, from prompt to allowed stop, is refused this many times in total for failures, findings and missing evidence, whatever those were. */
export const MAX_REFUSALS = 8;

/** One run is refused this many times in total only because a check is still running; every check is bounded by its own `timeoutSec`, which counts as a failure, so waiting needs only a loose cap. */
export const MAX_WAITS = 30;

/** What a refusal for work ends with, and a check's failure that arrives after a stop: fix the cause and finish again, and make the reply after the fix the final report, since that reply is what the user reads. */
export const CLOSING = "Fix the cause and finish again; do not edit the gate file or the check to get through. The reply you write after the fix is what the user reads, so write it as the final report.";
const WAIT_CLOSING = "Finish again to wait for it: each stop waits for the check and the next one collects its result. End this turn with one short line, not a report; once the check is in, the gate asks for the final report.";
const STAGE_ORDER: readonly string[] = ["escape", "rules", "defaults", "mistakes", "verify", "ask", "leftover", "report"];

/** What a stop came to for one repo. `running` is a refusal made only to wait for a check; `deferred` is a stop an interactive session was let through while a check of the repo was still running, whose result arrives when the check ends. */
export type Outcome = "clean" | "pass" | "blocked" | "fixed" | "waived" | "user-waived" | "unsatisfied" | "no-gate" | "error" | "running" | "deferred";
const LANDABLE: Record<Outcome, boolean> = { clean: true, pass: true, fixed: true, waived: true, "no-gate": true, "user-waived": true, blocked: false, unsatisfied: false, error: false, running: false, deferred: false };
const LET_THROUGH: unique symbol = Symbol("let-through");

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
 * counts towards the refusal total, and one that has findings or failures next to a running check counts them towards the same-state
 * streak too, taken from the findings and failures alone. A refusal lists what the stages found first (escape, rules, mistakes), then a running
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
	const signature = createHash("sha256").update(hard.map(p => `${p.repo}|${p.kind}|${p.name}|${p.state}`).sort().join("\n")).digest("hex");
	const repeated = hard.length > 0 && memory.streak?.signature === signature ? memory.streak : undefined;
	if (hard.length > 0 && memory.refusals >= MAX_REFUSALS) return letThrough({ en: `this run was refused ${MAX_REFUSALS} times`, ko: `이번 실행에서 ${MAX_REFUSALS}번 거절했습니다` });
	if (repeated !== undefined && repeated.blocks >= MAX_BLOCKS) return letThrough({ en: `the same unsatisfied state was refused ${MAX_BLOCKS} times`, ko: `같은 미충족 상태를 ${MAX_BLOCKS}번 거절했습니다` });
	const streak: Streak | undefined = hard.length === 0 ? memory.streak : { signature, blocks: (repeated?.blocks ?? 0) + 1 };
	if (waiting.length > 0) {
		if (hard.length === 0 && memory.waits >= MAX_WAITS) return letThrough({ en: `this run was refused ${MAX_WAITS} times only because a check was still running`, ko: `이번 실행에서 검사가 아직 실행 중이라는 이유만으로 ${MAX_WAITS}번 거절했습니다` });
		mark(r => (r.problems.some(p => p.kind !== "running") ? "blocked" : r.problems.length ? "running" : settled(r)));
		return { block: true, running: hard.length === 0, reason: reasonOf([...staged, ...waiting, ...verdicts], hard.length ? CLOSING : WAIT_CLOSING), outcomes, streak, notices };
	}
	mark(r => (r.problems.length ? "blocked" : settled(r)));
	return { block: true, running: false, reason: reasonOf(hard, CLOSING), outcomes, streak, notices };
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

/** The gate's leave to land the commits of slot repo `repo` on its folder. Only `canLand` makes one, and `landSlot` takes nothing else. */
export interface LetThrough {
	readonly repo: string;
	readonly [LET_THROUGH]: true;
}

/**
 * What `canLand` judges for one slot repo: its path and its folder's, whether the stop is refused, the repo's outcome when the gate judged it at this stop, whether the user waived the stop with /gate-ok,
 * what the stages found in the diff its landing brings (`unlandedDiff`), and the errors that kept them from judging that diff (`unjudged`).
 */
export interface LandAsk {
	readonly repo: string;
	readonly folder: string;
	readonly refused: boolean;
	readonly outcome: Outcome | undefined;
	readonly userWaived: boolean;
	readonly findings: readonly Finding[];
	readonly unjudged: readonly string[];
}

/** A `LetThrough`, or why there is none; `found` when what the stages found in the unlanded commits is why. */
export type LandLeave = { readonly ok: true; readonly verdict: LetThrough } | { readonly ok: false; readonly why: string } | { readonly ok: false; readonly why: string; readonly found: readonly [Finding, ...Finding[]] };

/** Whether a stop whose outcome for a slot repo is `outcome` (undefined: the stop did not judge it) can let it land. */
export function isLandable(outcome: Outcome | undefined): boolean {
	return outcome === undefined || LANDABLE[outcome];
}

/** Why the stages keep a slot's unlanded commits from landing: each `stage:class` they found with its file, else the errors that kept them from judging; undefined when neither. */
export function unlandedWhy(judged: Pick<LandAsk, "findings" | "unjudged">): string | undefined {
	if (judged.findings.length > 0) return `its unlanded commits carry what the stages refuse: ${[...new Set(judged.findings.map(finding => `${finding.stage}:${finding.class}${finding.file === undefined ? "" : ` in ${finding.file}`}`))].join("; ")}`;
	if (judged.unjudged.length > 0) return `the stages could not judge its unlanded commits (${judged.unjudged.join("; ")})`;
	return undefined;
}

async function hasCommit(repo: string, commit: string, signal: AbortSignal): Promise<boolean> {
	try {
		await git(repo, ["cat-file", "-e", `${commit}^{commit}`], signal);
		return true;
	} catch (error) {
		if (isRecord(error) && typeof error.code === "number") return false;
		throw error;
	}
}

/**
 * Where the landing of slot `repo` on its folder `folder` starts, `base`: the merge base of the folder's HEAD and the slot's HEAD, which is the folder's HEAD
 * when the slot is based on it; and `files`, what the slot's commits change since. Undefined when the folder has no HEAD commit git can read (a new folder,
 * an orphan branch) or the slot does not have that commit: its diff cannot be taken, and `landSlot` lands nothing for it.
 */
export async function unlandedDiff(repo: string, folder: string, signal: AbortSignal): Promise<{ base: string; files: string[] } | undefined> {
	let folderHead: string;
	try {
		folderHead = (await git(folder, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
	} catch (error) {
		if (isRecord(error) && typeof error.code === "number") return undefined;
		throw error;
	}
	if (!(await hasCommit(repo, folderHead, signal))) return undefined;
	const base = (await git(repo, ["merge-base", folderHead, "HEAD"], signal)).trim();
	return { base, files: (await git(repo, ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"], signal)).split("\0").filter(Boolean) };
}

/** The files the commits of slot `repo` change against its folder `folder` (`unlandedDiff`); none when that diff cannot be taken. */
export async function unlandedFiles(repo: string, folder: string, signal: AbortSignal): Promise<string[]> {
	return (await unlandedDiff(repo, folder, signal))?.files ?? [];
}

async function hiddenFiles(repo: string, signal: AbortSignal): Promise<string[]> {
	return (await git(repo, ["ls-files", "-v", "-z"], signal))
		.split("\0")
		.filter(entry => /^[Sa-z] /.test(entry))
		.map(entry => entry.slice(2));
}

/**
 * The one place that lets a slot's commits land. It gives a `LetThrough` for `ask.repo` only when the stop is not refused, the repo's
 * outcome at this stop, when the gate judged it, is clean, pass, fixed, waived, no-gate or user-waived, the stages found nothing in its
 * unlanded commits and nothing kept them from judging those (`ask.findings`, `ask.unjudged`), and, unless the user waived the
 * stop, every check of the gate file (none without one) whose paths match a file of `unlandedFiles` has a recorded pass with
 * the same command and the fingerprint of the slot's current tree. So commits an earlier refused or given-up stop left behind land only
 * once a check covers them and the stages pass them. Since checks and stages judge the working tree and only commits land, it gives no
 * leave either, with or without a gate file, while a tracked change or an untracked file is one of those committed files or lies under
 * the paths of a check they touch, or while such a file is hidden from `git status` (skip-worktree, assume-unchanged) and so cannot be
 * told from a clean one; uncommitted files elsewhere stay behind and do not stop it. Never throws.
 */
export async function canLand(ask: LandAsk, signal: AbortSignal): Promise<LandLeave> {
	if (ask.refused) return { ok: false, why: "the stop was refused" };
	if (ask.outcome !== undefined && !LANDABLE[ask.outcome]) return { ok: false, why: `the gate's outcome for it was ${ask.outcome}` };
	const staged = unlandedWhy(ask);
	const [first, ...rest] = ask.findings;
	if (staged !== undefined) return first === undefined ? { ok: false, why: staged } : { ok: false, why: staged, found: [first, ...rest] };
	const verdict: LetThrough = { repo: ask.repo, [LET_THROUGH]: true };
	if (ask.userWaived) return { ok: true, verdict };
	try {
		const checks = existsSync(gateFilePath(ask.repo)) ? readGateFile(ask.repo).checks : [];
		const files = await unlandedFiles(ask.repo, ask.folder, signal);
		const now = await takeSnapshot(ask.repo, signal);
		const touched = checks.filter(check => files.some(file => matchesAny(check.paths, file)));
		const judgedOnly = Object.keys(now.dirty)
			.filter(file => files.includes(file) || touched.some(check => matchesAny(check.paths, file)))
			.sort();
		if (judgedOnly.length > 0) return { ok: false, why: `${judgedOnly.join(", ")} ${judgedOnly.length === 1 ? "is" : "are"} uncommitted among the files its commits change or under the paths of their checks; the gate judged the working tree, but only commits land, so commit or stash ${judgedOnly.length === 1 ? "it" : "them"} and finish again` };
		const hidden = (await hiddenFiles(ask.repo, signal)).filter(file => files.includes(file) || touched.some(check => matchesAny(check.paths, file))).sort();
		if (hidden.length > 0) return { ok: false, why: `${hidden.join(", ")} ${hidden.length === 1 ? "is" : "are"} hidden from git status (skip-worktree or assume-unchanged), so what the gate judged cannot be told from what would land; run \`git update-index --no-skip-worktree --no-assume-unchanged\` on ${hidden.length === 1 ? "it" : "them"} and finish again` };
		const passed = readPassed(ask.repo);
		const uncovered = touched.filter(check => {
			const known = passed[check.name];
			return known?.command !== check.command || known.fingerprint !== fingerprint(now.tree, now.dirty, check.paths);
		});
		if (uncovered.length === 0) return { ok: true, verdict };
		return { ok: false, why: `no pass of ${uncovered.map(check => `"${check.name}"`).join(", ")} is recorded for its current tree` };
	} catch (error) {
		return { ok: false, why: `what its commits change could not be checked: ${message(error)}` };
	}
}
