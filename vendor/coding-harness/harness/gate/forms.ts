import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { baseTextOf, propertyOf, run, runAll, shortened } from "./escape-common.ts";
import { hasGeneratedMarker, isTestFile, SKIPPED_SEGMENTS } from "./escape.ts";
import { AST_GREP, type Finding, type TextAt } from "./types.ts";

/** What the forms scan is given. Paths are repo-relative. */
export interface FormsInput {
	repo: string;
	/** Commit the run started from; the fallback source of a file's base text. */
	base: string;
	/** Files the session changed. */
	files: string[];
	/** Text of a file at the session's base point. Absent or `undefined` result: `git show <base>:<file>`; a file that is not there has no base text. */
	baseText?: TextAt;
	/** Files written by the edit, write or ast_edit tools in this run. A file the anti-escape stage skips as generated or vendored is skipped here too, unless it is in this set. Absent: every file counts as tool-edited. */
	toolEdited?: ReadonlySet<string>;
	/** Aborting it ends the scan: child processes are killed and the call rejects. */
	signal?: AbortSignal;
}

type FormClass = "swallowed-error" | "type-escape";

interface FormRule {
	id: string;
	class: FormClass;
	rule: object;
	utils?: Record<string, object>;
}

interface Target {
	file: string;
	grammar: string;
	checksTypes: boolean;
}

interface Hit {
	cls: FormClass;
	line: number;
}

interface Placed {
	line: number;
	text: string;
	fresh: boolean;
}

interface Scan {
	hits: Hit[];
	broken: boolean;
}

interface Row {
	file: string;
	cls: FormClass;
	before: number;
	now: Placed[];
}

const CLASSES: readonly FormClass[] = ["swallowed-error", "type-escape"];
const AST_GREP_SUPPRESSION = Buffer.from("ast-grep-ignore");
const AST_GREP_TIMEOUT_MS = 30_000;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const SCAN_CONCURRENCY = 8;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const CONFLICT_MARKER = /^(?:<{7} |={7}\r?$|>{7} )/m;
const PARSE_RULE_ID = "parse-error";

const MESSAGES: Record<FormClass, string> = {
	"swallowed-error": "An error is caught and dropped here. Handle it, let it propagate, or catch only the case you expect and rethrow the rest.",
	"type-escape": "`any` switches the type checker off for this value. Type it; for data from outside use `unknown` and narrow it; for a library with wrong types, fix the declaration.",
};

const GRAMMARS: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
};

const nonComment = (position: number): object => ({ nthChild: { position, ofRule: { not: { kind: "comment" } } } });
const HOLDS_STATEMENT = { has: nonComment(1) };
const EMPTY_BLOCK = { kind: "statement_block", not: HOLDS_STATEMENT };
const NOTHING_VALUE = { any: [{ kind: "undefined" }, { kind: "null" }, { pattern: "void 0" }, { kind: "parenthesized_expression", has: { matches: "nothing-value" } }] };
const EMPTY_CALLBACK = {
	any: [
		{ kind: "arrow_function", has: { field: "body", ...EMPTY_BLOCK } },
		{ kind: "function_expression", has: { field: "body", ...EMPTY_BLOCK } },
		{ kind: "arrow_function", has: { field: "body", matches: "nothing-value" } },
		{ kind: "parenthesized_expression", has: { matches: "empty-callback" } },
	],
};
const CALLBACK_UTILS = { "nothing-value": NOTHING_VALUE, "empty-callback": EMPTY_CALLBACK };
const ONLY_ARGUMENT_IS_EMPTY_CALLBACK = { kind: "arguments", has: { all: [nonComment(1), { matches: "empty-callback" }] }, not: { has: nonComment(2) } };
const PYTHON_NO_OP = { any: [{ kind: "comment" }, { kind: "pass_statement" }, { kind: "continue_statement" }, { kind: "expression_statement", has: { kind: "ellipsis" } }] };

const SCRIPT_RULES: readonly FormRule[] = [
	{ id: "swallowed-catch-clause", class: "swallowed-error", rule: { kind: "catch_clause", has: { field: "body", ...EMPTY_BLOCK } } },
	{
		id: "swallowed-catch-call",
		class: "swallowed-error",
		rule: { kind: "property_identifier", regex: "^catch$", inside: { kind: "member_expression", inside: { kind: "call_expression", has: { field: "arguments", ...ONLY_ARGUMENT_IS_EMPTY_CALLBACK } } } },
		utils: CALLBACK_UTILS,
	},
];
const TYPE_RULES: readonly FormRule[] = [{ id: "any-type", class: "type-escape", rule: { kind: "predefined_type", regex: "^any$" } }];
const PYTHON_RULES: readonly FormRule[] = [
	{
		id: "swallowed-except-clause",
		class: "swallowed-error",
		rule: { kind: "except_clause", has: { kind: "block", all: [HOLDS_STATEMENT, { not: { has: { nthChild: { position: 1, ofRule: { not: PYTHON_NO_OP } } } } }] } },
	},
];

const CLASS_OF_RULE: Record<string, FormClass> = Object.fromEntries([...SCRIPT_RULES, ...TYPE_RULES, ...PYTHON_RULES].map(rule => [rule.id, rule.class]));

const DECLARATIONS = ["lexical_declaration", "variable_declaration"];

function rulesOf(target: Target): string {
	const rules = target.grammar === "python" ? PYTHON_RULES : [...SCRIPT_RULES, ...(target.checksTypes ? TYPE_RULES : [])];
	const root = target.grammar === "python" ? "module" : "program";
	const empty = target.grammar === "python" ? { regex: "^$", stopBy: "end" } : { regex: "^$", stopBy: "end", not: { inside: { any: DECLARATIONS.map(kind => ({ kind })) } } };
	const unparsed = { id: PARSE_RULE_ID, rule: { any: [{ kind: "ERROR" }, { kind: root, has: empty }] }, utils: undefined };
	return [...rules.map(({ id, rule, utils }) => ({ id, rule, utils })), unparsed].map(doc => JSON.stringify({ ...doc, language: target.grammar, severity: "hint" })).join("\n---\n");
}

function normalizePath(raw: string): string {
	return raw.replaceAll("\\", "/").replace(/^\.\//, "");
}

function defused(bytes: Buffer): Buffer {
	let at = bytes.indexOf(AST_GREP_SUPPRESSION);
	if (at === -1) return bytes;
	const copy = Buffer.from(bytes);
	for (; at !== -1; at = copy.indexOf(AST_GREP_SUPPRESSION, at + 1)) copy[at] ^= 0x20;
	return copy;
}

function targetsOf(input: FormsInput, edited: (file: string) => boolean): Target[] {
	const kept = new Set<string>();
	for (const raw of input.files) {
		const file = normalizePath(raw);
		const segments = file.split("/");
		if (file === "" || file.startsWith("/") || segments.includes("..")) continue;
		if (edited(file) || !segments.some(segment => SKIPPED_SEGMENTS.has(segment))) kept.add(file);
	}
	return [...kept].sort().flatMap(file => {
		const extension = extname(file).slice(1).toLowerCase();
		if (!Object.hasOwn(GRAMMARS, extension)) return [];
		const grammar = GRAMMARS[extension];
		const checksTypes = (grammar === "typescript" || grammar === "tsx") && !isTestFile(file) && !DECLARATION_FILE.test(file.toLowerCase());
		return [{ file, grammar, checksTypes }];
	});
}

function regularFileSize(path: string): number | undefined {
	try {
		if (!readdirSync(dirname(path)).includes(basename(path))) return undefined;
		const stat = lstatSync(path);
		return stat.isFile() ? stat.size : undefined;
	} catch (error) {
		const code = propertyOf(error, "code");
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

function parseHit(line: string): Hit | "broken" | undefined {
	if (!line.startsWith("{")) return undefined;
	const match: unknown = JSON.parse(line);
	const rule = propertyOf(match, "ruleId");
	if (rule === PARSE_RULE_ID) return "broken";
	const row = propertyOf(propertyOf(propertyOf(match, "range"), "start"), "line");
	if (typeof rule !== "string" || typeof row !== "number" || !Object.hasOwn(CLASS_OF_RULE, rule)) return undefined;
	return { cls: CLASS_OF_RULE[rule], line: row + 1 };
}

function mayHold(target: Target, text: string): boolean {
	if (target.grammar === "python") return text.includes("except");
	return text.includes("catch") || (target.checksTypes && text.includes("any"));
}

async function scan(target: Target, text: string, signal: AbortSignal | undefined): Promise<Scan> {
	const args = [AST_GREP, "scan", "--inline-rules", rulesOf(target), "--json=stream", "--stdin"];
	const result = await run(args, tmpdir(), { timeoutMs: AST_GREP_TIMEOUT_MS, signal, stdin: defused(Buffer.from(text)) });
	if (result.code !== 0) throw new Error(`forms: ast-grep failed on ${target.grammar} source (exit ${result.code}): ${result.err.slice(0, 300)}`);
	const parsed = result.out.split("\n").flatMap(line => parseHit(line) ?? []);
	return { hits: parsed.filter(hit => hit !== "broken"), broken: parsed.includes("broken") };
}

async function hitsIn(target: Target, text: string, signal: AbortSignal | undefined): Promise<Hit[]> {
	return mayHold(target, text) ? (await scan(target, text, signal)).hits : [];
}

async function measure(input: FormsInput, target: Target, edited: boolean): Promise<Row[]> {
	const path = join(input.repo, target.file);
	const size = regularFileSize(path);
	if (size !== undefined && size > MAX_SOURCE_BYTES) return [];
	const text = size === undefined ? undefined : readFileSync(path, "utf8");
	const base = await baseTextOf(input, target.file);
	const before = base ?? undefined;
	if (!edited && ((text !== undefined && hasGeneratedMarker(text)) || (before !== undefined && hasGeneratedMarker(before)))) return [];
	if (before === text || (before !== undefined && before.length > MAX_SOURCE_BYTES)) return [];
	if (before !== undefined && CONFLICT_MARKER.test(before)) return [];
	const now = text === undefined ? [] : await hitsIn(target, text, input.signal);
	let was: Hit[] = [];
	if (before !== undefined && (now.length > 0 || mayHold(target, before))) {
		const scanned = await scan(target, before, input.signal);
		if (scanned.broken) return [];
		was = scanned.hits;
	}
	const lines = text?.split("\n") ?? [];
	const known = new Set(now.length > 0 && before !== undefined ? before.split("\n").map(line => line.trim()) : []);
	const placedAt = ({ line }: Hit): Placed => {
		const trimmed = lines[line - 1]?.trim() ?? "";
		return { line, text: trimmed, fresh: !known.has(trimmed) };
	};
	const rows = CLASSES.map(cls => ({
		file: target.file,
		cls,
		before: was.filter(hit => hit.cls === cls).length,
		now: now
			.filter(hit => hit.cls === cls)
			.sort((a, b) => a.line - b.line)
			.map(placedAt),
	}));
	return rows.filter(row => row.before > 0 || row.now.length > 0);
}

function chosen(row: Row, count: number): Placed[] {
	const fresh = row.now.filter(place => place.fresh);
	const carried = row.now.filter(place => !place.fresh).reverse();
	return [...fresh, ...carried].slice(0, count);
}

function ratchet(cls: FormClass, rows: readonly Row[]): Finding[] {
	const mine = rows.filter(row => row.cls === cls);
	const delta = mine.reduce((sum, row) => sum + row.now.length - row.before, 0);
	const findings: Finding[] = [];
	for (const row of mine) {
		const count = Math.min(row.now.length - row.before, delta - findings.length);
		if (count <= 0) continue;
		for (const place of chosen(row, count)) findings.push({ stage: "defaults", class: cls, file: row.file, line: place.line, text: shortened(place.text), message: MESSAGES[cls] });
	}
	return findings;
}

/**
 * The swallowed errors and TypeScript `any` the session's changes added: per class, how many more of them the changed files
 * hold than their base texts did. Forms are found with the ast-grep parser, never by pattern over source text. `swallowed-error`
 * (TypeScript, JavaScript and Python, test files included) is a `catch` clause whose block holds no statement, a `.catch(...)`
 * call whose only argument is a function with an empty block or the body `undefined`, `null` or `void 0` (each possibly wrapped
 * in any number of parentheses), or a Python `except` clause that holds only `pass`, `...` or `continue`; comments are not statements. `type-escape` is a TypeScript type node
 * `any`, in any position, except in test files and declaration files (`.d.ts`, `.d.mts`, `.d.cts`). Per class the total over the changed files (a deleted file
 * counts 0, a file without base text starts from 0) is compared with the total of their base texts; when it rose by `n`, the
 * result holds `n` findings, taken in path order from the files whose own count rose, in each file first the matches whose line
 * does not occur in the base text and then the last ones. Re-indenting, moving or reformatting a form therefore adds nothing.
 * A file the anti-escape stage skips as generated or vendored (by its path, or by a generated banner in its current or its base
 * text) is skipped unless it is in `toolEdited`. A file whose base text does not parse cleanly (the parse tree holds an error
 * or a missing node, or a line starts a merge-conflict marker) is left out on both sides: it neither adds nor offsets. A path
 * counts as absent unless its directory listing holds the exact name, so a case-only rename is a move. A source file over
 * 10 MiB is not read. Aborting `signal` kills every child process and rejects with its reason.
 */
export async function formsScan(input: FormsInput): Promise<Finding[]> {
	input.signal?.throwIfAborted();
	const toolEdited = input.toolEdited === undefined ? undefined : new Set([...input.toolEdited].map(normalizePath));
	const edited = (file: string): boolean => toolEdited === undefined || toolEdited.has(file);
	const measured = await runAll(targetsOf(input, edited), SCAN_CONCURRENCY, input.signal, (target, signal) => measure({ ...input, signal }, target, edited(target.file)));
	input.signal?.throwIfAborted();
	const rows = measured.flat();
	return CLASSES.flatMap(cls => ratchet(cls, rows)).sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "", "en") || (a.line ?? 0) - (b.line ?? 0) || a.class.localeCompare(b.class, "en"));
}
