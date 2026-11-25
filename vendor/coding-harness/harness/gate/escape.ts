import { lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { baseTextOf, git, loweredLimit, propertyOf, type Run, run, runAll, shortened } from "./escape-common.ts";
import { gateFileFindings } from "./escape-gate.ts";
import { AST_GREP, type EscapeInput, type Finding } from "./types.ts";

type EscapeClass = "comment" | "suppression" | "skipped-test";
type NodeRule = "comment" | "literal" | "attribute" | "member";

interface Language {
	grammar: string;
	extensions: readonly string[];
	comments: readonly string[];
	literals: readonly string[];
	attributes: readonly string[];
	memberContainers?: readonly object[];
	isPublic?: (head: string) => boolean;
	isPublicMember?: (head: string) => boolean;
}

interface AstNode {
	rule: NodeRule;
	start: number;
	end: number;
}

interface Source {
	bytes: Uint8Array;
	lineCount: number;
	lineOf(offset: number): number;
	lineBounds(line: number): [number, number];
	text(start: number, end: number): string;
}

interface Comment {
	start: number;
	end: number;
	startLine: number;
	endLine: number;
	text: string;
	standalone: boolean;
	inContainer: boolean;
}

interface RemovedLine {
	file: string;
	text: string;
	used: boolean;
}

interface RemovedPool {
	byText: Map<string, RemovedLine[]>;
	byFile: Map<string, RemovedLine[]>;
}

interface Change {
	added: Set<number>;
	removed: string[];
	removedLines: Set<number>;
}

type CommentVerdict = EscapeClass | "accepted" | undefined;

interface RemovedComments {
	runs: string[];
}

interface FileContext {
	file: string;
	language: Language;
	source: Source;
	maskedBytes: Uint8Array;
	comments: Comment[];
	groups: ReadonlyMap<Comment, Comment[]>;
	skips: Map<number, number>;
	added: ReadonlySet<number>;
	removedLines: ReadonlySet<number>;
	pool: RemovedPool;
	carried: Map<number, boolean>;
	testFile: boolean;
	verdicts: Map<Comment, CommentVerdict>;
	licensed: Map<Comment[], boolean>;
	removedComments?: RemovedComments;
}

type Finder = (masked: string) => Iterable<number>;

interface CodePattern {
	class: "suppression" | "skipped-test";
	grammars: readonly string[];
	callForm: boolean;
	find: Finder;
}

interface Target {
	file: string;
	language: Language;
}

interface Scanned extends Target {
	change: Change;
}

interface Scope {
	files: string[];
	edited(file: string): boolean;
}

interface Unit {
	language: Language;
	files: string[];
	stdin?: Uint8Array;
}

type Measured = { kind: "skipped" } | { kind: "unreadable"; change?: Change } | { kind: "measured"; change: Change };

interface Edits {
	deleted: number[];
	inserted: number[];
}

type Verdicts = Pick<EscapeScan, "findings" | "accepted">;

/** A new comment that was accepted as an outside constraint: where it is and what it says. */
export interface AcceptedComment {
	file: string;
	line: number;
	text: string;
}

/** What the anti-escape scan of a change found: the findings, the why comments it accepted, and the changed source files it could not scan (not UTF-8, over 10 MiB, or past the 32 MiB of changed source one scan reads; DONE_GATE_ESCAPE_MAX_SCAN_BYTES lowers that limit), whose new lines are unchecked. */
export interface EscapeScan {
	findings: Finding[];
	accepted: AcceptedComment[];
	unscanned: string[];
}

const GUIDANCE: Record<EscapeClass, string> = {
	comment:
		"New comment refused. A comment cannot explain or excuse code. If the code needs explaining, rename or extract until it reads on its own. If it marks a workaround, fix the cause. If it records a mistake to avoid, make it a rule with a test (skill://correct). Only a constraint from outside this codebase may stay, written as why(platform|vendor|protocol|spec|legal): <fact> with a reference a reader can check (a URL, an RFC/PEP/ECMA/ISO/CVE id, package@version, owner/repo#issue, or a man page written man <name>(<digit>) or <name>(<digit>) man page). A constraint that comes from this codebase's own code is not one: fix that code.",
	suppression:
		"Suppression refused. Silencing a linter, type checker or coverage tool hides the defect instead of removing it. Fix what the rule reports. If the rule is wrong, change the rule together with its test (skill://correct) instead of suppressing it at the call site.",
	"skipped-test":
		"Skipped test refused. A skipped, focused or todo test keeps the suite green while it stops checking anything. Fix the product code or the test. A test that is wrong is repaired as its own step, never disabled.",
};

const CLASS_ORDER: readonly string[] = ["weakened-gate", "suppression", "skipped-test", "comment"];
/** The directory names under which the anti-escape stage treats a file as vendored, generated or build output and skips it, unless a tool edited it. */
export const SKIPPED_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", ".git", "vendor", "third_party", "dist", "build", "target", "generated", "__generated__"]);
const TEST_DIRECTORY = /^(?:tests?|__tests__|spec)$/;
const TEST_NAME = /\.(?:test|spec)\.|_test\.(?:go|py)$|^test_.*\.py$|_spec\.rb$/;
const GENERATED_MARKER = /@generated|code generated|do not edit|auto-?generated/i;
const GENERATED_HEAD_LINES = 5;
const MAX_ROWS_PER_CLASS = 20;
const MIN_WHY_FACT_LENGTH = 15;
const FILES_PER_RUN = 400;
const AST_GREP_TIMEOUT_MS = 30_000;
const MEASURE_CONCURRENCY = 8;
const SCAN_CONCURRENCY = 8;
const MAX_SCANNED_BYTES = 10 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_TOTAL_SCANNED_BYTES = 32 * 1024 * 1024;
const AST_GREP_SUPPRESSION = Buffer.from("ast-grep-ignore");
const WIDE_TEXT_SAMPLE_BYTES = 4096;
const MAX_EDIT_DISTANCE = 2000;

const EXPORT_OR_PUBLIC = /^(?:export|public)\b/;
const HIDDEN_MEMBER = /^(?:(?:private|protected)\b|#)/;
const EXPORTED = { kind: "export_statement" };
const javascriptContainers: readonly object[] = [{ kind: "class_body", inside: { any: [{ kind: "class_declaration" }, { kind: "class" }], inside: EXPORTED } }];
const typescriptContainers: readonly object[] = [
	{ kind: "class_body", inside: { any: [{ kind: "class_declaration" }, { kind: "abstract_class_declaration" }, { kind: "class" }], inside: EXPORTED } },
	{ kind: "interface_body", inside: { kind: "interface_declaration", inside: EXPORTED } },
	{ kind: "enum_body", inside: { kind: "enum_declaration", inside: EXPORTED } },
	{ kind: "object_type", inside: { kind: "type_alias_declaration", inside: EXPORTED } },
];
const rustContainers: readonly object[] = [
	{ kind: "enum_variant_list", inside: { kind: "enum_item", has: { kind: "visibility_modifier" } } },
	{ kind: "declaration_list", inside: { kind: "trait_item", has: { kind: "visibility_modifier" } } },
];
const script = {
	isPublic: (head: string): boolean => EXPORT_OR_PUBLIC.test(head),
	isPublicMember: (head: string): boolean => !HIDDEN_MEMBER.test(head),
};

const LANGUAGES: readonly Language[] = [
	{ grammar: "typescript", extensions: ["ts", "mts", "cts"], comments: ["comment"], literals: ["string", "regex", "string_fragment"], attributes: ["decorator"], memberContainers: typescriptContainers, ...script },
	{ grammar: "tsx", extensions: ["tsx"], comments: ["comment"], literals: ["string", "regex", "string_fragment", "jsx_text"], attributes: ["decorator"], memberContainers: typescriptContainers, ...script },
	{ grammar: "javascript", extensions: ["js", "jsx", "mjs", "cjs"], comments: ["comment"], literals: ["string", "regex", "string_fragment", "jsx_text"], attributes: ["decorator"], memberContainers: javascriptContainers, ...script },
	{ grammar: "python", extensions: ["py", "pyi"], comments: ["comment"], literals: ["string"], attributes: [] },
	{
		grammar: "rust",
		extensions: ["rs"],
		comments: ["line_comment", "block_comment"],
		literals: ["string_literal", "raw_string_literal", "char_literal"],
		attributes: ["attribute_item", "inner_attribute_item"],
		memberContainers: rustContainers,
		isPublic: head => /^pub\b/.test(head),
		isPublicMember: () => true,
	},
	{ grammar: "go", extensions: ["go"], comments: ["comment"], literals: ["interpreted_string_literal", "raw_string_literal", "rune_literal"], attributes: [], memberContainers: [{ kind: "source_file" }] },
	{
		grammar: "swift",
		extensions: ["swift"],
		comments: ["comment", "multiline_comment"],
		literals: ["line_string_literal", "multi_line_string_literal", "raw_string_literal", "regex_literal"],
		attributes: ["attribute"],
		isPublic: head => /^(?:\w+\s+){0,4}?(?:public|open)\b/.test(head),
	},
	{
		grammar: "kotlin",
		extensions: ["kt", "kts"],
		comments: ["line_comment", "multiline_comment"],
		literals: ["string_literal", "character_literal"],
		attributes: ["annotation"],
		isPublic: head => !/^(?:\w+\s+){0,4}?(?:private|internal|protected)\b/.test(head) && /^(?:\w+\s+){0,5}?(?:fun|class|interface|object|val|var|typealias)\b/.test(head),
	},
	{
		grammar: "java",
		extensions: ["java"],
		comments: ["line_comment", "block_comment"],
		literals: ["string_literal", "character_literal"],
		attributes: ["marker_annotation", "annotation"],
		isPublic: head => /^(?:\w+\s+){0,4}?public\b/.test(head),
	},
	{ grammar: "c", extensions: ["c", "h"], comments: ["comment"], literals: ["string_literal", "char_literal"], attributes: [], isPublic: head => /^export\b/.test(head) },
	{ grammar: "cpp", extensions: ["cpp", "cc", "cxx", "hpp", "hh"], comments: ["comment"], literals: ["string_literal", "raw_string_literal", "char_literal"], attributes: ["attribute_declaration"], isPublic: head => /^export\b/.test(head) },
	{
		grammar: "csharp",
		extensions: ["cs"],
		comments: ["comment"],
		literals: ["string_literal", "verbatim_string_literal", "interpolated_string_expression", "raw_string_literal", "character_literal"],
		attributes: ["attribute_list"],
		isPublic: head => /^(?:\w+\s+){0,4}?public\b/.test(head),
	},
	{ grammar: "ruby", extensions: ["rb"], comments: ["comment"], literals: ["string", "heredoc_body", "regex", "string_array"], attributes: [] },
	{
		grammar: "php",
		extensions: ["php"],
		comments: ["comment"],
		literals: ["string", "encapsed_string", "heredoc", "nowdoc"],
		attributes: ["attribute_list"],
		isPublic: head => !/^(?:\w+\s+){0,3}?(?:private|protected)\b/.test(head) && /^(?:\w+\s+){0,3}?(?:public|function|class|interface|trait|enum)\b/.test(head),
	},
	{ grammar: "css", extensions: ["css"], comments: ["comment"], literals: ["string_value"], attributes: [] },
	{
		grammar: "scala",
		extensions: ["scala", "sc", "sbt"],
		comments: ["comment", "block_comment"],
		literals: ["string", "interpolated_string_expression", "character_literal"],
		attributes: [],
		isPublic: head => !/^(?:\w+\s+){0,4}?(?:private|protected)\b/.test(head) && /^(?:\w+\s+){0,5}?(?:def|class|object|trait|val|var|type|enum|given)\b/.test(head),
	},
	{ grammar: "lua", extensions: ["lua"], comments: ["comment"], literals: ["string"], attributes: [] },
	{ grammar: "bash", extensions: ["sh", "bash", "zsh", "ksh", "bats"], comments: ["comment"], literals: ["string", "raw_string", "ansi_c_string", "heredoc_body"], attributes: [] },
	{ grammar: "html", extensions: ["html", "htm", "xhtml"], comments: ["comment"], literals: ["attribute_value", "raw_text"], attributes: [] },
];

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, Language> = new Map(LANGUAGES.flatMap(language => language.extensions.map(extension => [extension, language] as const)));

const SCRIPT_GRAMMARS = ["typescript", "tsx", "javascript"];

const RUST_ATTRIBUTE = /#\s*!?\s*\[/g;

const CODE_PATTERNS: readonly CodePattern[] = [
	{ class: "skipped-test", grammars: SCRIPT_GRAMMARS, callForm: true, find: occurrences(/(?<![\w$])(?:xit|xdescribe|xtest|fdescribe)\s*\(/g) },
	{ class: "skipped-test", grammars: SCRIPT_GRAMMARS, callForm: true, find: occurrences(/(?<![\w$.])fit\s*\(\s*(?:,|`)/g) },
	{ class: "skipped-test", grammars: SCRIPT_GRAMMARS, callForm: true, find: occurrences(/\.(?:skip(?:If)?|only|todo(?:If)?|fixme|failing)(?:\.\w+)*\s*\(/g, true) },
	{ class: "skipped-test", grammars: SCRIPT_GRAMMARS, callForm: true, find: occurrences(/(?<![\w$.])Deno\.test\.ignore\s*\(/g) },
	{ class: "skipped-test", grammars: SCRIPT_GRAMMARS, callForm: true, find: insideSpans(/(?<![\w$.])Deno\.test\s*\(/g, /(?<=[{,]\s*)ignore\s*:\s*true\b/g) },
	{ class: "suppression", grammars: ["rust"], callForm: false, find: insideSpans(RUST_ATTRIBUTE, /(?<=[[,]\s*)(?:allow|expect)(?=\s*\()/g) },
	{ class: "skipped-test", grammars: ["rust"], callForm: false, find: insideSpans(RUST_ATTRIBUTE, /(?<=[[,]\s*)ignore\b|\bcfg\s*\(\s*any\s*\(\s*\)\s*\)/g) },
	{ class: "skipped-test", grammars: ["python"], callForm: false, find: occurrences(/@(?:pytest\.mark\.(?:skip|xfail)|unittest\.(?:skip|expectedFailure))/g) },
	{ class: "skipped-test", grammars: ["python"], callForm: true, find: occurrences(/(?<![\w.])pytest\.(?:skip|xfail)\s*\(|\braise\s+(?:unittest\.)?SkipTest\b|\.skipTest\s*\(/g) },
	{ class: "skipped-test", grammars: ["go"], callForm: true, find: occurrences(/\.Skip(?:f|Now)?\s*\(/g) },
	{ class: "skipped-test", grammars: ["java", "kotlin"], callForm: false, find: occurrences(/@(?:Disabled\w*|Ignore)\b/g) },
	{ class: "suppression", grammars: ["java", "kotlin"], callForm: false, find: occurrences(/@Suppress(?:Warnings|Lint)?\b/g) },
	{ class: "skipped-test", grammars: ["swift"], callForm: false, find: occurrences(/\bXCTSkip\w*/g) },
	{ class: "skipped-test", grammars: ["ruby"], callForm: true, find: occurrences(/(?<![\w$.])(?:xit|xdescribe|xcontext|xspecify)\b/g) },
];

const SUPPRESSION_IN_COMMENT: readonly RegExp[] = [
	/eslint-disable/i,
	/oxlint-disable/i,
	/biome-ignore\b/i,
	/@ts-(?:ignore|expect-error|nocheck)\b/,
	/type:\s*ignore\b/i,
	/\bnoqa\b/i,
	/pylint:\s*disable/i,
	/\bnolint\w*/i,
	/swiftlint:\s*disable/i,
	/\b(?:istanbul|c8|v8)\s+ignore\b/i,
	/pragma:\s*no\s+cover/i,
	/rubocop:\s*disable/i,
	/stylelint-disable/i,
	/phpcs:\s*(?:ignore|disable)/i,
	/pyright:\s*ignore/i,
	/mypy:\s*ignore-errors/i,
	/\bast-grep-ignore\b/,
];

const SHEBANG = /^#!\s*\/\S*(?:\s+[\w./=:@+-]+){0,3}$/;
const TRIPLE_SLASH_DIRECTIVE = /^\/\/\/\s*<(?:reference|amd-module|amd-dependency)(?:\s+[\w-]+\s*=\s*"[^"\s]*")*\s*\/>$/;
const GO_DIRECTIVE = /^\/\/go:(?:build|generate|embed|noinline|nosplit|linkname|norace|noescape|uintptrescapes|debug)(?:\s|$)/;
const CGO_EXPORT = /^\/\/export\s+[\p{L}_][\p{L}\p{N}_]*$/u;
const CGO_IMPORT = /^import\s+"C"$/;
const DIRECTIVE_BODIES: readonly RegExp[] = [
	/^@ts-check$/,
	/^prettier-ignore(?:-start|-end)?$/,
	/^@generated(?:\s+by\s+\S+)?$/,
	/^frozen_string_literal:\s*(?:true|false)$/,
	/^(?:fmt:\s*(?:off|on|skip)|isort:\s*(?:skip|off|on)|clang-format\s+(?:off|on)|swiftformat:\s*(?:disable|enable)|dprint-ignore)$/,
	/^(?:@vite-ignore|[#@]__(?:PURE|NO_SIDE_EFFECTS)__)$/,
];
const SPDX_LINE = /^SPDX-License-Identifier:\s*(.+)$/;
const SPDX_ID = String.raw`[A-Za-z0-9][A-Za-z0-9.+-]*(?::[A-Za-z0-9.+-]+)?`;
const SPDX_TERM = String.raw`${SPDX_ID}(?:\s+WITH\s+${SPDX_ID})?`;
const SPDX_EXPRESSION = new RegExp(String.raw`^${SPDX_TERM}(?:\s+(?:AND|OR)\s+${SPDX_TERM})*$`);
const MAGIC_VALUE = String.raw`(?:"[^"\s]*"|'[^'\s]*'|true|false|-?\d+|/(?:[^/\\\s]|\\.)+/[a-z]*|\[\s*(?:(?:"[^"\s]*"|'[^'\s]*')\s*(?:,\s*)?)*\])`;
const MAGIC_PAIR = String.raw`webpack(?:ChunkName|Mode|Prefetch|Preload|FetchPriority|Include|Exclude|Ignore|Exports)\s*:\s*${MAGIC_VALUE}`;
const BUNDLER_MAGIC = new RegExp(String.raw`^${MAGIC_PAIR}(?:\s*,\s*${MAGIC_PAIR})*$`);
const ENCODING_GRAMMARS: readonly string[] = ["python", "ruby"];
const ENCODING_PRAGMA = /^(?:-\*-\s*)?(?:vim?:\s*(?:set\s+)?)?(?:file)?(?:en)?coding\s*[:=]\s*[\w.-]+(?:\s*(?:-\*-|:))?$/;
const JSDOC_TYPED_TAG = /^@(?:type|satisfies)\s*\{(.*)\}$|^@typedef\s*\{(.*)\}\s+[\w$.]+$/;
const JSDOC_NAMED_TAG = /^@callback\s+[\w$.]+$|^@template\s+(?:\{[^{}]*\}\s+)?[\w$]+(?:\s*,\s*[\w$]+)*$|^@import\s+(?:\{[^{}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+["'][^"'\s]+["']$/;
const TYPE_PROSE = /(?<![\w$])(?!(?:typeof|keyof|readonly|unique|infer|new|const|function|void)\b)[A-Za-z_$][\w$]*\s+(?!(?:extends|is|in|as)\b)[A-Za-z_$]/;
const LICENCE_MARKER = /\bcopyright\b|\bSPDX-License-Identifier\b|\blicensed\s+under\b/i;
const FILE_PREAMBLE = /^(?:#![^\n]*)?\s*(?:<\?php\b)?/i;
const COMMENT_HEAD = /^\s*(?:\/\/[/!]?|\/\*[*!]?|\*+|#+!?|--+|<!--)/;
const COMMENT_TAIL = /(?:\*\/|-->)\s*$/;
const WHY_MENTION = /\bwhy\(/;
const WHY_COMMENT = /^why\((?:platform|vendor|protocol|spec|legal)\):\s*([\s\S]*)$/;
const EXTERNAL_REFERENCES: readonly RegExp[] = [
	/\bhttps?:\/\/[\p{L}\p{N}]/u,
	/\b(?:RFC|PEP)[ -]?\d+\b/,
	/\bECMA-\d+\b/,
	/\bISO(?:\/IEC)? \d+\b/,
	/\bCVE-\d{4}-\d{4,}\b/,
	/(?<![\w@./-])(?:@[a-z\d][\w.-]*\/)?[a-z][\w.-]*@\d+\.\d+\.\d+/i,
	/(?<![\w./-])[A-Za-z\d][\w-]*\/[\w.-]+#\d+\b/,
	/\bman\s+(?!pages?\b)[a-z][\w.-]*(?:\([1-9]\))?/,
	/\b[a-z][\w.-]*\([1-9]\)\s+man\s+page\b/,
];
const EXCUSE_WORDS_EXACT_CASE = /\b(?:TODO|FIXME|HACK|XXX)\b/;
const EXCUSE_WORDS_ANY_CASE = /\b(?:workaround|temporary|temporarily|for\s+now|quick\s+fix|hack)\b/i;
const DOC_SYNTAX = /^(?:\/\*\*(?![*/])|\/\/\/(?!\/)|\/\/!|\/\*!)/;
const LUA_BLOCK_COMMENT = /^--\[(=*)\[([\s\S]*)\]\1\]$/;

const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

function makeFinding(cls: EscapeClass, file: string, line: number | undefined, text: string): Finding {
	const finding: Finding = { stage: "escape", class: cls, message: GUIDANCE[cls], file, text: shortened(text) };
	return line === undefined ? finding : { ...finding, line };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const bucket = map.get(key);
	if (bucket) bucket.push(value);
	else map.set(key, [value]);
}

function regularFileSize(path: string): number | undefined {
	try {
		const stat = lstatSync(path);
		return stat.isFile() ? stat.size : undefined;
	} catch {
		return undefined;
	}
}

function normalizePath(raw: string): string {
	return raw.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeFiles(files: readonly string[]): string[] {
	const kept = new Set<string>();
	for (const raw of files) {
		const file = normalizePath(raw);
		if (file === "" || file.startsWith("/") || file.split("/").includes("..")) continue;
		kept.add(file);
	}
	return [...kept].sort();
}

function scopeOf(input: EscapeInput): Scope {
	const toolEdited = input.toolEdited === undefined ? undefined : new Set([...input.toolEdited].map(normalizePath));
	const edited = (file: string): boolean => toolEdited === undefined || toolEdited.has(file);
	const kept = normalizeFiles(input.files).filter(file => edited(file) || !file.split("/").some(segment => SKIPPED_SEGMENTS.has(segment)));
	return { files: kept, edited };
}

function lineIndexOf(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (starts[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return low + 1;
}

function lineStartsOf(text: string): number[] {
	const starts = [0];
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
	return starts;
}

function createSource(bytes: Uint8Array): Source {
	const starts = [0];
	for (let index = 0; index < bytes.length; index++) if (bytes[index] === 0x0a) starts.push(index + 1);
	const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
	const lineOf = (offset: number): number => lineIndexOf(starts, offset);
	return {
		bytes,
		lineCount: endsWithNewline ? starts.length - 1 : starts.length,
		lineOf,
		lineBounds: line => [starts[line - 1], line < starts.length ? starts[line] - 1 : bytes.length],
		text: (start, end) => decoder.decode(bytes.subarray(start, end)),
	};
}

async function requireBase(input: EscapeInput): Promise<void> {
	const result = input.base.startsWith("-") ? undefined : await git(input.repo, ["rev-parse", "--verify", "--quiet", `${input.base}^{tree}`], input.signal);
	if (result?.code !== 0) throw new Error(`escape: base ${JSON.stringify(input.base)} is not a commit in ${input.repo}`);
}

function linesOf(text: string): string[] {
	const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function lineIds(...lists: readonly (readonly string[])[]): Int32Array[] {
	const ids = new Map<string, number>();
	return lists.map(lines =>
		Int32Array.from(lines, line => {
			const key = line.endsWith("\r") ? line.slice(0, -1) : line;
			const known = ids.get(key);
			if (known !== undefined) return known;
			ids.set(key, ids.size);
			return ids.size - 1;
		}),
	);
}

function everythingChanged(deletedCount: number, insertedCount: number): Edits {
	return { deleted: Array.from({ length: deletedCount }, (_, index) => index), inserted: Array.from({ length: insertedCount }, (_, index) => index) };
}

function traceBack(trace: readonly Int32Array[], lastRound: number, rows: number, columns: number): Edits {
	const deleted: number[] = [];
	const inserted: number[] = [];
	let x = rows;
	let y = columns;
	for (let round = lastRound; round > 0; round--) {
		const earlier = trace[round];
		const shift = round + 1;
		const diagonal = x - y;
		const down = diagonal === -round || (diagonal !== round && earlier[diagonal - 1 + shift] < earlier[diagonal + 1 + shift]);
		const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
		const previousX = earlier[previousDiagonal + shift];
		const previousY = previousX - previousDiagonal;
		if (down) inserted.push(previousY);
		else deleted.push(previousX);
		x = previousX;
		y = previousY;
	}
	return { deleted: deleted.reverse(), inserted: inserted.reverse() };
}

function shortestEdit(left: Int32Array, right: Int32Array): Edits {
	if (left.length === 0 || right.length === 0) return everythingChanged(left.length, right.length);
	const limit = Math.min(left.length + right.length, MAX_EDIT_DISTANCE);
	const origin = limit + 1;
	const furthest = new Int32Array(2 * limit + 3);
	const trace: Int32Array[] = [];
	for (let round = 0; round <= limit; round++) {
		trace.push(furthest.slice(origin - round - 1, origin + round + 2));
		for (let diagonal = -round; diagonal <= round; diagonal += 2) {
			const down = diagonal === -round || (diagonal !== round && furthest[origin + diagonal - 1] < furthest[origin + diagonal + 1]);
			let x = down ? furthest[origin + diagonal + 1] : furthest[origin + diagonal - 1] + 1;
			let y = x - diagonal;
			while (x < left.length && y < right.length && left[x] === right[y]) {
				x++;
				y++;
			}
			furthest[origin + diagonal] = x;
			if (x >= left.length && y >= right.length) return traceBack(trace, round, left.length, right.length);
		}
	}
	return everythingChanged(left.length, right.length);
}

function changeOf(before: readonly string[], after: readonly string[]): Change {
	const [left, right] = lineIds(before, after);
	let head = 0;
	while (head < left.length && head < right.length && left[head] === right[head]) head++;
	let leftEnd = left.length;
	let rightEnd = right.length;
	while (leftEnd > head && rightEnd > head && left[leftEnd - 1] === right[rightEnd - 1]) {
		leftEnd--;
		rightEnd--;
	}
	const edits = shortestEdit(left.subarray(head, leftEnd), right.subarray(head, rightEnd));
	return {
		added: new Set(edits.inserted.map(index => head + index + 1)),
		removed: edits.deleted.map(index => before[head + index].trim()),
		removedLines: new Set(edits.deleted.map(index => head + index + 1)),
	};
}

function decode(bytes: Uint8Array): { text: string; valid: boolean } {
	try {
		return { text: strictDecoder.decode(bytes), valid: true };
	} catch {
		return { text: decoder.decode(bytes), valid: false };
	}
}

function looksWide(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, WIDE_TEXT_SAMPLE_BYTES);
	let nuls = 0;
	for (const byte of sample) if (byte === 0) nuls++;
	return nuls * 4 > sample.length;
}

function hasLongLine(bytes: Uint8Array): boolean {
	let start = 0;
	for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
		if (end - start > MAX_LINE_BYTES) return true;
		start = end + 1;
	}
	return bytes.length - start > MAX_LINE_BYTES;
}

/** Whether the first lines of `text` carry a generated-code banner (`@generated`, `code generated`, `do not edit`, `autogenerated`); the anti-escape stage skips such a file unless a tool edited it. */
export function hasGeneratedMarker(text: string): boolean {
	return GENERATED_MARKER.test(text.split("\n", GENERATED_HEAD_LINES).join("\n"));
}

async function measure(input: EscapeInput, file: string, edited: boolean): Promise<Measured> {
	const path = join(input.repo, file);
	const size = regularFileSize(path);
	const base = await baseTextOf(input, file);
	const before = base === null ? [] : linesOf(base);
	if (size === undefined) return { kind: "measured", change: changeOf(before, []) };
	if (size > MAX_SCANNED_BYTES) {
		const unchanged = base !== null && Buffer.byteLength(base) === size && Buffer.from(base).equals(readFileSync(path));
		return unchanged ? { kind: "measured", change: { added: new Set(), removed: [], removedLines: new Set() } } : { kind: "unreadable" };
	}
	const bytes = readFileSync(path);
	const decoded = decode(bytes);
	if (!edited && hasGeneratedMarker(decoded.text)) return { kind: "skipped" };
	const change = changeOf(before, linesOf(decoded.text));
	const readable = decoded.valid && !looksWide(bytes) && !hasLongLine(bytes);
	return change.added.size > 0 && !readable ? { kind: "unreadable", change } : { kind: "measured", change };
}

function buildPool(changes: ReadonlyMap<string, Change>): RemovedPool {
	const pool: RemovedPool = { byText: new Map(), byFile: new Map() };
	for (const [file, change] of changes) {
		for (const text of change.removed) {
			if (text === "") continue;
			const entry: RemovedLine = { file, text, used: false };
			pushTo(pool.byText, text, entry);
			pushTo(pool.byFile, file, entry);
		}
	}
	return pool;
}

function takeExact(pool: RemovedPool, text: string): RemovedLine | undefined {
	const bucket = pool.byText.get(text);
	while (bucket && bucket.length > 0) {
		const entry = bucket.pop();
		if (entry && !entry.used) {
			entry.used = true;
			return entry;
		}
	}
	return undefined;
}

function takeTrailing(pool: RemovedPool, file: string, tail: string): RemovedLine | undefined {
	const entry = pool.byFile.get(file)?.find(candidate => !candidate.used && candidate.text.endsWith(tail));
	if (entry) entry.used = true;
	return entry;
}

function releaseLine(pool: RemovedPool, entry: RemovedLine): void {
	entry.used = false;
	pushTo(pool.byText, entry.text, entry);
}

function ruleDocument(language: Language, id: NodeRule, body: object): string {
	return JSON.stringify({ id, severity: "hint", language: language.grammar, rule: body });
}

function kindsOf(names: readonly string[]): object {
	return { any: names.map(kind => ({ kind })) };
}

function commentRule(language: Language): string {
	return ruleDocument(language, "comment", kindsOf(language.comments));
}

function rulesFor(language: Language): string {
	const documents = [commentRule(language), ruleDocument(language, "literal", kindsOf(language.literals))];
	if (language.attributes.length > 0) documents.push(ruleDocument(language, "attribute", kindsOf(language.attributes)));
	if (language.memberContainers) documents.push(ruleDocument(language, "member", { ...kindsOf(language.comments), inside: { any: language.memberContainers } }));
	return documents.join("\n---\n");
}

function parseMatch(line: string): { file: string; node: AstNode } | undefined {
	if (!line.startsWith("{")) return undefined;
	const match: unknown = JSON.parse(line);
	const file = propertyOf(match, "file");
	const rule = propertyOf(match, "ruleId");
	const offsets = propertyOf(propertyOf(match, "range"), "byteOffset");
	const start = propertyOf(offsets, "start");
	const end = propertyOf(offsets, "end");
	if (typeof file !== "string" || typeof start !== "number" || typeof end !== "number") return undefined;
	if (rule !== "comment" && rule !== "literal" && rule !== "attribute" && rule !== "member") return undefined;
	return { file, node: { rule, start, end } };
}

function astGrep(args: string[], signal: AbortSignal | undefined, stdin?: Uint8Array): Promise<Run> {
	return run([AST_GREP, ...args], tmpdir(), { timeoutMs: loweredLimit("DONE_GATE_ESCAPE_AST_GREP_TIMEOUT_MS", AST_GREP_TIMEOUT_MS), signal, stdin });
}

function defused(bytes: Buffer): Buffer {
	let at = bytes.indexOf(AST_GREP_SUPPRESSION);
	if (at === -1) return bytes;
	const copy = Buffer.from(bytes);
	for (; at !== -1; at = copy.indexOf(AST_GREP_SUPPRESSION, at + 1)) copy[at] ^= 0x20;
	return copy;
}

async function scanUnit(input: EscapeInput, unit: Unit): Promise<Map<string, AstNode[]>> {
	const base = ["scan", "--inline-rules", rulesFor(unit.language), "--json=stream"];
	const paths = unit.files.map(file => join(input.repo, file));
	const result = unit.stdin ? await astGrep([...base, "--stdin"], input.signal, unit.stdin) : await astGrep([...base, "--", ...paths], input.signal);
	if (result.code !== 0) throw scanFailure(unit.language, result);
	const fileOf = new Map<string, string>(unit.stdin ? [["STDIN", unit.files[0]]] : unit.files.map((file, index) => [paths[index], file]));
	const nodes = new Map<string, AstNode[]>();
	for (const line of result.out.split("\n")) {
		const parsed = parseMatch(line);
		const file = parsed === undefined ? undefined : fileOf.get(parsed.file);
		if (parsed !== undefined && file !== undefined) pushTo(nodes, file, parsed.node);
	}
	return nodes;
}

function scanFailure(language: Language, result: Run): Error {
	return new Error(`escape: ast-grep failed on ${language.grammar} files (exit ${result.code}): ${result.err.slice(0, 300)}`);
}

async function scanComments(input: EscapeInput, language: Language, bytes: Buffer): Promise<AstNode[]> {
	const result = await astGrep(["scan", "--inline-rules", commentRule(language), "--json=stream", "--stdin"], input.signal, defused(bytes));
	if (result.code !== 0) throw scanFailure(language, result);
	return result.out.split("\n").flatMap(line => parseMatch(line)?.node ?? []);
}

async function scanNodes(input: EscapeInput, targets: readonly Target[]): Promise<Map<string, AstNode[]>> {
	const recognized = new Map<Language, string[]>();
	const units: Unit[] = [];
	for (const { file, language } of targets) {
		const bytes = readFileSync(join(input.repo, file));
		if (bytes.includes(AST_GREP_SUPPRESSION) || !language.extensions.includes(extname(file).slice(1))) units.push({ language, files: [file], stdin: defused(bytes) });
		else pushTo(recognized, language, file);
	}
	for (const [language, files] of recognized) {
		for (let start = 0; start < files.length; start += FILES_PER_RUN) units.push({ language, files: files.slice(start, start + FILES_PER_RUN) });
	}
	const scanned = await runAll(units, SCAN_CONCURRENCY, input.signal, (unit, signal) => scanUnit({ ...input, signal }, unit));
	const nodes = new Map<string, AstNode[]>();
	for (const found of scanned) for (const [file, list] of found) nodes.set(file, list);
	return nodes;
}

function maskLiteralsAndComments(bytes: Uint8Array, nodes: readonly AstNode[]): Uint8Array {
	const masked = new Uint8Array(bytes);
	for (const node of nodes) {
		if (node.rule === "attribute") continue;
		const end = Math.min(node.end, masked.length);
		for (let index = node.start; index < end; index++) if (masked[index] !== 0x0a && masked[index] !== 0x0d) masked[index] = 0x20;
	}
	return masked;
}

function toComments(source: Source, nodes: readonly AstNode[]): Comment[] {
	const memberStarts = new Set(nodes.filter(node => node.rule === "member").map(node => node.start));
	const comments = nodes.filter(node => node.rule === "comment").sort((left, right) => left.start - right.start);
	return comments.map(node => {
		const startLine = source.lineOf(node.start);
		return {
			start: node.start,
			end: node.end,
			startLine,
			endLine: source.lineOf(Math.max(node.start, node.end - 1)),
			text: source.text(node.start, node.end).trimEnd(),
			standalone: source.text(source.lineBounds(startLine)[0], node.start).trim() === "",
			inContainer: memberStarts.has(node.start),
		};
	});
}

/** Whether the repo-relative `file` is a test file by the names and directories the anti-escape stage recognises. */
export function isTestFile(file: string): boolean {
	const segments = file.toLowerCase().split("/");
	const name = segments.pop() ?? "";
	return TEST_NAME.test(name) || segments.some(segment => TEST_DIRECTORY.test(segment));
}

function groupComments(comments: readonly Comment[]): Map<Comment, Comment[]> {
	const groupOf = new Map<Comment, Comment[]>();
	let group: Comment[] = [];
	for (const comment of comments) {
		const previous = group[group.length - 1];
		if (previous === undefined || !(comment.standalone && previous.standalone && previous.endLine + 1 === comment.startLine)) group = [];
		group.push(comment);
		groupOf.set(comment, group);
	}
	return groupOf;
}

function createContext(file: string, language: Language, bytes: Uint8Array, nodes: readonly AstNode[], change: Change, pool: RemovedPool): FileContext {
	const source = createSource(bytes);
	const comments = toComments(source, nodes);
	return {
		file,
		language,
		source,
		maskedBytes: maskLiteralsAndComments(bytes, nodes),
		comments,
		groups: groupComments(comments),
		skips: new Map(nodes.filter(node => node.rule !== "literal").map(node => [node.start, node.end] as const)),
		added: change.added,
		removedLines: change.removedLines,
		pool,
		carried: new Map(),
		testFile: isTestFile(file),
		verdicts: new Map(),
		licensed: new Map(),
	};
}

function maskedLine(context: FileContext, line: number): string {
	const [start, end] = context.source.lineBounds(line);
	return decoder.decode(context.maskedBytes.subarray(start, end));
}

function rawLine(context: FileContext, line: number): string {
	const [start, end] = context.source.lineBounds(line);
	return context.source.text(start, end).trim();
}

function firstAddedLine(comment: Comment, added: ReadonlySet<number>): number | undefined {
	for (let line = comment.startLine; line <= comment.endLine; line++) if (added.has(line)) return line;
	return undefined;
}

function portionOn(context: FileContext, comment: Comment, line: number): string {
	const [lineStart, lineEnd] = context.source.lineBounds(line);
	return context.source.text(Math.max(lineStart, comment.start), Math.min(lineEnd, comment.end)).trim();
}

function lineCarried(context: FileContext, line: number): boolean {
	const known = context.carried.get(line);
	if (known !== undefined) return known;
	const carried = takeExact(context.pool, rawLine(context, line)) !== undefined;
	context.carried.set(line, carried);
	return carried;
}

function carriedOver(context: FileContext, comment: Comment): boolean {
	const claimed: RemovedLine[] = [];
	for (let line = comment.startLine; line <= comment.endLine; line++) {
		if (!context.added.has(line) || lineCarried(context, line)) continue;
		const portion = portionOn(context, comment, line);
		if (portion === "") continue;
		const entry = takeExact(context.pool, portion) ?? takeTrailing(context.pool, context.file, portion);
		if (!entry) {
			for (const earlier of claimed) releaseLine(context.pool, earlier);
			return false;
		}
		claimed.push(entry);
	}
	return true;
}

function commentBody(text: string): string {
	if (text.startsWith("/*")) {
		const inner = text.slice(2, text.endsWith("*/") ? -2 : undefined).replace(/^[*!]+/, "");
		const lines = inner.split("\n").map((line, index) => (index === 0 ? line : line.replace(/^\s*\*+/, "")).trim());
		return lines.filter(line => line !== "").join(" ");
	}
	if (text.startsWith("//")) return text.replace(/^\/\/[/!]*/, "").trim();
	if (text.startsWith("=begin")) return text.replace(/^=begin/, "").replace(/=end\s*$/, "").trim();
	if (text.startsWith("<!--")) return text.replace(/^<!--/, "").replace(/-->$/, "").trim();
	if (text.startsWith("--")) return (LUA_BLOCK_COMMENT.exec(text)?.[2] ?? text.replace(/^-+/, "")).trim();
	return text.replace(/^#+!?/, "").trim();
}

function isSpdxLine(body: string): boolean {
	const match = SPDX_LINE.exec(body);
	return match !== null && SPDX_EXPRESSION.test(match[1].replace(/[()]/g, " ").trim());
}

function isJsDocTypeTag(body: string): boolean {
	const typed = JSDOC_TYPED_TAG.exec(body);
	return typed === null ? JSDOC_NAMED_TAG.test(body) : !TYPE_PROSE.test(typed[1] ?? typed[2]);
}

function isDirective(context: FileContext, comment: Comment): boolean {
	const { text } = comment;
	const { grammar } = context.language;
	if ((comment.start === 0 && SHEBANG.test(text)) || TRIPLE_SLASH_DIRECTIVE.test(text) || (grammar === "go" && GO_DIRECTIVE.test(text))) return true;
	const body = commentBody(text);
	if (DIRECTIVE_BODIES.some(pattern => pattern.test(body)) || isSpdxLine(body) || BUNDLER_MAGIC.test(body)) return true;
	if (grammar === "javascript" && isJsDocTypeTag(body)) return true;
	return comment.startLine <= 2 && ENCODING_GRAMMARS.includes(grammar) && ENCODING_PRAGMA.test(body);
}

function groupBody(group: readonly Comment[]): string {
	return group.map(member => commentBody(member.text)).join(" ");
}

function isBlankGap(context: FileContext, from: number, to: number): boolean {
	const gap = context.source.text(from, to);
	return (from === 0 ? gap.replace(FILE_PREAMBLE, "") : gap).trim() === "";
}

function startsFile(context: FileContext, first: Comment): boolean {
	let position = 0;
	for (const comment of context.comments) {
		if (comment.start >= first.start) break;
		if (!isBlankGap(context, position, comment.start)) return false;
		position = comment.end;
	}
	return isBlankGap(context, position, first.start);
}

function inLicenceBlock(context: FileContext, comment: Comment): boolean {
	const group = context.groups.get(comment);
	if (group === undefined) return false;
	let licensed = context.licensed.get(group);
	if (licensed === undefined) {
		const body = groupBody(group);
		licensed = LICENCE_MARKER.test(body) && !hasExcuse(body) && startsFile(context, group[0]);
		context.licensed.set(group, licensed);
	}
	return licensed;
}

function isCgo(context: FileContext, comment: Comment): boolean {
	if (CGO_EXPORT.test(comment.text)) return true;
	const group = context.groups.get(comment);
	if (group === undefined || !comment.standalone) return false;
	const importLine = group[group.length - 1].endLine + 1;
	return importLine <= context.source.lineCount && CGO_IMPORT.test(rawLine(context, importLine)) && !hasExcuse(groupBody(group));
}

function isWhy(comment: Comment): boolean {
	const match = WHY_COMMENT.exec(commentBody(comment.text));
	if (match === null) return false;
	const fact = match[1].trim();
	return fact.length >= MIN_WHY_FACT_LENGTH && EXTERNAL_REFERENCES.some(pattern => pattern.test(fact));
}

function nextCodeStart(context: FileContext, from: number): number {
	const bytes = context.source.bytes;
	let position = from;
	let jumped = true;
	while (jumped) {
		while (position < bytes.length && bytes[position] <= 0x20) position++;
		const end = context.skips.get(position);
		jumped = end !== undefined && end > position;
		if (jumped && end !== undefined) position = end;
	}
	return position;
}

function headAt(context: FileContext, position: number): string {
	if (position >= context.source.bytes.length) return "";
	const [, lineEnd] = context.source.lineBounds(context.source.lineOf(position));
	return decoder.decode(context.maskedBytes.subarray(position, lineEnd)).trim();
}

function goDocOpening(head: string): RegExp | undefined {
	const packaged = /^package\s+([\p{L}\p{N}_]+)/u.exec(head);
	if (packaged !== null) return new RegExp(`^Package\\s+${packaged[1]}(?![\\p{L}\\p{N}_])`, "u");
	const named = /^func\s+(?:\([^)]*\)\s*)?(\p{Lu}[\p{L}\p{N}_]*)/u.exec(head) ?? /^(?:type|var|const)\s+(\p{Lu}[\p{L}\p{N}_]*)/u.exec(head);
	return named === null ? undefined : new RegExp(`^${named[1]}(?![\\p{L}\\p{N}_])`, "u");
}

function isGoDocumentation(context: FileContext, comment: Comment): boolean {
	const group = context.groups.get(comment);
	if (group === undefined || !comment.inContainer || !group.every(member => member.standalone && member.text.startsWith("//"))) return false;
	const leading = group.find(member => !GO_DIRECTIVE.test(member.text));
	const declaredLine = group[group.length - 1].endLine + 1;
	if (leading === undefined || declaredLine > context.source.lineCount) return false;
	return goDocOpening(maskedLine(context, declaredLine))?.test(commentBody(leading.text)) === true;
}

function isDocumentationOfPublicApi(context: FileContext, comment: Comment): boolean {
	if (context.language.grammar === "go") return isGoDocumentation(context, comment);
	if (!comment.standalone || !DOC_SYNTAX.test(comment.text)) return false;
	const visible = comment.inContainer ? context.language.isPublicMember : context.language.isPublic;
	return visible !== undefined && visible(headAt(context, nextCodeStart(context, comment.end)));
}

function hasExcuse(text: string): boolean {
	return EXCUSE_WORDS_EXACT_CASE.test(text) || EXCUSE_WORDS_ANY_CASE.test(text);
}

function carriesExcuse(comment: Comment): boolean {
	return hasExcuse(commentBody(comment.text));
}

function flattened(piece: string): string {
	return piece.replace(COMMENT_TAIL, "").replace(COMMENT_HEAD, "").replace(/\s+/g, "");
}

async function removedCommentsOf(input: EscapeInput, context: FileContext): Promise<RemovedComments> {
	const bytes = Buffer.from((await baseTextOf(input, context.file)) ?? "");
	if (bytes.length === 0 || bytes.length > MAX_SCANNED_BYTES) return { runs: [] };
	const source = createSource(bytes);
	const nodes = (await scanComments(input, context.language, bytes)).sort((left, right) => left.start - right.start);
	const runs: string[] = [];
	let previousLine = 0;
	for (const node of nodes) {
		const lastLine = source.lineOf(Math.max(node.start, node.end - 1));
		for (let line = source.lineOf(node.start); line <= lastLine; line++) {
			if (!context.removedLines.has(line)) continue;
			const [lineStart, lineEnd] = source.lineBounds(line);
			const piece = flattened(source.text(Math.max(lineStart, node.start), Math.min(lineEnd, node.end)));
			if (line === previousLine + 1 && runs.length > 0) runs[runs.length - 1] += piece;
			else runs.push(piece);
			previousLine = line;
		}
	}
	return { runs: runs.filter(run => run !== "") };
}

function reflowed(context: FileContext, comment: Comment): boolean {
	const { removedComments } = context;
	if (removedComments === undefined) return false;
	const runs = [...removedComments.runs];
	let matched = false;
	for (let line = comment.startLine; line <= comment.endLine; line++) {
		if (!context.added.has(line)) continue;
		const piece = flattened(portionOn(context, comment, line));
		if (piece === "") continue;
		const index = runs.findIndex(run => run.includes(piece));
		if (index === -1) return false;
		const at = runs[index].indexOf(piece);
		runs.splice(index, 1, runs[index].slice(0, at), runs[index].slice(at + piece.length));
		matched = true;
	}
	if (matched) removedComments.runs = runs.filter(run => run !== "");
	return matched;
}

function judge(context: FileContext, comment: Comment): CommentVerdict {
	if (SUPPRESSION_IN_COMMENT.some(pattern => pattern.test(comment.text))) return "suppression";
	if (isDirective(context, comment) || inLicenceBlock(context, comment) || (context.language.grammar === "go" && isCgo(context, comment))) return undefined;
	if (isWhy(comment)) return carriesExcuse(comment) ? "comment" : "accepted";
	if (isDocumentationOfPublicApi(context, comment)) return carriesExcuse(comment) || WHY_MENTION.test(commentBody(comment.text)) ? "comment" : undefined;
	return "comment";
}

function verdictOf(context: FileContext, comment: Comment): CommentVerdict {
	if (!context.verdicts.has(comment)) context.verdicts.set(comment, judge(context, comment));
	return context.verdicts.get(comment);
}

function refused(verdict: CommentVerdict): boolean {
	return verdict !== undefined && verdict !== "accepted";
}

function classifyComment(context: FileContext, comment: Comment): CommentVerdict {
	if (carriedOver(context, comment)) return undefined;
	const verdict = verdictOf(context, comment);
	return refused(verdict) && reflowed(context, comment) ? undefined : verdict;
}

function hasRefusedAddedComment(context: FileContext): boolean {
	return context.comments.some(comment => firstAddedLine(comment, context.added) !== undefined && refused(verdictOf(context, comment)));
}

function followsCall(masked: string, index: number): boolean {
	let position = index - 1;
	while (position >= 0 && /\s/.test(masked[position])) position--;
	return masked[position] === ")" || masked[position] === "]";
}

function occurrences(pattern: RegExp, notAfterCall = false): Finder {
	return function* (masked) {
		for (const match of masked.matchAll(pattern)) if (!notAfterCall || !followsCall(masked, match.index)) yield match.index;
	};
}

function spanAt(masked: string, open: number): string {
	const opener = masked[open];
	const closer = opener === "[" ? "]" : ")";
	let depth = 0;
	for (let index = open; index < masked.length; index++) {
		if (masked[index] === opener) depth++;
		else if (masked[index] === closer && --depth === 0) return masked.slice(open, index + 1);
	}
	return masked.slice(open);
}

function insideSpans(opener: RegExp, inner: RegExp): Finder {
	return function* (masked) {
		for (const start of masked.matchAll(opener)) {
			const open = start.index + start[0].length - 1;
			for (const hit of spanAt(masked, open).matchAll(inner)) yield open + hit.index;
		}
	};
}

function codeLevelFindings(context: FileContext): Finding[] {
	const patterns = CODE_PATTERNS.filter(pattern => pattern.grammars.includes(context.language.grammar) && (!pattern.callForm || context.testFile));
	if (patterns.length === 0) return [];
	const masked = decoder.decode(context.maskedBytes);
	const starts = lineStartsOf(masked);
	const classesByLine = new Map<number, Set<CodePattern["class"]>>();
	for (const pattern of patterns) {
		for (const index of pattern.find(masked)) {
			const line = lineIndexOf(starts, index);
			if (!context.added.has(line)) continue;
			const classes = classesByLine.get(line) ?? new Set<CodePattern["class"]>();
			classes.add(pattern.class);
			classesByLine.set(line, classes);
		}
	}
	const findings: Finding[] = [];
	for (const [line, classes] of [...classesByLine].sort((left, right) => left[0] - right[0])) {
		if (lineCarried(context, line)) continue;
		for (const cls of classes) findings.push(makeFinding(cls, context.file, line, rawLine(context, line)));
	}
	return findings;
}

function commentScan(context: FileContext): Verdicts {
	const scan: Verdicts = { findings: [], accepted: [] };
	for (const comment of context.comments) {
		const line = firstAddedLine(comment, context.added);
		if (line === undefined) continue;
		const verdict = classifyComment(context, comment);
		if (verdict === "accepted") scan.accepted.push({ file: context.file, line, text: shortened(commentBody(comment.text)) });
		else if (verdict !== undefined) scan.findings.push(makeFinding(verdict, context.file, line, portionOn(context, comment, line)));
	}
	return scan;
}

function analyzeFile(context: FileContext): Verdicts {
	const seen = new Set<string>();
	const comments = commentScan(context);
	const findings = [...comments.findings, ...codeLevelFindings(context)].filter(item => {
		const key = `${item.line}:${item.class}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { findings, accepted: comments.accepted };
}

function withinBudget<T extends { file: string }>(input: EscapeInput, candidates: readonly T[], budget: number): { targets: T[]; beyond: string[] } {
	const targets: T[] = [];
	const beyond: string[] = [];
	let used = 0;
	for (const candidate of candidates) {
		const length = regularFileSize(join(input.repo, candidate.file)) ?? 0;
		const size = length > MAX_SCANNED_BYTES ? 0 : length;
		if (used + size > budget) beyond.push(candidate.file);
		else {
			used += size;
			targets.push(candidate);
		}
	}
	return { targets, beyond };
}

async function codeScan(input: EscapeInput, scope: Scope, budget: number): Promise<EscapeScan> {
	const candidates = scope.files.flatMap(file => {
		const language = LANGUAGE_BY_EXTENSION.get(extname(file).slice(1).toLowerCase());
		return language === undefined ? [] : [{ file, language }];
	});
	const { targets, beyond } = withinBudget(input, candidates, budget);
	const measured = await runAll(targets, MEASURE_CONCURRENCY, input.signal, ({ file }, signal) => measure({ ...input, signal }, file, scope.edited(file)));
	const changes = new Map<string, Change>();
	const scanned: Scanned[] = [];
	const unscanned: string[] = [...beyond];
	targets.forEach((target, index) => {
		const result = measured[index];
		if (result.kind === "skipped") return;
		if (result.change !== undefined) changes.set(target.file, result.change);
		if (result.kind === "unreadable") unscanned.push(target.file);
		else if (result.change.added.size > 0) scanned.push({ ...target, change: result.change });
	});
	const nodes = await scanNodes(input, scanned);
	const pool = buildPool(changes);
	const scan: EscapeScan = { findings: [], accepted: [], unscanned };
	for (const { file, language, change } of scanned) {
		const context = createContext(file, language, readFileSync(join(input.repo, file)), nodes.get(file) ?? [], change, pool);
		if (change.removedLines.size > 0 && hasRefusedAddedComment(context)) context.removedComments = await removedCommentsOf(input, context);
		const analyzed = analyzeFile(context);
		scan.findings.push(...analyzed.findings);
		scan.accepted.push(...analyzed.accepted);
	}
	return scan;
}

/**
 * The findings the anti-escape scan would raise if every line of `files` (repo-relative paths under `repo`) were newly added.
 * It needs no git base: each file is judged by the same classifier as a change that adds all of it.
 */
export async function wholeFileFindings(repo: string, files: readonly string[], signal?: AbortSignal): Promise<Finding[]> {
	const input: EscapeInput = { repo, base: "", files: [...files], baseText: async () => "", signal };
	return (await codeScan(input, { files: [...files], edited: () => true }, Number.POSITIVE_INFINITY)).findings;
}

function classRank(name: string): number {
	const rank = CLASS_ORDER.indexOf(name);
	return rank === -1 ? CLASS_ORDER.length : rank;
}

/**
 * The lines a session added since its base point: findings for new comments, suppressions, skipped tests,
 * and weakened gates, plus the accepted why comments and the changed source files that could not be read.
 * `input.files` are repo-relative paths the session changed. Aborting `input.signal` kills every child
 * process and rejects; so does a git child that runs past 20 s or an ast-grep child that runs past 30 s
 * (DONE_GATE_ESCAPE_GIT_TIMEOUT_MS and DONE_GATE_ESCAPE_AST_GREP_TIMEOUT_MS lower those limits).
 */
export async function escapeScan(input: EscapeInput): Promise<EscapeScan> {
	input.signal?.throwIfAborted();
	await requireBase(input);
	const scope = scopeOf(input);
	const stages = [
		async (scoped: EscapeInput): Promise<EscapeScan> => ({ findings: await gateFileFindings(scoped, scope.files), accepted: [], unscanned: [] }),
		(scoped: EscapeInput): Promise<EscapeScan> => codeScan(scoped, scope, loweredLimit("DONE_GATE_ESCAPE_MAX_SCAN_BYTES", MAX_TOTAL_SCANNED_BYTES)),
	];
	const parts = await runAll(stages, stages.length, input.signal, (stage, signal) => stage({ ...input, signal }));
	input.signal?.throwIfAborted();
	const findings = parts
		.flatMap(part => part.findings)
		.sort((left, right) => (left.file ?? "").localeCompare(right.file ?? "", "en") || (left.line ?? 0) - (right.line ?? 0) || classRank(left.class) - classRank(right.class));
	const accepted = parts.flatMap(part => part.accepted).sort((left, right) => left.file.localeCompare(right.file, "en") || left.line - right.line);
	const unscanned = parts.flatMap(part => part.unscanned).sort((left, right) => left.localeCompare(right, "en"));
	return { findings, accepted, unscanned };
}

/** The findings of `escapeScan`. */
export async function escapeFindings(input: EscapeInput): Promise<Finding[]> {
	return (await escapeScan(input)).findings;
}

function rowOf(item: Finding): string {
	const where = item.file === undefined ? "" : item.line === undefined ? item.file : `${item.file}:${item.line}`;
	return [where, item.text ?? ""].filter(part => part !== "").join("  ");
}

/** One block per finding class: the guidance once, then `file:line  text` rows (at most 20 per class). */
export function formatFindings(findings: Finding[]): string {
	const byClass = new Map<string, Finding[]>();
	for (const item of findings) pushTo(byClass, item.class, item);
	const blocks: string[] = [];
	for (const group of byClass.values()) {
		const rows = group.map(rowOf).filter(row => row !== "");
		const lines = [...new Set(group.map(item => item.message)), ...rows.slice(0, MAX_ROWS_PER_CLASS)];
		if (rows.length > MAX_ROWS_PER_CLASS) lines.push(`... and ${rows.length - MAX_ROWS_PER_CLASS} more`);
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n\n");
}
