import { createHash } from "node:crypto";
import type { Problem } from "./decision.ts";
import { askRefusal } from "./ask.ts";
import { formatFindings } from "./escape.ts";
import { leftoverRefusal } from "./leftover.ts";
import type { Finding } from "./types.ts";

/** The stages that produce findings; the order is the order their findings appear in a refusal. */
export const STAGES = ["escape", "rules", "defaults", "mistakes", "verify", "ask", "leftover", "report"] as const;

export type StageName = (typeof STAGES)[number];

const MAX_ROWS = 20;
const WEAKENED_GATE = "weakened-gate";

const HEADERS: Record<StageName, (repo: string) => string | undefined> = {
	escape: repo => `done-gate: lines this session added in ${repo} are refused.`,
	rules: repo => `done-gate: the project rules in ${repo} found violations.`,
	defaults: repo => `done-gate: the default rules found violations in what this session changed in ${repo}.`,
	mistakes: () => undefined,
	verify: () => undefined,
	ask: () => undefined,
	leftover: () => undefined,
	report: () => undefined,
};

function rowOf(finding: Finding): string {
	const where = finding.file === undefined ? "" : `${finding.file}${finding.line === undefined ? "" : `:${finding.line}`} `;
	return `${where}[${finding.class}] ${finding.message}${finding.text === undefined ? "" : `\n${finding.text}`}`;
}

function bodyOf(stage: StageName, findings: readonly Finding[]): string {
	if (stage === "escape") return formatFindings([...findings]);
	if (stage === "ask") return askRefusal(findings);
	if (stage === "leftover") return leftoverRefusal(findings);
	if (stage === "mistakes" || stage === "verify" || stage === "report") return findings.map(finding => finding.message).join("\n\n");
	const rows = findings.slice(0, MAX_ROWS).map(rowOf);
	if (findings.length > MAX_ROWS) rows.push(`... and ${findings.length - MAX_ROWS} more`);
	return rows.join("\n");
}

function stateOf(findings: readonly Finding[]): string {
	const rows = findings.map(finding => [finding.class, finding.file ?? "", finding.text ?? finding.message].join("|")).sort();
	return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16);
}

function labelsOf(stage: StageName, findings: readonly Finding[]): string[] {
	const classes = [...new Set(findings.map(finding => finding.class))];
	return classes.map(name => {
		const files = name === WEAKENED_GATE ? [...new Set(findings.filter(finding => finding.class === name).flatMap(finding => (finding.file === undefined ? [] : [finding.file])))] : [];
		return `${stage}:${name}${files.length ? ` (${files.join(", ")})` : ""}`;
	});
}

/**
 * One refusal item for what a stage found in a repo (or, for the mistakes stage, in the session), or undefined when it found
 * nothing. Its state ignores line numbers, so the same finding moved to another line is still the same finding.
 */
export function findingProblem(repo: string, stage: StageName, findings: readonly Finding[]): Problem | undefined {
	if (findings.length === 0) return undefined;
	const classes: Record<string, number> = {};
	for (const finding of findings) {
		const key = `${stage}:${finding.class}`;
		classes[key] = (classes[key] ?? 0) + 1;
	}
	const header = HEADERS[stage](repo);
	return {
		kind: "finding",
		repo,
		name: stage,
		state: stateOf(findings),
		text: [header, bodyOf(stage, findings)].filter(part => part !== undefined).join("\n"),
		classes,
		label: labelsOf(stage, findings).join(", "),
	};
}

/** How many findings and problems of each `stage:class` a stop had, summed over its refusal items. */
export function countClasses(problems: readonly Problem[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const problem of problems) for (const [key, count] of Object.entries(problem.classes)) counts[key] = (counts[key] ?? 0) + count;
	return counts;
}
