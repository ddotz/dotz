interface Fence {
	char: string;
	size: number;
}

const MAX_LINE_CHARS = 100;
/** Stands in for an inline code span once it is masked out of a line. */
export const CODE_SPAN = "\uFFFC";
const FENCE_START = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_END = /^\s*(`{3,}|~{3,})\s*$/;
/** Matches an inline code span, backticks included. */
export const INLINE_CODE = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g;
const QUOTED = /"[^"\n]*"|\u201C[^\u201D\n]*\u201D|(?<!\w)'[^'\n]*'(?!\w)/g;
const HEADING = /^#{1,6} /;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
const BOLD = /(?<=^|[\s([{"'])\*\*(?![\s/])((?:[^*]|\*(?!\*))*?[^\s*\\/])\*\*\*?(?=$|[\s가-힣)\]}"']|[.,;:!?](?:$|[\s.,;:!?)\]}"'가-힣]))/g;
/** `line` with every inline code span and every quoted phrase (`"..."`, `'...'`, curly double quotes) replaced by `CODE_SPAN`, so what is cited is not read as what the line says. */
export function withoutQuoted(line: string): string {
	return line.replace(INLINE_CODE, CODE_SPAN).replace(QUOTED, CODE_SPAN);
}
/** Matches a line indented 4 spaces or a tab, which is code. */
export const CODE_LINE = /^(?: {4}|\t)/;

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

/** `line` trimmed and cut to 100 characters, with `...` after a cut. */
export function shortened(line: string): string {
	const text = line.trim();
	const chars = [...text];
	return chars.length > MAX_LINE_CHARS ? `${chars.slice(0, MAX_LINE_CHARS).join("")}...` : text;
}

function unmarked(line: string, table: boolean): string {
	const spans: string[] = [];
	const masked = line.replace(INLINE_CODE, span => {
		spans.push(span);
		return CODE_SPAN;
	});
	const body = table
		? `- ${masked
				.trim()
				.replace(/^\||\|$/g, "")
				.split(/(?<!\\)\|/)
				.map(cell => cell.trim().replace(/\\\|/g, "|"))
				.join(" - ")}`
		: masked.replace(HEADING, "");
	let at = 0;
	return body.replace(BOLD, (whole: string, inner: string) => (whole.endsWith("***") && inner.startsWith("*") ? inner.slice(1) : inner)).replace(new RegExp(CODE_SPAN, "g"), () => spans[at++] ?? CODE_SPAN);
}

/**
 * `reply` as the terminal should show it, or undefined when it needs no change: outside fenced code blocks (``` or ~~~) and not
 * on a line indented 4 spaces or a tab, `**x**` becomes `x`, a heading line (`#` to `######` and a space) keeps only its text,
 * and a table (a `|` row followed by a `|---|` separator row, and the `|` rows after it) becomes `-` bullet lines with the cells
 * joined by ` - `, its separator row dropped. Inline code spans are left as they are.
 */
export function stripMarkdown(reply: string): string | undefined {
	const raw = reply.split("\n");
	const lines = outsideFences(reply);
	const tables = tableRows(lines);
	const shown: string[] = [];
	lines.forEach((line, at) => {
		if (line === undefined || CODE_LINE.test(line)) return void shown.push(raw[at]);
		if (tables.has(at)) {
			if (!TABLE_SEPARATOR.test(line)) shown.push(unmarked(line, true));
			return;
		}
		const plain = unmarked(line, false);
		shown.push(plain === line ? raw[at] : plain);
	});
	const result = shown.join("\n");
	return result === reply ? undefined : result;
}
