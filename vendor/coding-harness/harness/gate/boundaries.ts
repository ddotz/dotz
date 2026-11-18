import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, posix, resolve } from "node:path";
import { adoptRule, runBounded } from "./rules.ts";
import { git } from "./snapshot.ts";
import { AST_GREP } from "./types.ts";
import { isRecord, message } from "./util.ts";

type Language = "TypeScript" | "Tsx" | "JavaScript";

interface Group {
	dir: string;
	root: string;
	files: string[];
}

interface Layout {
	groups: Group[];
	groupOf: Map<string, string>;
}

interface Import {
	raw: string;
	spec: string;
}

interface Graph {
	imports: Map<string, Set<string>>;
	importers: Map<string, Set<string>>;
}

interface Candidate {
	id: string;
	from: Group;
	to: Group;
	importedBy: string[];
	via: string[];
	sibling: Group | undefined;
	regex: string;
}

/** A boundary rule drafted from the import graph, with its test: `rule` and `test` are the YAML texts written to `.omp/lint/drafts/<id>.yml` and `<id>-test.yml`. `importedBy` are the other directories whose files import `to` today. */
export interface BoundaryDraft {
	id: string;
	from: string;
	to: string;
	importedBy: string[];
	message: string;
	rule: string;
	test: string;
}

/** What drafting would do: `drafts` are the new drafts (ranked, within the cap), `kept` the ids of the drafts already in `.omp/lint/drafts`. */
export interface DraftPlan {
	sources: number;
	groups: number;
	roots: number;
	drafts: BoundaryDraft[];
	kept: string[];
}

/** What a command does: `list` shows the drafts (drafting first when there are none), `draft` drafts and shows them (`dryRun` writes nothing), `accept` and `reject` act on one draft. */
export type BoundariesAction = { kind: "list" } | { kind: "draft"; dryRun: boolean } | { kind: "accept"; id: string } | { kind: "reject"; id: string };

/** The result of a command: `ok` is false when it refused or failed, and `message` says what happened. */
export interface Outcome {
	ok: boolean;
	message: string;
}

const GUIDANCE = "Only the user accepts a draft: /gate-boundaries accept <id> moves it into the rule kit and adopts it, /gate-boundaries reject <id> drops it for good.";
const DRAFTED_NOTE = " Drafted from the import graph; it matches relative imports only.";
const MIN_FILES = 5;
const MAX_DRAFTS = 20;
const CONTAINERS = ["src", "lib", "app"];
const MANIFEST = /^(package\.json|jsconfig\.json|tsconfig(\..+)?\.json)$/;
const SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9._@-]*$/;
const LANGUAGE_OF: Record<string, Language> = { ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".tsx": "Tsx", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript" };
const LANGUAGES: Language[] = ["TypeScript", "Tsx", "JavaScript"];
const SUFFIXES = [...Object.keys(LANGUAGE_OF), ".d.ts"];
const SEARCH_EVERYWHERE = ["hidden", "dot", "exclude", "global", "parent", "vcs"].flatMap(kind => ["--no-ignore", kind]);
const CHUNK_FILES = 400;
const CHUNK_BYTES = 80_000;
const NAMED_GROUPS = 3;
const ID_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BOOTSTRAP = join(import.meta.dir, "bootstrap.ts");

const lintDir = (repo: string): string => join(repo, ".omp", "lint");
const draftsDir = (repo: string): string => join(lintDir(repo), "drafts");
const hasKit = (repo: string): boolean => existsSync(join(lintDir(repo), "sgconfig.yml"));
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

function importForms(language: Language): string {
	const forms = [
		["kind: import_statement", "has:", "  field: source", "  pattern: $SOURCE"],
		["kind: export_statement", "has:", "  field: source", "  pattern: $SOURCE"],
		["pattern: import($SOURCE)"],
		["pattern: require($SOURCE)"],
	];
	if (language !== "JavaScript") forms.push(["kind: import_require_clause", "has:", "  field: source", "  pattern: $SOURCE"]);
	return forms.map(([first, ...rest]) => [`    - ${first}`, ...rest.map(line => `      ${line}`)].join("\n")).join("\n");
}

const READER_RULES = LANGUAGES.map(language => `id: imports-${language.toLowerCase()}\nlanguage: ${language}\nrule:\n  any:\n${importForms(language)}\n`).join("---\n");

async function trackedSources(repo: string, signal?: AbortSignal): Promise<{ sources: string[]; manifests: string[] }> {
	const tracked = (await git(repo, ["ls-files", "-z"], signal)).split("\0").filter(Boolean);
	const manifests = [...new Set(tracked.filter(path => MANIFEST.test(posix.basename(path))).map(path => posix.dirname(path)))].map(dir => (dir === "." ? "" : dir));
	const sources = tracked.filter(path => {
		if (LANGUAGE_OF[extname(path)] === undefined || path.split("/").includes("node_modules")) return false;
		try {
			return lstatSync(join(repo, path)).isFile();
		} catch {
			return false;
		}
	});
	return { sources: sources.sort(byText), manifests };
}

function nearestRoot(file: string, manifests: ReadonlySet<string>): string {
	for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) if (manifests.has(dir)) return dir;
	return "";
}

function groupDir(file: string, root: string, manifests: readonly string[]): string | undefined {
	const dirs = (root === "" ? file : file.slice(root.length + 1)).split("/").slice(0, -1);
	const transparent = (depth: number): boolean => {
		const dir = posix.join(root, ...dirs.slice(0, depth));
		return (depth === 1 && CONTAINERS.includes(dirs[0])) || manifests.some(manifest => manifest.startsWith(`${dir}/`));
	};
	let depth = 1;
	while (depth <= dirs.length && transparent(depth)) depth++;
	if (depth > dirs.length) return undefined;
	const dir = posix.join(root, ...dirs.slice(0, depth));
	return dir.split("/").every(segment => SEGMENT.test(segment)) ? dir : undefined;
}

function layoutOf(sources: string[], manifests: string[]): Layout {
	const roots = new Set(manifests);
	const groups = new Map<string, Group>();
	const groupOf = new Map<string, string>();
	for (const file of sources) {
		const root = nearestRoot(file, roots);
		const dir = groupDir(file, root, manifests);
		if (dir === undefined) continue;
		const group = groups.get(dir) ?? { dir, root, files: [] };
		group.files.push(file);
		groups.set(dir, group);
		groupOf.set(file, dir);
	}
	return { groups: [...groups.values()].sort((a, b) => byText(a.dir, b.dir)), groupOf };
}

function chunked(files: string[]): string[][] {
	const chunks: string[][] = [];
	let bytes = 0;
	for (const file of files) {
		const last = chunks.at(-1);
		if (last === undefined || last.length >= CHUNK_FILES || bytes + file.length > CHUNK_BYTES) {
			chunks.push([file]);
			bytes = file.length;
		} else {
			last.push(file);
			bytes += file.length + 1;
		}
	}
	return chunks;
}

function specOf(raw: string): string | undefined {
	const quote = raw[0];
	if (raw.length < 2 || raw.at(-1) !== quote || !["\"", "'", "`"].includes(quote)) return undefined;
	const text = raw.slice(1, -1);
	return quote === "`" && text.includes("${") ? undefined : text;
}

function matchOf(line: string): { file: string; raw: string } | undefined {
	const item: unknown = JSON.parse(line);
	if (!isRecord(item) || typeof item.file !== "string" || !isRecord(item.metaVariables) || !isRecord(item.metaVariables.single)) return undefined;
	const source = item.metaVariables.single.SOURCE;
	return isRecord(source) && typeof source.text === "string" ? { file: item.file.replace(/^\.\//, ""), raw: source.text } : undefined;
}

async function readImports(repo: string, files: string[], signal?: AbortSignal): Promise<Map<string, Import[]>> {
	const found = new Map<string, Import[]>(files.map(file => [file, []]));
	for (const chunk of chunked(files)) {
		const result = await runBounded([AST_GREP, "scan", "--inline-rules", READER_RULES, "--json=stream", "--color", "never", ...SEARCH_EVERYWHERE, ...chunk], repo, { signal });
		if (result.timedOut || result.code !== 0) throw new Error(`ast-grep could not read the imports: ${result.timedOut ? "it did not finish in time" : result.err.trim().split("\n").slice(-5).join("\n")}`);
		for (const line of result.out.split("\n")) {
			const match = line.trim() === "" ? undefined : matchOf(line);
			const spec = match === undefined ? undefined : specOf(match.raw);
			if (match !== undefined && spec !== undefined) found.get(match.file)?.push({ raw: match.raw, spec });
		}
	}
	return found;
}

function resolveImport(from: string, spec: string, tracked: ReadonlySet<string>): string | undefined {
	if (!spec.startsWith(".")) return undefined;
	const target = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\/+$/, "");
	if (target === ".." || target.startsWith("../")) return undefined;
	const stems = [target, target.replace(/\.[cm]?jsx?$/, "")];
	const candidates = [target, ...stems.flatMap(stem => SUFFIXES.map(suffix => stem + suffix)), ...SUFFIXES.map(suffix => `${target}/index${suffix}`)];
	return candidates.find(candidate => tracked.has(candidate));
}

function graphOf(layout: Layout, specs: Map<string, Import[]>): Graph {
	const tracked = new Set(layout.groupOf.keys());
	const imports = new Map<string, Set<string>>();
	const importers = new Map<string, Set<string>>();
	for (const [file, found] of specs) {
		const from = layout.groupOf.get(file);
		if (from === undefined) continue;
		for (const { spec } of found) {
			const target = resolveImport(file, spec, tracked);
			const to = target === undefined ? undefined : layout.groupOf.get(target);
			if (to === undefined || to === from) continue;
			imports.set(from, (imports.get(from) ?? new Set()).add(to));
			importers.set(to, (importers.get(to) ?? new Set()).add(from));
		}
	}
	return { imports, importers };
}

function importPattern(from: string, to: string): string {
	const a = from.split("/");
	const b = to.split("/");
	let common = 0;
	while (common < a.length - 1 && common < b.length - 1 && a[common] === b[common]) common++;
	return `^["'](\\.\\./){${a.length - common},}${b.slice(common).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")}(/|["'])`;
}

function candidatesOf(layout: Layout, graph: Graph, specs: Map<string, Import[]>): Candidate[] {
	const found: Candidate[] = [];
	const byDir = new Map(layout.groups.map(group => [group.dir, group]));
	for (const to of layout.groups) {
		for (const from of layout.groups) {
			if (from === to || from.root !== to.root || from.files.length < MIN_FILES || to.files.length < MIN_FILES) continue;
			const imported = graph.imports.get(from.dir) ?? new Set<string>();
			const importedBy = [...(graph.importers.get(to.dir) ?? [])].sort(byText);
			const regex = importPattern(from.dir, to.dir);
			if (imported.has(to.dir) || importedBy.length === 0) continue;
			const pattern = new RegExp(regex);
			if (from.files.some(file => (specs.get(file) ?? []).some(({ raw }) => pattern.test(raw)))) continue;
			const via = importedBy.filter(dir => imported.has(dir));
			const siblings = [...via, ...[...imported].sort(byText)].map(dir => byDir.get(dir)).filter(group => group !== undefined && group.root === from.root);
			const [fromSlug, toSlug] = [from.dir, to.dir].map(dir => dir.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
			found.push({ id: `boundary-${fromSlug}-not-${toSlug}`, from, to, importedBy, via, sibling: siblings[0], regex });
		}
	}
	found.sort((a, b) => b.importedBy.length - a.importedBy.length || byText(a.id, b.id));
	return found.filter((candidate, index) => found.findIndex(other => other.id === candidate.id) === index);
}

function languageOf(group: Group): Language {
	const counts = new Map<Language, number>();
	for (const file of group.files) counts.set(LANGUAGE_OF[extname(file)], (counts.get(LANGUAGE_OF[extname(file)]) ?? 0) + 1);
	return LANGUAGES.reduce((best, language) => ((counts.get(language) ?? 0) > (counts.get(best) ?? 0) ? language : best));
}

function moduleOf(group: Group): string {
	const first = [...group.files].sort((a, b) => a.split("/").length - b.split("/").length || byText(a, b))[0];
	return posix.relative(group.dir, first).replace(/(\.d)?\.[cm]?[jt]sx?$/, "");
}

function named(dirs: string[]): string {
	const shown = dirs.slice(0, NAMED_GROUPS).join(", ");
	return dirs.length > NAMED_GROUPS ? `${shown} and ${dirs.length - NAMED_GROUPS} more` : shown;
}

function messageOf(candidate: Candidate, language: Language): string {
	const { from, to, importedBy, via } = candidate;
	const verb = importedBy.length === 1 ? "does" : "do";
	const advice = via.length > 0 ? `Go through ${named(via)}, which ${from.dir} already imports.` : "Move what both need into a directory they may both import, or pass it in as an argument.";
	const other = from.files.filter(file => LANGUAGE_OF[extname(file)] !== language).length;
	const covered = other === 0 ? "" : ` It checks the ${language} files of ${from.dir} only; ${plural(other, "file")} in another language ${other === 1 ? "is" : "are"} not covered.`;
	return `Files under ${from.dir} may not import from ${to.dir}: no file under ${from.dir} does today, while ${named(importedBy)} ${verb}. ${advice}${covered}${DRAFTED_NOTE}`;
}

const scalar = (text: string): string => (/^[A-Za-z_][^:#\n]*$/.test(text) && !text.endsWith(" ") ? text : JSON.stringify(text));

function casesOf(candidate: Candidate, language: Language): { valid: string[]; invalid: string[] } {
	const rel = posix.relative(candidate.from.dir, candidate.to.dir);
	const target = `${rel}/${moduleOf(candidate.to)}`;
	const typed = language !== "JavaScript";
	const sibling = candidate.sibling === undefined ? [] : [`import { value } from "${posix.relative(candidate.from.dir, candidate.sibling.dir)}/${moduleOf(candidate.sibling)}";`];
	return {
		valid: [...sibling, 'import { value } from "./local";', `import { value } from "${rel}-other/${moduleOf(candidate.to)}";`],
		invalid: [
			`import { value } from "${target}";`,
			`import { value } from "../${target}";`,
			`import "${target}";`,
			`export * from "${target}";`,
			`const loaded = await import("${target}");`,
			`const loaded = require("${target}");`,
			...(typed ? [`import type { Value } from "${target}";`, `import loaded = require("${target}");`] : []),
		],
	};
}

function draftOf(candidate: Candidate, date: string): BoundaryDraft {
	const language = languageOf(candidate.from);
	const text = messageOf(candidate, language);
	const cases = casesOf(candidate, language);
	const rule = [
		`id: ${candidate.id}`,
		`language: ${language}`,
		"severity: error",
		`message: ${JSON.stringify(text)}`,
		"files:",
		`  - ${JSON.stringify(`${candidate.from.dir}/**`)}`,
		"rule:",
		"  any:",
		importForms(language),
		"constraints:",
		"  SOURCE:",
		`    regex: ${JSON.stringify(candidate.regex)}`,
		"metadata:",
		"  kind: boundary",
		`  origin: ${JSON.stringify(`drafted ${date} from the import graph`)}`,
		"",
	].join("\n");
	const test = [`id: ${candidate.id}`, "valid:", ...cases.valid.map(line => `  - ${scalar(line)}`), "invalid:", ...cases.invalid.map(line => `  - ${scalar(line)}`), ""].join("\n");
	return { id: candidate.id, from: candidate.from.dir, to: candidate.to.dir, importedBy: candidate.importedBy, message: text, rule, test };
}

function readRejected(repo: string): { ids: string[] } | { problem: string } {
	const file = join(draftsDir(repo), "rejected.json");
	if (!existsSync(file)) return { ids: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { problem: `.omp/lint/drafts/rejected.json does not parse: ${message(error)}` };
	}
	if (!Array.isArray(parsed) || !parsed.every((id): id is string => typeof id === "string")) return { problem: ".omp/lint/drafts/rejected.json must be an array of rule ids" };
	return { ids: parsed };
}

function draftIds(repo: string): string[] {
	const dir = draftsDir(repo);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(name => name.endsWith(".yml") && !name.endsWith("-test.yml"))
		.map(name => name.slice(0, -".yml".length))
		.sort(byText);
}

function messageOfDraft(repo: string, id: string): string {
	try {
		const rule: unknown = Bun.YAML.parse(readFileSync(join(draftsDir(repo), `${id}.yml`), "utf8"));
		return isRecord(rule) && typeof rule.message === "string" ? rule.message : "(unreadable draft)";
	} catch {
		return "(unreadable draft)";
	}
}

/**
 * Drafts boundary rules from the relative imports a repo has today, writing nothing. Tracked TS and JS files are grouped by
 * the first directory below their source root (the nearest ancestor directory holding a package.json or tsconfig, else the
 * repo root); `src`, `lib` and `app`, and a directory that holds a nested source root, are descended into so the group is
 * one level further down (`src/ui`). For every ordered pair of groups of one source root with at least 5 files each, where
 * no file of A imports B and some file of another group does, there is one draft `boundary-<a>-not-<b>`; a pair whose
 * rule would also match an import A makes today is left out. At most 20 drafts exist at once, ranked by how many other
 * groups import B. The rule is for A's dominant language and matches relative imports only. Ids already drafted, rejected
 * in `rejected.json` or active in `.omp/lint/rules` are not drafted again. Throws when git or ast-grep fails or
 * `rejected.json` is unreadable.
 */
export async function planDrafts(input: { repo: string; date?: string; signal?: AbortSignal }): Promise<DraftPlan> {
	const repo = resolve(input.repo);
	const date = input.date ?? new Date().toISOString().slice(0, 10);
	const rejected = readRejected(repo);
	if ("problem" in rejected) throw new Error(rejected.problem);
	const { sources, manifests } = await trackedSources(repo, input.signal);
	const layout = layoutOf(sources, manifests);
	const specs = await readImports(repo, [...layout.groupOf.keys()], input.signal);
	const kept = draftIds(repo);
	const taken = new Set([...kept, ...rejected.ids]);
	const fresh = candidatesOf(layout, graphOf(layout, specs), specs).filter(candidate => !taken.has(candidate.id) && !existsSync(join(lintDir(repo), "rules", `${candidate.id}.yml`)));
	const drafts = fresh.slice(0, Math.max(0, MAX_DRAFTS - kept.length)).map(candidate => draftOf(candidate, date));
	return { sources: layout.groupOf.size, groups: layout.groups.length, roots: new Set(layout.groups.map(group => group.root)).size, drafts, kept };
}

/** Writes the plan's drafts to `.omp/lint/drafts` (rule and test side by side) and returns the repo-relative paths; a draft already there is left as it is. Throws when the repo has no rule kit, because a bare `.omp/lint` would keep bootstrap from creating one. */
export function writeDrafts(input: { repo: string; plan: DraftPlan }): string[] {
	const repo = resolve(input.repo);
	if (!hasKit(repo)) throw new Error(`${repo} has no rule kit (.omp/lint/sgconfig.yml); run \`bun ${BOOTSTRAP} ${repo}\` first.`);
	const dir = draftsDir(repo);
	mkdirSync(dir, { recursive: true });
	const written: string[] = [];
	for (const draft of input.plan.drafts) {
		for (const [name, text] of [[`${draft.id}.yml`, draft.rule], [`${draft.id}-test.yml`, draft.test]]) {
			if (existsSync(join(dir, name))) continue;
			writeFileSync(join(dir, name), text);
			written.push(`.omp/lint/drafts/${name}`);
		}
	}
	return written;
}

/** The ids of the drafts in `<repo>/.omp/lint/drafts`, sorted. */
export function listDrafts(input: { repo: string }): string[] {
	return draftIds(resolve(input.repo));
}

function describeDrafts(drafts: { id: string; message: string }[]): string {
	return drafts.map(draft => `  ${draft.id}\n    ${draft.message.endsWith(DRAFTED_NOTE) ? draft.message.slice(0, -DRAFTED_NOTE.length) : draft.message}`).join("\n");
}

function listing(repo: string): string {
	const ids = draftIds(repo);
	return `${plural(ids.length, "boundary draft")} in ${draftsDir(repo)}, inactive until accepted:\n${describeDrafts(ids.map(id => ({ id, message: messageOfDraft(repo, id) })))}\n${GUIDANCE}`;
}

function summary(plan: DraftPlan): string {
	return `${plural(plan.sources, "source file")} in ${plural(plan.groups, "group")} of ${plural(plan.roots, "source root")}; ${plural(plan.kept.length, "draft")} already there`;
}

async function draftCommand(input: { repo: string; dryRun: boolean; date?: string; signal?: AbortSignal }): Promise<Outcome> {
	const { repo, dryRun } = input;
	const plan = await planDrafts(input);
	const found = plan.drafts.length === 0 ? "No new boundary qualifies." : `${plural(plan.drafts.length, "new draft")} would be written to ${draftsDir(repo)}:\n${describeDrafts(plan.drafts)}`;
	if (dryRun) return { ok: true, message: `--dry-run: nothing was written. ${summary(plan)}.\n${found}` };
	if (!hasKit(repo)) {
		return { ok: false, message: `Nothing was written: ${repo} has no rule kit (.omp/lint/sgconfig.yml), and a bare .omp/lint would keep bootstrap from creating one. Run \`bun ${BOOTSTRAP} ${repo}\` first. ${summary(plan)}.\n${found}` };
	}
	writeDrafts({ repo, plan });
	const head = `${summary(plan)}; ${plural(plan.drafts.length, "new draft")} written.`;
	return draftIds(repo).length === 0 ? { ok: true, message: `${head} No boundary qualifies: it takes two directories of at least ${MIN_FILES} files where one never imports the other and a third does.` } : { ok: true, message: `${head}\n${listing(repo)}` };
}

function draftFiles(repo: string, id: string): { rule: string; test: string } {
	return { rule: join(draftsDir(repo), `${id}.yml`), test: join(draftsDir(repo), `${id}-test.yml`) };
}

/**
 * Moves the draft `id` into `.omp/lint/rules` and `.omp/lint/tests` and adopts it with `adoptRule`, so its occurrences that
 * exist today are recorded and every new one is refused. Refuses, moving nothing, when the repo has no rule kit (the message
 * names bootstrap.ts), when the draft or its test is missing or does not carry its own id, when the kit already holds a rule
 * or test of that name, or when adoption fails (the kit is unsound, for instance).
 */
export async function acceptDraft(input: { repo: string; id: string }): Promise<Outcome> {
	const repo = resolve(input.repo);
	const { id } = input;
	if (!hasKit(repo)) return { ok: false, message: `${repo} has no rule kit (.omp/lint/sgconfig.yml), so nothing was moved. Run \`bun ${BOOTSTRAP} ${repo}\` to create it, then accept ${id} again.` };
	if (!ID_FORMAT.test(id)) return { ok: false, message: `${JSON.stringify(id)} is not a rule id; nothing was moved.` };
	const draft = draftFiles(repo, id);
	if (!existsSync(draft.rule) || !existsSync(draft.test)) return { ok: false, message: `No draft ${id} (rule and test) in ${draftsDir(repo)}; nothing was moved. Drafts: ${draftIds(repo).join(", ") || "none"}.` };
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(readFileSync(draft.rule, "utf8"));
	} catch (error) {
		return { ok: false, message: `The draft ${id} does not parse as YAML (${message(error)}); nothing was moved.` };
	}
	if (!isRecord(parsed) || parsed.id !== id) return { ok: false, message: `The draft file ${id}.yml does not carry the id ${id}; nothing was moved.` };
	const rule = join(lintDir(repo), "rules", `${id}.yml`);
	const test = join(lintDir(repo), "tests", `${id}-test.yml`);
	if (existsSync(rule) || existsSync(test)) return { ok: false, message: `The rule kit already has ${id} (${existsSync(rule) ? "rules" : "tests"}); nothing was moved.` };
	mkdirSync(join(lintDir(repo), "rules"), { recursive: true });
	mkdirSync(join(lintDir(repo), "tests"), { recursive: true });
	const created: string[] = [];
	let adopted = false;
	try {
		for (const [source, target] of [[draft.rule, rule], [draft.test, test]]) {
			copyFileSync(source, target, constants.COPYFILE_EXCL);
			created.push(target);
		}
		const result = await adoptRule({ repo, rule: id });
		if (!result.ok) return { ok: false, message: `Adoption failed, so nothing was moved: ${result.message}` };
		adopted = true;
		rmSync(draft.rule);
		rmSync(draft.test);
		return { ok: true, message: `Accepted ${id}: it is now a rule of .omp/lint/rules with its test in .omp/lint/tests, ${result.message}.` };
	} finally {
		if (!adopted) for (const file of created) rmSync(file, { force: true });
	}
}

/** Deletes the draft `id` and records the id in `.omp/lint/drafts/rejected.json`, so it is never drafted again. Refuses when no draft has that id or `rejected.json` is unreadable. */
export function rejectDraft(input: { repo: string; id: string }): Outcome {
	const repo = resolve(input.repo);
	const { id } = input;
	if (!ID_FORMAT.test(id)) return { ok: false, message: `${JSON.stringify(id)} is not a rule id; nothing was rejected.` };
	const draft = draftFiles(repo, id);
	if (!existsSync(draft.rule) && !existsSync(draft.test)) return { ok: false, message: `No draft ${id} in ${draftsDir(repo)}; nothing was rejected. Drafts: ${draftIds(repo).join(", ") || "none"}.` };
	const rejected = readRejected(repo);
	if ("problem" in rejected) return { ok: false, message: `${rejected.problem}; nothing was rejected. Fix or delete it.` };
	writeFileSync(join(draftsDir(repo), "rejected.json"), `${JSON.stringify([...new Set([...rejected.ids, id])].sort(byText), null, 2)}\n`);
	rmSync(draft.rule, { force: true });
	rmSync(draft.test, { force: true });
	return { ok: true, message: `Rejected ${id}: the draft is deleted and ${id} is recorded in .omp/lint/drafts/rejected.json, so it is not drafted again.` };
}

/** Runs one boundary command on `repo`; see {@link BoundariesAction}. A failure of git or ast-grep is an `ok: false` outcome, not an exception. */
export async function runBoundaries(input: { repo: string; action: BoundariesAction; date?: string; signal?: AbortSignal }): Promise<Outcome> {
	const repo = resolve(input.repo);
	const { action } = input;
	try {
		if (action.kind === "accept") return await acceptDraft({ repo, id: action.id });
		if (action.kind === "reject") return rejectDraft({ repo, id: action.id });
		if (action.kind === "list" && draftIds(repo).length > 0) return { ok: true, message: listing(repo) };
		return await draftCommand({ repo, dryRun: action.kind === "draft" && action.dryRun, date: input.date, signal: input.signal });
	} catch (error) {
		return { ok: false, message: `boundaries failed: ${message(error)}` };
	}
}

function parseArgs(argv: string[]): { repo: string; action: BoundariesAction } | undefined {
	const [repo, ...rest] = argv;
	if (repo === undefined || repo.startsWith("--")) return undefined;
	if (rest.length === 0) return { repo, action: { kind: "draft", dryRun: false } };
	if (rest.length === 1 && rest[0] === "--dry-run") return { repo, action: { kind: "draft", dryRun: true } };
	const [flag, id] = rest;
	if (rest.length === 2 && (flag === "--accept" || flag === "--reject") && !id.startsWith("--")) return { repo, action: { kind: flag === "--accept" ? "accept" : "reject", id } };
	return undefined;
}

async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed === undefined) {
		console.error("usage: bun harness/gate/boundaries.ts <repo> [--dry-run | --accept <id> | --reject <id>]");
		return 2;
	}
	const result = await runBoundaries(parsed);
	(result.ok ? console.log : console.error)(result.message);
	return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
