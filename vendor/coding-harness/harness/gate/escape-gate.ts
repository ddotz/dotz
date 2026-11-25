import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { baseTextOf, propertyOf, runAll, shortened } from "./escape-common.ts";
import { parseGateFile } from "./gate-file.ts";
import type { EscapeInput, Finding } from "./types.ts";
import { isRecord, message } from "./util.ts";

interface RuleTotal {
	total: number;
	files: Map<string, number>;
}

type JsonRead = { kind: "absent" } | { kind: "invalid" } | { kind: "ok"; value: unknown };

const GUIDANCE =
	"Weakened gate refused. A removed or changed check or evidence entry, an invalid gate file, a raised baseline total, a deleted or edited lint rule, config or rule test, or an un-adopted rule lets through violations that were stopped before. Restore it and fix the violations. Only the user can accept a weaker gate, with /gate-ok.";
const GATE_FILE_CONCURRENCY = 8;
const ADOPTED_FILE = ".omp/lint/adopted.json";
const DRAFTS_DIR = ".omp/lint/drafts/";
const RULE_KEYS = ["rule", "files", "ignores", "language", "severity", "constraints", "utils"] as const;

function weakenedGate(file: string, text: string): Finding {
	return { stage: "escape", class: "weakened-gate", message: GUIDANCE, file, text: shortened(text) };
}

function readJson(text: string | null | undefined): JsonRead {
	if (text === undefined || text === null) return { kind: "absent" };
	try {
		return { kind: "ok", value: JSON.parse(text.replace(/^\uFEFF/, "")) };
	} catch {
		return { kind: "invalid" };
	}
}

function readWorkingFile(repo: string, file: string): string | undefined {
	try {
		return readFileSync(join(repo, file), "utf8");
	} catch {
		return undefined;
	}
}

async function referenceOf(input: EscapeInput, file: string): Promise<string | null> {
	input.signal?.throwIfAborted();
	const accepted = await input.acceptedText?.(file);
	return accepted !== undefined ? accepted : baseTextOf(input, file);
}

function canonical(value: unknown): string {
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const members = Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonical(propertyOf(value, key))}`);
		return `{${members.join(",")}}`;
	}
	return JSON.stringify(value);
}

function entriesByName(gate: unknown, list: string): Map<string, unknown> {
	const entries = new Map<string, unknown>();
	const items: unknown = propertyOf(gate, list);
	if (!Array.isArray(items)) return entries;
	const seen = new Map<string, number>();
	items.forEach((item: unknown, index: number) => {
		const name = propertyOf(item, "name");
		const label = typeof name === "string" ? name : `#${index}`;
		const occurrence = (seen.get(label) ?? 0) + 1;
		seen.set(label, occurrence);
		entries.set(occurrence === 1 ? label : `${label}#${occurrence}`, item);
	});
	return entries;
}

function pathsWidened(before: unknown, after: unknown): boolean {
	if (!Array.isArray(before) || !Array.isArray(after)) return false;
	const kept = new Set(after.map(canonical));
	return before.every(path => kept.has(canonical(path)));
}

function changedKeys(before: unknown, after: unknown): string[] {
	const keysOf = (value: unknown): string[] => (typeof value === "object" && value !== null ? Object.keys(value) : []);
	return [...new Set([...keysOf(before), ...keysOf(after)])].filter(key => {
		const was = propertyOf(before, key);
		const now = propertyOf(after, key);
		if (canonical(was) === canonical(now)) return false;
		return !(key === "paths" && pathsWidened(was, now));
	});
}

function gateEntryFindings(file: string, noun: "check" | "evidence", before: unknown, after: unknown, list: string): Finding[] {
	const remaining = entriesByName(after, list);
	const findings: Finding[] = [];
	for (const [name, entry] of entriesByName(before, list)) {
		if (!remaining.has(name)) {
			findings.push(weakenedGate(file, `${noun} "${name}" was removed`));
		} else if (canonical(entry) !== canonical(remaining.get(name))) {
			const keys = changedKeys(entry, remaining.get(name));
			const bothObjects = typeof entry === "object" && entry !== null && typeof remaining.get(name) === "object" && remaining.get(name) !== null;
			if (keys.length === 0 && bothObjects) continue;
			findings.push(weakenedGate(file, `${noun} "${name}" changed: ${keys.length > 0 ? keys.join(", ") : "its definition"}`));
		}
	}
	return findings;
}

function gateProblem(text: string): string | undefined {
	try {
		parseGateFile(text);
		return undefined;
	} catch (error) {
		return message(error);
	}
}

async function gateJsonFindings(input: EscapeInput, file: string): Promise<Finding[]> {
	const reference = await referenceOf(input, file);
	if (reference === null || gateProblem(reference) !== undefined) return [];
	const before: unknown = JSON.parse(reference);
	const current = readWorkingFile(input.repo, file);
	if (current === undefined) return [...gateEntryFindings(file, "check", before, undefined, "checks"), ...gateEntryFindings(file, "evidence", before, undefined, "evidence")];
	const problem = gateProblem(current);
	if (problem !== undefined) return [weakenedGate(file, `the gate file is invalid, so none of its checks run: ${problem}`)];
	const after: unknown = JSON.parse(current);
	return [...gateEntryFindings(file, "check", before, after, "checks"), ...gateEntryFindings(file, "evidence", before, after, "evidence")];
}

function ruleTotals(value: unknown): Map<string, RuleTotal> {
	const totals = new Map<string, RuleTotal>();
	if (!isRecord(value)) return totals;
	for (const [file, rules] of Object.entries(value)) {
		if (!isRecord(rules)) continue;
		for (const [rule, count] of Object.entries(rules)) {
			if (typeof count !== "number") continue;
			const entry = totals.get(rule) ?? { total: 0, files: new Map<string, number>() };
			entry.total += count;
			entry.files.set(file, count);
			totals.set(rule, entry);
		}
	}
	return totals;
}

async function adoptedAtReference(input: EscapeInput, recorded: Map<string, RuleTotal>): Promise<Set<string>> {
	const listed = readJson(await referenceOf(input, ADOPTED_FILE));
	if (listed.kind === "ok" && Array.isArray(listed.value)) return new Set(listed.value.filter((id: unknown): id is string => typeof id === "string"));
	return new Set(recorded.keys());
}

async function baselineFindings(input: EscapeInput, file: string, adoptionGated: boolean): Promise<Finding[]> {
	const before = readJson(await referenceOf(input, file));
	const current = readJson(readWorkingFile(input.repo, file));
	if (before.kind !== "ok" || current.kind !== "ok") return [];
	const earlier = ruleTotals(before.value);
	const raised = [...ruleTotals(current.value)].filter(([rule, now]) => now.total > (earlier.get(rule)?.total ?? 0));
	if (raised.length === 0) return [];
	const adopted = adoptionGated ? await adoptedAtReference(input, earlier) : undefined;
	return raised
		.filter(([rule]) => adopted === undefined || adopted.has(rule))
		.map(([rule, now]) => {
			const recorded = earlier.get(rule);
			const added = [...now.files.keys()].filter(path => !recorded?.files.has(path));
			return weakenedGate(file, `count raised from ${recorded?.total ?? 0} to ${now.total}: ${rule}${added.length > 0 ? ` (entry added: ${added.join(", ")})` : ""}`);
		});
}

async function adoptedFindings(input: EscapeInput, file: string): Promise<Finding[]> {
	const before = readJson(await referenceOf(input, file));
	if (before.kind !== "ok" || !Array.isArray(before.value)) return [];
	const current = readJson(readWorkingFile(input.repo, file));
	const remaining: unknown[] = current.kind === "ok" && Array.isArray(current.value) ? current.value : [];
	const removed: unknown[] = before.value.filter((id: unknown) => !remaining.includes(id));
	return removed.map(id => weakenedGate(file, `adopted rule ${JSON.stringify(id)} is no longer listed`));
}

function lintFileKind(file: string): string {
	if (file.startsWith(".omp/lint/rules/")) return "lint rule file";
	if (file === ".omp/lint/sgconfig.yml") return "lint config file";
	return "lint file";
}

async function lintFileFindings(input: EscapeInput, file: string): Promise<Finding[]> {
	const before = await referenceOf(input, file);
	if (before === null) return [];
	const current = readWorkingFile(input.repo, file);
	if (current === before) return [];
	return [weakenedGate(file, `${lintFileKind(file)} was ${current === undefined ? "deleted" : "modified"}`)];
}

function ruleDocuments(text: string): Map<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(text);
	} catch {
		return undefined;
	}
	const documents = new Map<string, unknown>();
	for (const doc of Array.isArray(parsed) ? parsed : [parsed]) documents.set(String(propertyOf(doc, "id")), doc);
	return documents;
}

async function ruleFileFindings(input: EscapeInput, file: string): Promise<Finding[]> {
	const before = await referenceOf(input, file);
	if (before === null) return [];
	const current = readWorkingFile(input.repo, file);
	if (current === before) return [];
	if (current === undefined) return [weakenedGate(file, `${lintFileKind(file)} was deleted`)];
	const earlier = ruleDocuments(before);
	if (earlier === undefined) return [];
	const now = ruleDocuments(current);
	if (now === undefined) return [weakenedGate(file, "lint rule file was modified: it no longer parses as YAML, so none of its rules can run")];
	const findings: Finding[] = [];
	for (const [id, doc] of earlier) {
		const after = now.get(id);
		if (after === undefined) {
			findings.push(weakenedGate(file, `lint rule file was modified: rule "${id}" was removed`));
			continue;
		}
		const changed = RULE_KEYS.filter(key => canonical(propertyOf(doc, key)) !== canonical(propertyOf(after, key)));
		if (changed.length > 0) findings.push(weakenedGate(file, `lint rule file was modified: rule "${id}" changed: ${changed.join(", ")}`));
	}
	return findings;
}

function ruleTestCases(text: string): Map<string, string> | undefined {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(text);
	} catch {
		return undefined;
	}
	const cases = new Map<string, string>();
	for (const doc of Array.isArray(parsed) ? parsed : [parsed]) {
		const id = String(propertyOf(doc, "id"));
		for (const kind of ["valid", "invalid"]) {
			const listed: unknown = propertyOf(doc, kind);
			if (!Array.isArray(listed)) continue;
			for (const item of listed) cases.set(`${id}\0${kind}\0${canonical(item)}`, `${kind} case ${canonical(item)} of rule ${id}`);
		}
	}
	return cases;
}

async function ruleTestFindings(input: EscapeInput, file: string): Promise<Finding[]> {
	const before = await referenceOf(input, file);
	if (before === null) return [];
	const current = readWorkingFile(input.repo, file);
	if (current === before) return [];
	if (current === undefined) return [weakenedGate(file, "lint rule test file was deleted")];
	const earlier = ruleTestCases(before);
	const now = ruleTestCases(current);
	if (earlier === undefined) return [];
	if (now === undefined) return [weakenedGate(file, "lint rule test file no longer parses as YAML, so none of its cases can run")];
	return [...earlier].filter(([key]) => !now.has(key)).map(([, label]) => weakenedGate(file, `${label} was removed`));
}

function judge(input: EscapeInput, file: string): Promise<Finding[]> {
	if (file.startsWith(DRAFTS_DIR)) return Promise.resolve([]);
	if (file === ".omp/gate.json") return gateJsonFindings(input, file);
	if (file === ".omp/lint/baseline.json") return baselineFindings(input, file, true);
	if (file === ADOPTED_FILE) return adoptedFindings(input, file);
	if (basename(file) === "lint-baseline.json") return baselineFindings(input, file, false);
	if (file.startsWith(".omp/lint/tests/")) return ruleTestFindings(input, file);
	if (file.startsWith(".omp/lint/rules/") && /\.ya?ml$/.test(file)) return ruleFileFindings(input, file);
	if (file.startsWith(".omp/lint/")) return lintFileFindings(input, file);
	return Promise.resolve([]);
}

/** The weakened-gate findings among `files`, repo-relative paths the session changed: a gate file (`.omp/gate.json`, `.omp/lint/**`, `lint-baseline.json`) that holds less than it held at the reference point (the last accepted text, else the base text). Other files yield nothing, and so do boundary drafts under `.omp/lint/drafts/`, which refuse nothing: the user's accepting or rejecting one deletes it. */
export async function gateFileFindings(input: EscapeInput, files: string[]): Promise<Finding[]> {
	const found = await runAll(files, GATE_FILE_CONCURRENCY, input.signal, (file, signal) => judge({ ...input, signal }, file));
	return found.flat();
}
