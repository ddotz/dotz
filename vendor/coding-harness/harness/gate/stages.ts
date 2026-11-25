import { existsSync } from "node:fs";
import { join } from "node:path";
import { harnessDir } from "../agent-home.ts";
import { stageBudgetMs, until } from "./deadline.ts";
import { escapeScan } from "./escape.ts";
import type { AcceptedComment, EscapeScan } from "./escape.ts";
import { formsScan } from "./forms.ts";
import type { FormsInput } from "./forms.ts";
import { mistakeFindings } from "./mistakes.ts";
import { rulesScan } from "./rules.ts";
import { AST_GREP } from "./types.ts";
import type { EscapeInput, Finding, Preexisting, RulesInput, RulesScan, TextAt } from "./types.ts";
import { message } from "./util.ts";

/** The finding producers of a stop and of the edit feedback, with the ast-grep binary the scans need; tests replace them to make a stage throw or hang. */
export interface Stages {
	escape(input: EscapeInput): Promise<EscapeScan>;
	rules(input: RulesInput): Promise<RulesScan>;
	forms(input: FormsInput): Promise<Finding[]>;
	mistakes(sessionId: string): Finding[];
	astGrep: string;
}

export const realStages: Stages = { escape: escapeScan, rules: rulesScan, forms: formsScan, mistakes: mistakeFindings, astGrep: AST_GREP };

/** What the stages found in one repo, the why comments the anti-escape stage accepted, what they could not judge (the files the anti-escape stage could not read, the rule occurrences outside the session's changes), the errors of the stages that could not say, and whether the anti-escape stage itself threw in this call (`escapeFailed`; a stage that only outlasted its budget did not), which the stop remembers for the input it threw on. */
export interface StageRun {
	escape: Finding[];
	accepted: AcceptedComment[];
	unscanned: string[];
	rules: Finding[];
	defaults: Finding[];
	preexisting: Preexisting[];
	errors: string[];
	escapeFailed: boolean;
}

/** What the stages of one repo are given: the files the session changed, the tool-written ones among them, the commit and base texts the lines are measured from, and the accepted text of the gate files. */
export interface StageInput {
	repo: string;
	base: string;
	files: string[];
	baseText?: TextAt;
	toolEdited?: ReadonlySet<string>;
	acceptedText?: TextAt;
	skipEscape?: string;
}

/** What one stage found in one place, or the error that kept it from saying. */
export interface StageFindings<T = Finding[]> {
	findings: T;
	error?: string;
	/** The stage threw, as opposed to being cancelled or outlasting its budget. */
	threw?: true;
}

const NO_SCAN: EscapeScan = { findings: [], accepted: [], unscanned: [] };
const NO_RULES: RulesScan = { findings: [], preexisting: [] };
const NO_RULES_RUN: StageFindings<RulesScan> = { findings: NO_RULES };

/** A stage run that found nothing and had no error. */
export const NO_STAGE_FINDINGS: StageRun = { escape: [], accepted: [], unscanned: [], rules: [], defaults: [], preexisting: [], errors: [], escapeFailed: false };

function skipped(error: string): StageFindings<EscapeScan> {
	return { findings: NO_SCAN, error };
}

async function limited<T>(stage: string, repo: string, empty: T, parent: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<StageFindings<T>> {
	const budget = stageBudgetMs();
	const controller = new AbortController();
	const cancel = () => controller.abort();
	parent.addEventListener("abort", cancel, { once: true });
	try {
		if (parent.aborted) return { findings: empty, error: `the ${stage} stage in ${repo} was cancelled with the stop` };
		const done = await until(work(controller.signal), AbortSignal.timeout(budget));
		return done ? { findings: done.value } : { findings: empty, error: `the ${stage} stage in ${repo} took longer than ${budget / 1000} s and was not waited for; what it would have found is unknown` };
	} catch (error) {
		return { findings: empty, error: `the ${stage} stage in ${repo} failed: ${message(error)}`, threw: true };
	} finally {
		parent.removeEventListener("abort", cancel);
		controller.abort();
	}
}

/** Whether `repo` has a project rule kit (`.omp/lint/sgconfig.yml`), so its rules stage runs. */
export function hasRuleKit(repo: string): boolean {
	return existsSync(join(repo, ".omp", "lint", "sgconfig.yml"));
}

/**
 * Runs the anti-escape stage, the default scans (swallowed errors and `any`), and the rules stage when the repo has
 * `.omp/lint/sgconfig.yml`, side by side; what the default scans find is the defaults stage. A stage that throws or outlasts its share of the stop budget
 * becomes an error and finds nothing; a missing ast-grep binary is one error for all of them.
 * With `input.skipEscape`, the anti-escape stage is not run and that text is its error.
 * Each stage call gets its own `signal`, which fires when the stage finishes, when its budget runs out or when `parent` aborts, so
 * nothing a stage spawned outlives the call. Never rejects.
 */
export async function runStages(stages: Stages, input: StageInput, parent: AbortSignal): Promise<StageRun> {
	const { repo, files } = input;
	if (!existsSync(stages.astGrep)) {
		return { ...NO_STAGE_FINDINGS, errors: [`ast-grep is missing (${stages.astGrep}), so the anti-escape and rules stages did not run; run \`cd "${harnessDir()}" && bun install\` to restore it`] };
	}
	const lint = hasRuleKit(repo);
	const scanned = { repo, base: input.base, files, baseText: input.baseText, toolEdited: input.toolEdited };
	const [escape, rules, forms] = await Promise.all([
		input.skipEscape === undefined ? limited("escape", repo, NO_SCAN, parent, signal => stages.escape({ ...input, signal })) : skipped(input.skipEscape),
		lint ? limited("rules", repo, NO_RULES, parent, signal => stages.rules({ repo, files, signal })) : NO_RULES_RUN,
		limited<Finding[]>("forms", repo, [], parent, signal => stages.forms({ ...scanned, signal })),
	]);
	return {
		escape: escape.findings.findings,
		accepted: escape.findings.accepted,
		unscanned: escape.findings.unscanned,
		rules: rules.findings.findings,
		defaults: forms.findings,
		preexisting: rules.findings.preexisting,
		errors: [escape.error, rules.error, forms.error].filter(error => error !== undefined),
		escapeFailed: escape.threw === true && !parent.aborted,
	};
}

/** What the session's unresolved mistakes come to, or the error of the stage when it threw. */
export function mistakeStage(stages: Stages, sessionId: string): StageFindings {
	try {
		return { findings: stages.mistakes(sessionId) };
	} catch (error) {
		return { findings: [], error: `the mistakes stage failed: ${message(error)}` };
	}
}
