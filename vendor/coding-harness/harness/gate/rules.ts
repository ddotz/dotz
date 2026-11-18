import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AST_GREP, type Finding, type Preexisting, type RulesInput, type RulesScan } from "./types.ts";

type Baseline = Record<string, Record<string, number>>;
type Mapping = Record<string, unknown>;

interface Occurrence {
	rule: string;
	file: string;
	line: number;
	message: string;
}

interface ScanResult {
	occurrences: Occurrence[];
	failure?: string;
}

const RULE_KINDS = ["banned-api", "boundary", "pattern"];
const TEMPLATES = join(import.meta.dir, "templates");
const SG_CONFIG_TEXT = "ruleDirs:\n  - rules\ntestConfigs:\n  - testDir: tests\n";
const TAIL_LINES = 30;

function lintDir(repo: string): string {
	return join(repo, ".omp", "lint");
}

function isRecord(value: unknown): value is Mapping {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function parseYaml(file: string): unknown {
	try {
		return Bun.YAML.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return new Error(error instanceof Error ? error.message : String(error));
	}
}

function ymlFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort()
		.map(name => join(dir, name));
}

const TOOL_TIMEOUT_MS = 60_000;
const KIT_CLASSES: readonly string[] = ["rule-incomplete", "rule-untested", "rule-unadopted", "rule-test-failed", "rule-scan-failed"];

/** Runs a command to completion. Aborting `signal` kills it and rejects with the abort reason; after `timeoutMs` (default 60 s) it is killed and `timedOut` is true. */
export async function runBounded(args: string[], cwd: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
	const { signal, timeoutMs = TOOL_TIMEOUT_MS } = options;
	signal?.throwIfAborted();
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, timeoutMs);
	const onAbort = () => proc.kill("SIGKILL");
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		signal?.throwIfAborted();
		return { code, out, err, timedOut };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function tail(text: string): string {
	return text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}

function relativeTo(repo: string, file: string): string {
	return file.startsWith(`${repo}/`) ? file.slice(repo.length + 1) : file;
}

function incomplete(repo: string, file: string, ruleId: string, problem: string): Finding {
	return {
		stage: "rules",
		class: "rule-incomplete",
		file: relativeTo(repo, file),
		message: `Rule file ${ruleId} is incomplete: ${problem}. The rule kit refuses rules that cannot explain themselves; fix the file so it names the replacement and the mistake it encodes (skill://correct).`,
	};
}

function ruleDefects(rule: unknown): string[] {
	if (rule instanceof Error) return [`it does not parse as YAML (${rule.message})`];
	if (!isRecord(rule)) return ["it is not a YAML mapping"];
	const defects: string[] = [];
	if (!nonEmptyString(rule.id)) defects.push("missing `id`");
	if (!nonEmptyString(rule.language)) defects.push("missing `language`");
	if (rule.severity !== "error") defects.push("`severity` must be `error`");
	if (!isRecord(rule.rule)) defects.push("missing `rule`");
	if (!nonEmptyString(rule.message)) defects.push("`message` is empty; say what to use instead");
	else if (rule.message.trim() === rule.id) defects.push("`message` repeats the id; say what to use instead");
	const metadata = isRecord(rule.metadata) ? rule.metadata : {};
	if (typeof metadata.kind !== "string" || !RULE_KINDS.includes(metadata.kind)) defects.push(`\`metadata.kind\` must be one of ${RULE_KINDS.join(", ")}`);
	if (!nonEmptyString(metadata.origin)) defects.push("missing `metadata.origin` (the commit, session or date of the mistake it encodes)");
	else if (metadata.origin.trimStart().startsWith("template:")) defects.push("`metadata.origin` is still the template placeholder; replace it with the commit, session or date of the real mistake");
	return defects;
}

function testsById(dir: string): Map<string, { file: string; doc: unknown }[]> {
	const byId = new Map<string, { file: string; doc: unknown }[]>();
	for (const file of ymlFiles(join(dir, "tests"))) {
		const doc = parseYaml(file);
		const id = isRecord(doc) && nonEmptyString(doc.id) ? doc.id : "";
		byId.set(id, [...(byId.get(id) ?? []), { file, doc }]);
	}
	return byId;
}

function caseListDefects(doc: unknown): string[] {
	if (doc instanceof Error) return [`its test file does not parse as YAML (${doc.message})`];
	if (!isRecord(doc)) return ["its test file is not a YAML mapping"];
	const defects: string[] = [];
	for (const key of ["invalid", "valid"]) {
		const cases = doc[key];
		if (!Array.isArray(cases) || cases.length === 0) defects.push(`its test has no \`${key}\` case`);
	}
	return defects;
}

function untested(repo: string, file: string, ruleId: string, problem: string): Finding {
	return {
		stage: "rules",
		class: "rule-untested",
		file: relativeTo(repo, file),
		message: `Rule ${ruleId} is untested: ${problem}. A rule needs one \`invalid\` case (the mistake) and one \`valid\` case (the alternative) in .omp/lint/tests/${ruleId}-test.yml; write the cases so the rule is proven to catch the mistake and to leave the fix alone.`,
	};
}

type LoadedAdopted = { ids: Set<string> } | { problem: string };

function loadAdopted(repo: string): LoadedAdopted {
	const file = join(lintDir(repo), "adopted.json");
	if (!existsSync(file)) return { ids: new Set() };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { problem: `.omp/lint/adopted.json does not parse: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!Array.isArray(parsed) || !parsed.every(nonEmptyString)) return { problem: ".omp/lint/adopted.json must be an array of rule ids" };
	return { ids: new Set(parsed) };
}

function unadopted(repo: string, file: string, ruleId: string): Finding {
	return {
		stage: "rules",
		class: "rule-unadopted",
		file: relativeTo(repo, file),
		message: `Rule ${ruleId} is not adopted: run \`${adoptCommand(repo, ruleId)}\` once to record the rule and its pre-existing occurrences. After that its occurrences are never added to the baseline; replace new uses instead.`,
	};
}

function metaFindings(repo: string): Finding[] {
	const dir = lintDir(repo);
	const tests = testsById(dir);
	const adopted = loadAdopted(repo);
	const findings: Finding[] = "problem" in adopted ? [{ stage: "rules", class: "rule-incomplete", file: ".omp/lint/adopted.json", message: `${adopted.problem}. Restore it from git; it is machine-written by \`--adopt\` and lists each rule once.` }] : [];
	const adoptedIds = "ids" in adopted ? adopted.ids : new Set<string>();
	const present = new Set<string>();
	for (const file of ymlFiles(join(dir, "rules"))) {
		const rule = parseYaml(file);
		const ruleId = isRecord(rule) && nonEmptyString(rule.id) ? rule.id : relativeTo(repo, file);
		for (const defect of ruleDefects(rule)) findings.push(incomplete(repo, file, ruleId, defect));
		if (!isRecord(rule) || !nonEmptyString(rule.id)) continue;
		present.add(rule.id);
		if ("ids" in adopted && !adoptedIds.has(rule.id)) findings.push(unadopted(repo, file, rule.id));
		const matching = tests.get(rule.id) ?? [];
		if (matching.length === 0) findings.push(untested(repo, file, rule.id, "no test file with this `id` exists"));
		for (const test of matching) for (const defect of caseListDefects(test.doc)) findings.push(untested(repo, test.file, rule.id, defect));
	}
	for (const id of adoptedIds) {
		if (present.has(id)) continue;
		findings.push({
			stage: "rules",
			class: "rule-incomplete",
			file: ".omp/lint/adopted.json",
			message: `Rule ${id} is listed in .omp/lint/adopted.json but has no rule file in .omp/lint/rules: the rule was deleted. Restore the rule file from git, or have the user accept the removal.`,
		});
	}
	return findings;
}

async function testFindings(repo: string, signal?: AbortSignal): Promise<Finding[]> {
	if (ymlFiles(join(lintDir(repo), "tests")).length === 0) return [];
	const result = await runBounded([AST_GREP, "test", "-c", join(lintDir(repo), "sgconfig.yml"), "--skip-snapshot-tests", "--color", "never"], repo, { signal });
	if (result.timedOut) return [{ stage: "rules", class: "rule-test-failed", file: ".omp/lint", message: `\`ast-grep test\` did not finish within ${TOOL_TIMEOUT_MS / 1000} s and was killed. Fix the rule so it terminates.` }];
	if (result.code === 0) return [];
	return [
		{
			stage: "rules",
			class: "rule-test-failed",
			file: ".omp/lint",
			message: `\`ast-grep test\` failed, so at least one rule does not match its \`invalid\` case or matches its \`valid\` case. Fix the rule or the test case until it passes; do not delete the failing case.`,
			text: tail(`${result.out}\n${result.err}`),
		},
	];
}

function toOccurrence(item: unknown): Occurrence | undefined {
	if (!isRecord(item) || typeof item.ruleId !== "string" || typeof item.file !== "string" || typeof item.message !== "string") return undefined;
	const start = isRecord(item.range) && isRecord(item.range.start) ? item.range.start : undefined;
	if (!start || typeof start.line !== "number") return undefined;
	return { rule: item.ruleId, file: item.file.replace(/^\.\//, ""), line: start.line + 1, message: item.message };
}

async function scanOnce(repo: string, targets: string[], ignoreFlags: string[], signal?: AbortSignal): Promise<ScanResult> {
	const args = [AST_GREP, "scan", "-c", join(lintDir(repo), "sgconfig.yml"), "--json=compact", "--color", "never", ...ignoreFlags, "--globs", "!**/node_modules/**", ...targets];
	const result = await runBounded(args, repo, { signal });
	if (result.timedOut) return { occurrences: [], failure: `\`ast-grep scan\` did not finish within ${TOOL_TIMEOUT_MS / 1000} s and was killed.` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.out);
	} catch {
		return { occurrences: [], failure: tail(`${result.out}\n${result.err}`) };
	}
	if (!Array.isArray(parsed)) return { occurrences: [], failure: tail(result.out) };
	const occurrences: Occurrence[] = [];
	for (const item of parsed) {
		const occurrence = toOccurrence(item);
		if (occurrence) occurrences.push(occurrence);
	}
	return { occurrences };
}

const SEARCH_EVERYWHERE = ["hidden", "dot", "exclude", "global", "parent", "vcs"].flatMap(kind => ["--no-ignore", kind]);

function scopedFiles(repo: string, files: string[]): string[] {
	const inside = new Set<string>();
	for (const file of files) {
		const path = relative(repo, resolve(repo, file));
		if (path === "" || path.startsWith("..") || isAbsolute(path)) continue;
		inside.add(path);
	}
	return [...inside].sort();
}

function isRegularFile(repo: string, file: string): boolean {
	try {
		return lstatSync(join(repo, file)).isFile();
	} catch {
		return false;
	}
}

async function scan(repo: string, files: string[] = [], signal?: AbortSignal): Promise<ScanResult> {
	const walked = await scanOnce(repo, ["."], [], signal);
	const explicit = files.filter(file => isRegularFile(repo, file));
	if (walked.failure !== undefined || explicit.length === 0) return walked;
	const named = await scanOnce(repo, explicit.map(file => `./${file}`), SEARCH_EVERYWHERE, signal);
	if (named.failure !== undefined) return named;
	const merged = new Map<string, Occurrence>();
	for (const occurrence of [...walked.occurrences, ...named.occurrences]) merged.set(`${occurrence.file}\0${occurrence.line}\0${occurrence.rule}`, occurrence);
	const occurrences = [...merged.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
	return { occurrences };
}

function countOccurrences(occurrences: Occurrence[]): Baseline {
	const counts: Baseline = {};
	for (const { file, rule } of occurrences) {
		counts[file] ??= {};
		counts[file][rule] = (counts[file][rule] ?? 0) + 1;
	}
	return counts;
}

type Loaded = { baseline: Baseline } | { problem: string };

function loadBaseline(repo: string): Loaded {
	const file = join(lintDir(repo), "baseline.json");
	if (!existsSync(file)) return { baseline: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { problem: `.omp/lint/baseline.json does not parse: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isRecord(parsed)) return { problem: ".omp/lint/baseline.json must be an object of file -> rule -> count" };
	const baseline: Baseline = {};
	for (const [path, rules] of Object.entries(parsed)) {
		if (!isRecord(rules)) return { problem: `.omp/lint/baseline.json entry ${path} must map rule ids to counts` };
		baseline[path] = {};
		for (const [rule, count] of Object.entries(rules)) {
			if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return { problem: `.omp/lint/baseline.json count for ${rule} in ${path} must be a non-negative integer` };
			baseline[path][rule] = count;
		}
	}
	return { baseline };
}

interface Delta {
	rule: string;
	file: string;
	was: number | undefined;
	now: number;
}

function deltas(baseline: Baseline, current: Baseline): Delta[] {
	const out: Delta[] = [];
	for (const file of new Set([...Object.keys(baseline), ...Object.keys(current)]).values()) {
		for (const rule of new Set([...Object.keys(baseline[file] ?? {}), ...Object.keys(current[file] ?? {})]).values()) {
			const was = baseline[file]?.[rule];
			const now = current[file]?.[rule] ?? 0;
			if (was === undefined || was !== now) out.push({ rule, file, was, now });
		}
	}
	return out.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

interface RuleChange {
	rule: string;
	was: number;
	now: number;
	deltas: Delta[];
}

function ruleTotal(counts: Baseline, rule: string): number {
	return Object.values(counts).reduce((sum, rules) => sum + (rules[rule] ?? 0), 0);
}

function ruleChanges(baseline: Baseline, current: Baseline): RuleChange[] {
	const byRule = new Map<string, Delta[]>();
	for (const delta of deltas(baseline, current)) byRule.set(delta.rule, [...(byRule.get(delta.rule) ?? []), delta]);
	return [...byRule.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([rule, changed]) => ({ rule, was: ruleTotal(baseline, rule), now: ruleTotal(current, rule), deltas: changed }));
}

function updateCommand(repo: string): string {
	return `bun ${import.meta.path} ${repo} --update`;
}

function adoptCommand(repo: string, rule: string): string {
	return `bun ${import.meta.path} ${repo} --adopt ${rule}`;
}

function raisedFindings(repo: string, delta: Delta, occurrences: Occurrence[], ruleAdopted: boolean): Finding[] {
	const inFile = occurrences.filter(o => o.rule === delta.rule && o.file === delta.file);
	let context = `${delta.now} occurrences in this file, baseline allows ${delta.was}, and they cannot be told apart`;
	let advice = "replace the use instead of adding it to the baseline";
	if (delta.was === undefined) {
		context = "this file has no baseline entry for the rule";
		if (!ruleAdopted) {
			context = "the rule is not adopted yet";
			advice = `replace the use instead of adding it to the baseline. If the rule is new and these occurrences predate it, record them once with \`${adoptCommand(repo, delta.rule)}\``;
		}
	}
	return inFile.map(o => ({
		stage: "rules",
		class: o.rule,
		file: o.file,
		line: o.line,
		message: `${o.message} (${context}; ${advice}. If the mistake recurs, encode it as a rule with a test via skill://correct.)`,
	}));
}

function staleFinding(repo: string, delta: Delta): Finding {
	return {
		stage: "rules",
		class: "baseline-stale",
		file: delta.file,
		message: `${delta.rule} in ${delta.file}: baseline ${delta.was ?? 0}, now ${delta.now}. The baseline no longer matches where the occurrences are (debt paid down, or moved by a rename); record the current counts with \`${updateCommand(repo)}\` so it cannot creep back.`,
	};
}

async function baselineFindings(repo: string, files: string[] | undefined, signal?: AbortSignal): Promise<RulesScan> {
	const loaded = loadBaseline(repo);
	if ("problem" in loaded) return { findings: [{ stage: "rules", class: "rule-incomplete", file: ".omp/lint/baseline.json", message: `${loaded.problem}. Restore it from git; the baseline is machine-written by \`${updateCommand(repo)}\`.` }], preexisting: [] };
	const scanned = await scan(repo, files, signal);
	if (scanned.failure !== undefined) return { findings: [{ stage: "rules", class: "rule-scan-failed", file: ".omp/lint", message: "`ast-grep scan` produced no usable output. Fix the rule files so the scan runs.", text: scanned.failure }], preexisting: [] };
	const adopted = loadAdopted(repo);
	const adoptedIds = "ids" in adopted ? adopted.ids : new Set<string>();
	const scope = files === undefined ? undefined : new Set(files);
	const findings: Finding[] = [];
	const preexisting: Preexisting[] = [];
	for (const change of ruleChanges(loaded.baseline, countOccurrences(scanned.occurrences))) {
		if (change.now > change.was) {
			for (const delta of change.deltas.filter(d => d.now > (d.was ?? 0))) {
				if (scope !== undefined && !scope.has(delta.file)) preexisting.push({ rule: delta.rule, file: delta.file, count: delta.now - (delta.was ?? 0) });
				else findings.push(...raisedFindings(repo, delta, scanned.occurrences, adoptedIds.has(delta.rule)));
			}
		} else if (scope === undefined || change.deltas.some(d => scope.has(d.file))) {
			findings.push(...change.deltas.map(delta => staleFinding(repo, delta)));
		}
	}
	return { findings, preexisting };
}

/**
 * The project rule kit for `<repo>/.omp/lint`: rule meta-check, `ast-grep test`, then a scan whose per-rule totals are
 * compared with `baseline.json`. Empty when the repo has no `.omp/lint/sgconfig.yml`. Without `files` the whole repo is
 * judged and every problem is a finding. With `files`, rule occurrences are findings only in those files (scanned
 * explicitly, so ignore files and dot-directories cannot hide them) and occurrences above the ratchet elsewhere are
 * `preexisting`; kit soundness problems are findings only when some listed file lies under `.omp/lint/`, otherwise they
 * are `preexisting` rows named by finding class. Aborting `input.signal` kills every child process and rejects.
 */
export async function rulesScan(input: RulesInput): Promise<RulesScan> {
	const repo = resolve(input.repo);
	if (!existsSync(join(lintDir(repo), "sgconfig.yml"))) return { findings: [], preexisting: [] };
	const files = input.files === undefined ? undefined : scopedFiles(repo, input.files);
	const kitTouched = files === undefined || files.some(file => file === ".omp/lint" || file.startsWith(".omp/lint/"));
	const meta = metaFindings(repo);
	const tested = await testFindings(repo, input.signal);
	const baseline = tested.length > 0 && kitTouched ? { findings: [], preexisting: [] } : await baselineFindings(repo, files, input.signal);
	const all = [...meta, ...tested, ...baseline.findings];
	const preexisting = [...baseline.preexisting];
	let findings = all;
	if (!kitTouched) {
		findings = all.filter(finding => !KIT_CLASSES.includes(finding.class));
		for (const finding of all) if (KIT_CLASSES.includes(finding.class)) preexisting.push({ rule: finding.class, file: finding.file ?? ".omp/lint", count: 1 });
	}
	return { findings, preexisting: preexisting.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file)) };
}

/** The findings of {@link rulesScan}. */
export async function rulesFindings(input: RulesInput): Promise<Finding[]> {
	return (await rulesScan(input)).findings;
}

function sortedBaseline(baseline: Baseline): Baseline {
	const out: Baseline = {};
	for (const file of Object.keys(baseline).sort()) {
		out[file] = {};
		for (const rule of Object.keys(baseline[file]).sort()) out[file][rule] = baseline[file][rule];
	}
	return out;
}

/** Records the current per-file counts in `baseline.json`. Refuses, writing nothing, when a rule's total would rise or a never-adopted rule would gain entries. */
export async function updateBaseline(input: { repo: string }): Promise<{ ok: boolean; message: string }> {
	const repo = resolve(input.repo);
	if (!existsSync(join(lintDir(repo), "sgconfig.yml"))) return { ok: false, message: `${lintDir(repo)}/sgconfig.yml does not exist; run with --init first.` };
	const loaded = loadBaseline(repo);
	if ("problem" in loaded) return { ok: false, message: loaded.problem };
	const scanned = await scan(repo);
	if (scanned.failure !== undefined) return { ok: false, message: `ast-grep scan produced no usable output:\n${scanned.failure}` };
	const current = countOccurrences(scanned.occurrences);
	const changes = deltas(loaded.baseline, current);
	const adopted = loadAdopted(repo);
	const adoptedIds = "ids" in adopted ? adopted.ids : new Set<string>();
	const refused: string[] = [];
	for (const change of ruleChanges(loaded.baseline, current)) {
		if (change.now > change.was) refused.push(`  ${change.rule}: baseline total ${change.was}, now ${change.now}`);
		else if (!adoptedIds.has(change.rule)) refused.push(...change.deltas.filter(d => d.was === undefined).map(d => `  ${d.rule} in ${d.file}: not adopted, no baseline entry`));
	}
	if (refused.length > 0) return { ok: false, message: `--update refuses to raise a rule's total or to add entries for a rule that was never adopted; fix the new occurrences instead:\n${refused.join("\n")}` };
	const next: Baseline = {};
	for (const file of Object.keys(current)) next[file] = { ...current[file] };
	writeFileSync(join(lintDir(repo), "baseline.json"), `${JSON.stringify(sortedBaseline(next), null, 2)}\n`);
	return { ok: true, message: `baseline updated (${changes.length} entries changed)` };
}

/** Creates `.omp/lint/` with `sgconfig.yml`, an empty baseline and empty `rules/` and `tests/` directories; throws when the directory exists. Returns the created paths relative to the repo. */
export function initRuleKit(input: { repo: string }): string[] {
	const repo = resolve(input.repo);
	const dir = lintDir(repo);
	if (existsSync(dir)) throw new Error(`${dir} already exists; --init never overwrites it.`);
	mkdirSync(join(dir, "rules"), { recursive: true });
	mkdirSync(join(dir, "tests"), { recursive: true });
	writeFileSync(join(dir, "sgconfig.yml"), SG_CONFIG_TEXT);
	writeFileSync(join(dir, "baseline.json"), "{}\n");
	writeFileSync(join(dir, "adopted.json"), "[]\n");
	writeFileSync(join(dir, "rules", ".gitkeep"), "");
	writeFileSync(join(dir, "tests", ".gitkeep"), "");
	return [".omp/lint/sgconfig.yml", ".omp/lint/baseline.json", ".omp/lint/adopted.json", ".omp/lint/rules/.gitkeep", ".omp/lint/tests/.gitkeep"];
}

function ruleExists(repo: string, ruleId: string): boolean {
	return ymlFiles(join(lintDir(repo), "rules")).some(file => {
		const rule = parseYaml(file);
		return isRecord(rule) && rule.id === ruleId;
	});
}

/**
 * Adopts a new rule once: records its current per-file occurrence counts in `baseline.json` (possibly none) and its id in
 * `adopted.json`, so a new rule can land on a codebase that already has violations. Refuses, writing nothing, for an unknown
 * rule, a rule already listed in `adopted.json`, an unreadable `adopted.json`, or a rule kit whose meta-check or
 * `ast-grep test` fails; `rule-unadopted` findings do not count, so several new rules can be adopted one after another.
 * Entries of other rules are never changed.
 */
export async function adoptRule(input: { repo: string; rule: string }): Promise<{ ok: boolean; message: string }> {
	const repo = resolve(input.repo);
	const rule = input.rule;
	if (!existsSync(join(lintDir(repo), "sgconfig.yml"))) return { ok: false, message: `${lintDir(repo)}/sgconfig.yml does not exist; run with --init first.` };
	if (!ruleExists(repo, rule)) return { ok: false, message: `--adopt refuses: no rule with id ${rule} exists in .omp/lint/rules.` };
	const loaded = loadBaseline(repo);
	if ("problem" in loaded) return { ok: false, message: loaded.problem };
	const adopted = loadAdopted(repo);
	if ("problem" in adopted) return { ok: false, message: adopted.problem };
	if (adopted.ids.has(rule)) return { ok: false, message: `--adopt refuses: ${rule} is already in .omp/lint/adopted.json; a rule is adopted once, so replace the new uses instead of recording them.` };
	const unsound = [...metaFindings(repo), ...(await testFindings(repo))].filter(f => f.class !== "rule-unadopted");
	if (unsound.length > 0) return { ok: false, message: `--adopt refuses: the rule kit is not sound, fix it first:\n${unsound.map(formatFinding).join("\n")}` };
	const scanned = await scan(repo);
	if (scanned.failure !== undefined) return { ok: false, message: `ast-grep scan produced no usable output:\n${scanned.failure}` };
	const mine = countOccurrences(scanned.occurrences.filter(o => o.rule === rule));
	const next: Baseline = {};
	for (const file of Object.keys(loaded.baseline)) {
		const others = Object.fromEntries(Object.entries(loaded.baseline[file]).filter(([id]) => id !== rule));
		if (Object.keys(others).length > 0) next[file] = others;
	}
	for (const file of Object.keys(mine)) next[file] = { ...next[file], ...mine[file] };
	writeFileSync(join(lintDir(repo), "baseline.json"), `${JSON.stringify(sortedBaseline(next), null, 2)}\n`);
	writeFileSync(join(lintDir(repo), "adopted.json"), `${JSON.stringify([...adopted.ids, rule].sort(), null, 2)}\n`);
	const total = Object.values(mine).reduce((sum, rules) => sum + (rules[rule] ?? 0), 0);
	return { ok: true, message: `adopted ${rule}: ${total} occurrences in ${Object.keys(mine).length} files recorded` };
}

function formatFinding(finding: Finding): string {
	const where = finding.file === undefined ? "" : `${finding.file}${finding.line === undefined ? "" : `:${finding.line}`} `;
	const text = finding.text === undefined ? "" : `\n${finding.text}`;
	return `${where}[${finding.class}] ${finding.message}${text}`;
}

async function main(argv: string[]): Promise<number> {
	const adoptAt = argv.indexOf("--adopt");
	const adoptId = adoptAt >= 0 ? argv[adoptAt + 1] : undefined;
	const plain = argv.filter((_, index) => adoptAt < 0 || index !== adoptAt + 1);
	const flags = plain.filter(arg => arg.startsWith("--"));
	const repoArg = plain.find(arg => !arg.startsWith("--"));
	const unknown = flags.filter(flag => flag !== "--update" && flag !== "--init" && flag !== "--adopt");
	const adoptMissing = adoptAt >= 0 && (adoptId === undefined || adoptId.startsWith("--"));
	if (!repoArg || unknown.length > 0 || flags.length > 1 || adoptMissing) {
		console.error("usage: bun harness/gate/rules.ts <repo> [--update | --init | --adopt <rule-id>]");
		return 2;
	}
	const repo = resolve(repoArg);
	if (flags[0] === "--init") {
		try {
			const created = initRuleKit({ repo }).map(file => `  ${file}`).join("\n");
			console.log(`created:\n${created}\ncopy a rule and its test from ${TEMPLATES} into .omp/lint/rules and .omp/lint/tests, replace the example id, message and metadata.origin, then record the rule once with \`bun ${import.meta.path} ${repo} --adopt <rule-id>\`.`);
			return 0;
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}
	if (flags[0] === "--update" || flags[0] === "--adopt") {
		const result = flags[0] === "--update" ? await updateBaseline({ repo }) : await adoptRule({ repo, rule: adoptId ?? "" });
		(result.ok ? console.log : console.error)(result.message);
		return result.ok ? 0 : 1;
	}
	const findings = await rulesFindings({ repo });
	if (findings.length === 0) {
		console.log(`rules: ok (${existsSync(join(lintDir(repo), "sgconfig.yml")) ? "all rules pass" : "no .omp/lint in this repo"})`);
		return 0;
	}
	console.error(findings.map(formatFinding).join("\n"));
	return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
