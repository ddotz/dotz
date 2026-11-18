import { isProtocolAnswer } from "./report.ts";
import type { Finding } from "./types.ts";

type Kind = "bold" | "heading" | "table";

interface Fence {
	char: string;
	size: number;
}

const MAX_LISTED = 5;
const MAX_LINE_CHARS = 100;
/** Stands in for an inline code span once it is masked out of a line. */
export const CODE_SPAN = "\uFFFC";
const FENCE_START = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_END = /^\s*(`{3,}|~{3,})\s*$/;
/** Matches an inline code span, backticks included. */
export const INLINE_CODE = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g;
const HEADING = /^#{1,6} /;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
const BOLD = /(?<=^|[\s([{"'])\*\*(?![\s/])(?:[^*]|\*(?!\*))*?[^\s*\\/]\*\*\*?(?=$|[\s가-힣)\]}"']|[.,;:!?](?:$|[\s.,;:!?)\]}"'가-힣]))/;
/** Matches a line indented 4 spaces or a tab, which is code. */
export const CODE_LINE = /^(?: {4}|\t)/;
const INTRO = "Your last reply has markdown, and the terminal shows raw text: plain prose and `-` bullets only, no **bold**, # headings or | tables. Offending lines:";
const OUTRO = "Write the reply again in plain prose and `-` bullets; real code and commands may be indented or in a fenced block.";

/** The lines of `reply` in order, with `undefined` for every line inside or on the edge of a fenced code block (``` or ~~~). */
export function outsideFences(reply: string): (string | undefined)[] {
	const lines: (string | undefined)[] = [];
	let fence: Fence | undefined;
	for (const raw of reply.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (fence === undefined) {
			const start = FENCE_START.exec(line);
			if (start === null || (start[1].startsWith("`") && start[2].includes("`"))) {
				lines.push(line);
				continue;
			}
			fence = { char: start[1][0], size: start[1].length };
		} else {
			const end = FENCE_END.exec(line)?.[1];
			if (end !== undefined && end.startsWith(fence.char) && end.length >= fence.size) fence = undefined;
		}
		lines.push(undefined);
	}
	return lines;
}

const isTableRow = (line: string | undefined): line is string => line !== undefined && !CODE_LINE.test(line) && TABLE_ROW.test(line);

function tableRows(lines: readonly (string | undefined)[]): Set<number> {
	const rows = new Set<number>();
	lines.forEach((line, at) => {
		const header = lines[at - 1];
		if (line === undefined || CODE_LINE.test(line) || !TABLE_SEPARATOR.test(line) || !isTableRow(header) || TABLE_SEPARATOR.test(header)) return;
		let last = at;
		while (isTableRow(lines[last + 1])) last += 1;
		for (let row = at - 1; row <= last; row++) rows.add(row);
	});
	return rows;
}

function kindOf(line: string, inTable: boolean): Kind | undefined {
	if (inTable) return "table";
	if (HEADING.test(line)) return "heading";
	return BOLD.test(line.replace(INLINE_CODE, CODE_SPAN)) ? "bold" : undefined;
}

/** `line` trimmed and cut to 100 characters, with `...` after a cut. */
export function shortened(line: string): string {
	const text = line.trim();
	const chars = [...text];
	return chars.length > MAX_LINE_CHARS ? `${chars.slice(0, MAX_LINE_CHARS).join("")}...` : text;
}

/**
 * What a reply shows as raw characters in a terminal: one `plain` finding per line, in line order, outside fenced code blocks
 * (``` or ~~~) and not indented 4 spaces or a tab (indented lines are code), that has `**bold**` (it opens at the line start or after whitespace or `([{"'` and closes before the line end, whitespace or closing punctuation; inline code is not looked into, and `2 ** 3`, `(a+b)**2`, `f(**opts)` and globs such as `src/**` or `**.bak,**.tmp` are not bold), a
 * markdown heading (`#` to `######` at the start of the line, followed by a space), or is part of a table (a `|` row followed by a
 * `|---|` separator row, and the `|` rows after it); the finding's class is `bold`, `heading` or `table`, its `line` the 1-based
 * line of the reply and its `text` the line, cut to 100 characters. Empty for an undefined reply, a protocol answer (`ok`, `-`, `[later]`) or one in plain prose.
 */
export function plainTextFindings(reply: string | undefined): Finding[] {
	if (reply === undefined || isProtocolAnswer(reply)) return [];
	const lines = outsideFences(reply);
	const tables = tableRows(lines);
	return lines.flatMap((line, at): Finding[] => {
		if (line === undefined || CODE_LINE.test(line)) return [];
		const kind = kindOf(line, tables.has(at));
		if (kind === undefined) return [];
		const text = shortened(line);
		return [{ stage: "plain", class: kind, message: `reply line ${at + 1} (${kind}): ${text}`, line: at + 1, text }];
	});
}

/** The refusal text for `findings` of the `plain` stage: that the terminal shows raw text, up to 5 of the offending lines with their line numbers and how many more there are, and what to write instead. */
export function plainTextRefusal(findings: readonly Finding[]): string {
	const rows = findings.slice(0, MAX_LISTED).map(finding => finding.message);
	if (findings.length > MAX_LISTED) rows.push(`... and ${findings.length - MAX_LISTED} more`);
	return [INTRO, ...rows, OUTRO].join("\n");
}

/** What the user is told when a stop lets through a reply that still has markdown because the run already refused one: the first offending line and how many others there are. */
export function plainTextWarning(findings: readonly Finding[]): string {
	const others = findings.length - 1;
	const first = findings.at(0)?.message ?? "";
	return `done-gate: the last reply still has markdown the terminal shows as raw text, starting at ${first}${others > 0 ? ` (${others} more line${others === 1 ? "" : "s"})` : ""}; this run already refused a reply for it, so the stop is allowed.`;
}
