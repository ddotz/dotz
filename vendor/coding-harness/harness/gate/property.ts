import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { baseTextOf, git, propertyOf, run, runAll } from "./escape-common.ts";
import { hasGeneratedMarker, SKIPPED_SEGMENTS } from "./escape.ts";
import { AST_GREP, type Finding, type TextAt } from "./types.ts";

/** What the round-trip scan is given. Paths are repo-relative. */
export interface PropertyInput {
	repo: string;
	/** Commit the run started from; the fallback source of a file's base text. */
	base: string;
	/** Files the session changed. */
	files: string[];
	/** Text of a file at the session's base point. Absent or `undefined` result: `git show <base>:<file>`. */
	baseText?: TextAt;
	/** Files a tool edited, as opposed to a build step or a bash command. A generated or vendored file is skipped unless it is in this set. Absent: every file counts. */
	toolEdited?: ReadonlySet<string>;
	/** Aborting it ends the scan: child processes are killed and the call rejects. */
	signal?: AbortSignal;
}

interface Row {
	first: string;
	second: string;
	remainderRequired?: boolean;
	inverseFirst?: boolean;
}

interface Definition {
	name: string;
	line: number;
	text: string;
}

interface Match<T> {
	row: Row;
	first: T;
	second: T;
}

interface Pair extends Match<Definition> {
	file: string;
	isNew: boolean;
}

interface Target {
	file: string;
	grammar: string;
}

interface Found {
	name: string;
	line: number;
	start: number;
	end: number;
}

const ROWS: readonly Row[] = [
	{ first: "encode", second: "decode" },
	{ first: "serialize", second: "deserialize" },
	{ first: "serialise", second: "deserialise" },
	{ first: "marshal", second: "unmarshal" },
	{ first: "pack", second: "unpack" },
	{ first: "compress", second: "decompress" },
	{ first: "encrypt", second: "decrypt" },
	{ first: "parse", second: "stringify", inverseFirst: true },
	{ first: "parse", second: "serialize", inverseFirst: true },
	{ first: "parse", second: "format", inverseFirst: true },
	{ first: "dump", second: "load" },
	{ first: "dumps", second: "loads" },
	{ first: "to", second: "from", remainderRequired: true },
];

const PREFIXES = [...new Set(ROWS.flatMap(row => [row.first, row.second]))];
const NAME_CHAR = String.raw`[\p{L}\p{N}_$]`;
const CANDIDATE = new RegExp(String.raw`(?<!${NAME_CHAR})(?:${PREFIXES.join("|")})${NAME_CHAR}*`, "gu");
const REMAINDER = /^(?:_[\p{L}\p{N}_$]|\p{Lu})/u;
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const MARKER = /fast-check|fc\.assert|fc\.property|hypothesis|@given/;
const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "requirements-dev.txt"];
const MANIFEST_MARKER = /fast-check|hypothesis/;
const TEST_DIRECTORY = /^(?:tests?|__tests__)$/;
const TEST_NAME = /\.(?:test|spec)\.|_test\.py$|^test_.*\.py$/;
const AST_GREP_SUPPRESSION = Buffer.from("ast-grep-ignore");
const AST_GREP_TIMEOUT_MS = 30_000;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_TEST_BYTES = 1024 * 1024;
const SCAN_CONCURRENCY = 8;
const READ_BATCH = 32;

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

const NAMED = { has: { field: "name", pattern: "$NAME" } };
const SCRIPT_TOP_LEVEL = { not: { inside: { stopBy: "end", not: { any: [{ kind: "program" }, { kind: "export_statement" }] } } } };
const SCRIPT_DECLARATION = {
	id: "property-function",
	rule: { all: [{ any: [{ kind: "function_declaration" }, { kind: "generator_function_declaration" }] }, NAMED, SCRIPT_TOP_LEVEL] },
};
const SCRIPT_CONSTANT = {
	id: "property-const-function",
	rule: {
		all: [
			{ kind: "variable_declarator" },
			{ has: { field: "name", kind: "identifier", pattern: "$NAME" } },
			{ has: { field: "value", any: [{ kind: "arrow_function" }, { kind: "function_expression" }, { kind: "generator_function" }] } },
			{ inside: { kind: "lexical_declaration", has: { field: "kind", regex: "^const$" } } },
			{ not: { inside: { stopBy: "end", not: { any: [{ kind: "program" }, { kind: "export_statement" }, { kind: "lexical_declaration" }] } } } },
		],
	},
};
const PYTHON_TOP_LEVEL = { not: { inside: { stopBy: "end", not: { kind: "module" } } } };
const PYTHON_FUNCTION = {
	id: "property-python-function",
	rule: {
		any: [
			{ all: [{ kind: "function_definition" }, NAMED, PYTHON_TOP_LEVEL] },
			{ all: [{ kind: "decorated_definition" }, { has: { field: "definition", kind: "function_definition", ...NAMED } }, PYTHON_TOP_LEVEL] },
		],
	},
};

function rulesOf(grammar: string): string {
	const documents = grammar === "python" ? [PYTHON_FUNCTION] : [SCRIPT_DECLARATION, SCRIPT_CONSTANT];
	return documents.map(document => JSON.stringify({ ...document, language: grammar, severity: "hint" })).join("\n---\n");
}

function isTestFile(file: string): boolean {
	const segments = file.split("/");
	return TEST_NAME.test(segments[segments.length - 1]) || segments.slice(0, -1).some(segment => TEST_DIRECTORY.test(segment));
}

function pathOf(raw: string): string | undefined {
	const file = raw.replaceAll("\\", "/").replace(/^\.\//, "");
	return file !== "" && !file.startsWith("/") && !file.split("/").includes("..") ? file : undefined;
}

function targetsOf(files: readonly string[], edited: (file: string) => boolean, includeTests = false): Target[] {
	const kept = new Set<string>();
	for (const raw of files) {
		const file = pathOf(raw);
		if (file === undefined || (!includeTests && isTestFile(file))) continue;
		if (edited(file) || !file.split("/").some(segment => SKIPPED_SEGMENTS.has(segment))) kept.add(file);
	}
	return [...kept].sort().flatMap(file => {
		const extension = extname(file).slice(1);
		return Object.hasOwn(GRAMMARS, extension) ? [{ file, grammar: GRAMMARS[extension] }] : [];
	});
}

function normalized(text: string): string {
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	return body.includes("\r\n") ? body.replaceAll("\r\n", "\n") : body;
}

function candidates(text: string): Map<string, string> {
	const names = new Map<string, string>();
	for (const [name] of text.matchAll(CANDIDATE)) names.set(name, name);
	return names;
}

function pairsAmong<T>(named: ReadonlyMap<string, T>): Match<T>[] {
	const found: Match<T>[] = [];
	for (const row of ROWS) {
		for (const [name, first] of named) {
			if (!name.startsWith(row.first)) continue;
			const remainder = name.slice(row.first.length);
			const joined = remainder === "" ? row.remainderRequired !== true : REMAINDER.test(remainder);
			const second = joined ? named.get(row.second + remainder) : undefined;
			if (second !== undefined) found.push({ row, first, second });
		}
	}
	return found;
}

function defused(bytes: Buffer): Buffer {
	let at = bytes.indexOf(AST_GREP_SUPPRESSION);
	if (at === -1) return bytes;
	const copy = Buffer.from(bytes);
	for (; at !== -1; at = copy.indexOf(AST_GREP_SUPPRESSION, at + 1)) copy[at] ^= 0x20;
	return copy;
}

function parseMatch(line: string): Found | undefined {
	if (!line.startsWith("{")) return undefined;
	const match: unknown = JSON.parse(line);
	const variable = propertyOf(propertyOf(propertyOf(match, "metaVariables"), "single"), "NAME");
	const name = propertyOf(variable, "text");
	const row = propertyOf(propertyOf(propertyOf(variable, "range"), "start"), "line");
	const offsets = propertyOf(propertyOf(match, "range"), "byteOffset");
	const start = propertyOf(offsets, "start");
	const end = propertyOf(offsets, "end");
	if (typeof name !== "string" || typeof row !== "number" || typeof start !== "number" || typeof end !== "number") return undefined;
	return { name, line: row + 1, start, end };
}

async function definitionsOf(grammar: string, text: string, signal: AbortSignal | undefined): Promise<Map<string, Definition>> {
	const bytes = Buffer.from(text);
	const args = [AST_GREP, "scan", "--inline-rules", rulesOf(grammar), "--json=stream", "--stdin"];
	const result = await run(args, tmpdir(), { timeoutMs: AST_GREP_TIMEOUT_MS, signal, stdin: defused(bytes) });
	if (result.code !== 0) throw new Error(`property: ast-grep failed on ${grammar} source (exit ${result.code}): ${result.err.slice(0, 300)}`);
	const matches = result.out.split("\n").flatMap(line => parseMatch(line) ?? []);
	const definitions = new Map<string, Definition>();
	for (const match of matches.sort((a, b) => a.start - b.start)) {
		const source = bytes.subarray(match.start, match.end).toString();
		const known = definitions.get(match.name);
		if (known === undefined) definitions.set(match.name, { name: match.name, line: match.line, text: source });
		else known.text += `\n${source}`;
	}
	return definitions;
}

async function definitionsBefore(input: PropertyInput, target: Target, text: string, now: Map<string, Definition>): Promise<ReadonlyMap<string, Definition> | null> {
	const base = await baseTextOf(input, target.file);
	if (base === null) return null;
	const before = normalized(base);
	return before === text ? now : definitionsOf(target.grammar, before, input.signal);
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

async function definitionsOfBases(input: PropertyInput): Promise<ReadonlyMap<string, Definition>[]> {
	const found = await runAll(targetsOf(input.files, () => true, true), SCAN_CONCURRENCY, input.signal, async (target, signal) => {
		const base = await baseTextOf({ ...input, signal }, target.file);
		return base === null ? [] : [await definitionsOf(target.grammar, normalized(base), signal)];
	});
	return found.flat();
}

const QUOTES = new Set(['"', "'", "`"]);
const CLOSERS = new Set([")", "]", "}"]);

function indentLevels(text: string): string {
	const lines = text.split("\n");
	const width = (line: string) => line.length - line.trimStart().length;
	const widths = [...new Set(lines.slice(1).filter(line => line.trim() !== "").map(width))].sort((a, b) => a - b);
	return [lines[0], ...lines.slice(1).map(line => (line.trim() === "" ? "" : `${"\t".repeat(widths.indexOf(width(line)) + 1)}${line.trimStart()}`))].join("\n");
}

/** Function text with what a formatter may change removed: comments, and whitespace outside quotes (outside Python also semicolons and a comma before a closing bracket); whitespace inside quotes stays, and in Python so does each line's nesting (its indentation's rank among the function's indentations, so a change of indent width is not a change). A `'` or `"` quote ends at the line's end, so a stray quote (in a regular expression) cannot swallow the rest. */
export function tokens(text: string, python: boolean): string {
	const body = python ? indentLevels(text) : text;
	let out = "";
	let quote: string | undefined;
	for (let i = 0; i < body.length; i++) {
		const char = body.charAt(i);
		if (quote !== undefined && !(char === "\n" && quote !== "`")) {
			out += char;
			if (char === "\\") out += body.charAt(++i);
			else if (char === quote) quote = undefined;
			continue;
		}
		quote = undefined;
		const comment = python ? char === "#" : char === "/" && body.charAt(i + 1) === "/";
		if (comment) {
			while (i + 1 < body.length && body.charAt(i + 1) !== "\n") i++;
		} else if (!python && char === "/" && body.charAt(i + 1) === "*") {
			const end = body.indexOf("*/", i + 2);
			i = end === -1 ? body.length : end + 1;
		} else if (QUOTES.has(char)) {
			quote = char;
			out += char;
		} else if (python && char === "\n") {
			let end = i + 1;
			while (body.charAt(end) === " " || body.charAt(end) === "\t") end++;
			if (!out.endsWith("\n")) out += "\n";
			if (end < body.length && body.charAt(end) !== "\n") out += body.slice(i + 1, end);
			i = end - 1;
		} else if (!python && char === ";") {
			continue;
		} else if (!python && CLOSERS.has(char) && out.endsWith(",")) {
			out = `${out.slice(0, -1)}${char}`;
		} else if (!/\s/.test(char)) out += char;
	}
	return out;
}

async function changedPairs(input: PropertyInput, target: Target, edited: boolean, baseDefinitions: () => Promise<ReadonlyMap<string, Definition>[]>): Promise<Pair[]> {
	const path = join(input.repo, target.file);
	const size = regularFileSize(path);
	if (size === undefined || size > MAX_SOURCE_BYTES) return [];
	const raw = readFileSync(path, "utf8");
	if (!edited && hasGeneratedMarker(raw)) return [];
	const text = normalized(raw);
	if (pairsAmong(candidates(text)).length === 0) return [];
	const now = await definitionsOf(target.grammar, text, input.signal);
	const matches = pairsAmong(now);
	if (matches.length === 0) return [];
	const before = await definitionsBefore(input, target, text, now);
	const python = target.grammar === "python";
	const kept = (definition: Definition, bases: readonly (ReadonlyMap<string, Definition> | null)[]) =>
		bases.some(base => {
			const old = base?.get(definition.name)?.text;
			return old !== undefined && tokens(old, python) === tokens(definition.text, python);
		});
	const changed: Pair[] = [];
	for (const match of matches) {
		const pair = [match.first, match.second];
		if (pair.every(definition => kept(definition, [before]))) continue;
		const bases = [before, ...(await baseDefinitions())];
		if (pair.every(definition => kept(definition, bases))) continue;
		const isNew = !pair.every(definition => bases.some(base => base?.has(definition.name) === true));
		changed.push({ ...match, file: target.file, isNew });
	}
	return changed.sort((a, b) => a.first.line - b.first.line);
}

function wordPattern(name: string): RegExp {
	return new RegExp(String.raw`(?<!${NAME_CHAR})${name.replace(REGEXP_SPECIALS, "\\$&")}(?!${NAME_CHAR})`, "u");
}

async function testText(path: string): Promise<string | undefined> {
	const size = regularFileSize(path);
	return size !== undefined && size <= MAX_TEST_BYTES ? readFile(path, "utf8") : undefined;
}

async function uncovered(input: PropertyInput, pairs: readonly Pair[]): Promise<{ open: Pair[]; tooling: boolean }> {
	const listing = await git(input.repo, ["ls-files", "-co", "--exclude-standard", "-z"], input.signal);
	if (listing.code !== 0) throw new Error(`property: git ls-files failed in ${input.repo}: ${listing.err.trim().slice(0, 300)}`);
	const tests = [...new Set(listing.out.split("\0").filter(file => file !== "" && isTestFile(file)))];
	let open = pairs.map(pair => ({ pair, first: wordPattern(pair.first.name), second: wordPattern(pair.second.name) }));
	let tooling = false;
	for (let start = 0; start < tests.length && open.length > 0; start += READ_BATCH) {
		input.signal?.throwIfAborted();
		const texts = await Promise.all(tests.slice(start, start + READ_BATCH).map(file => testText(join(input.repo, file))));
		for (const text of texts) {
			if (text === undefined || !MARKER.test(text)) continue;
			tooling = true;
			open = open.filter(({ first, second }) => !(first.test(text) && second.test(text)));
		}
	}
	if (!tooling && open.length > 0) {
		const manifests = await Promise.all(MANIFESTS.map(name => testText(join(input.repo, name))));
		tooling = manifests.some(text => text !== undefined && MANIFEST_MARKER.test(text));
	}
	return { open: open.map(({ pair }) => pair), tooling };
}

function findingOf(pair: Pair): Finding {
	const { first, second } = pair;
	const [forward, inverse] = pair.row.inverseFirst === true ? [second.name, first.name] : [first.name, second.name];
	return {
		stage: "defaults",
		class: "roundtrip-without-property",
		file: pair.file,
		line: first.line,
		message: `\`${first.name}\` and \`${second.name}\` in ${pair.file} are a round-trip pair you changed, and no property test covers them. Add one that asserts ${inverse}(${forward}(v)) equals v for generated v (TypeScript/JavaScript: fast-check, \`bun add -d fast-check\`; Python: hypothesis).`,
	};
}

/**
 * Round-trip pairs the session changed that no property test in the repo covers. A pair is two top-level functions of one
 * changed TypeScript, JavaScript or Python file whose names are the two prefixes of one row of the pair table (`encode` and
 * `decode`, `to` and `from`, ...) followed by the same remainder, and it counts as changed when the text of either function
 * differs from the file's base text or the file is new. A test file of the repo (tracked, or untracked and not ignored)
 * covers a pair when it names both functions as whole words and holds a property-testing marker. A pair whose two functions
 * both existed at the base is reported only in a repo that already has property tests (a test file with a marker, or
 * fast-check or hypothesis named in a root manifest), so a fix of existing code never asks for a new dependency. Test files
 * are never scanned for pairs; a source file over 10 MiB and a test file over 1 MiB are not read. Aborting `signal` kills
 * every child process and rejects with its reason.
 */
export async function propertyScan(input: PropertyInput): Promise<Finding[]> {
	input.signal?.throwIfAborted();
	const toolEdited = input.toolEdited === undefined ? undefined : new Set([...input.toolEdited].map(file => pathOf(file) ?? file));
	const edited = (file: string): boolean => toolEdited === undefined || toolEdited.has(file);
	let bases: Promise<ReadonlyMap<string, Definition>[]> | undefined;
	const baseDefinitions = (): Promise<ReadonlyMap<string, Definition>[]> => {
		bases ??= definitionsOfBases(input);
		return bases;
	};
	const scanned = await runAll(targetsOf(input.files, edited), SCAN_CONCURRENCY, input.signal, (target, signal) =>
		changedPairs({ ...input, signal }, target, edited(target.file), baseDefinitions),
	);
	const changed = scanned.flat();
	if (changed.length === 0) return [];
	const { open, tooling } = await uncovered(input, changed);
	return open.filter(pair => tooling || pair.isNew).map(findingOf);
}
