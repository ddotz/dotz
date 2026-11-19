// Daily prompt health check of the doctor (no model call, reads files only). It measures the whole contract the orchestrator re-reads after a
// compaction (hub/recall-contract.ts, the builder extension/index.ts recall() uses, called without modeInSystem so identity and MODE are in it
// wherever a runtime keeps them) and reports three things as findings:
//   1. size: the text or one of its parts grew well past a baseline kept in <DATA_DIR>/prompt-health.json
//   2. enforced: a line still spells out a rule that code already enforces (hub/enforced-rules.ts); a proposal, nothing is edited
//   3. caps: a prompt file past its size limit (LESSONS.md, RULES.md) or a feature line past INLINE_MAX
// `bun hub/prompt-health.ts --dry` prints the findings and a RESULT line and writes no state.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { DoctorCheck, Finding } from "./doctor-types.ts";
import { ENFORCED_RULES } from "./enforced-rules.ts";
import { INLINE_MAX, loadFeatureDirs } from "./featuredirs.ts";
import { msg } from "./i18n.ts";
import { LESSONS_MAX_BYTES } from "./prompt-budget.ts";
import { type RecallParts, recallContract } from "./recall-contract.ts";

// Growth thresholds: the whole text, and one part of it. Both the share and the absolute amount must be passed, so a tiny part
// doubling or a big text creeping by a few lines stays quiet.
export const TOTAL_GROWTH = { share: 0.1, chars: 2000 };
export const PART_GROWTH = { share: 0.25, chars: 1000 };
// RULES.md is read into the re-read text up to this many characters; the rest is cut away silently (the same 12_000 as the
// read in hub/recall-contract.ts and the file cap in hub/harness.ts, which keep it inline and not exported).
export const RULES_MAX_CHARS = 12_000;

export const PART_KEYS = ["mode", "rules", "lessons", "identity", "features", "setups", "state", "rest"] as const;
export type Sizes = Record<string, number>;
type Base = { chars: number; at: number };
/** baseline: the lowest size seen per key and when it was set; last: the sizes of the latest run. Key "total" is the whole text. */
export type PromptState = { baseline: Record<string, Base>; last: Sizes };

export const stateFile = (dataDir: string): string => join(dataDir, "prompt-health.json");

export function readState(dataDir: string): PromptState | undefined {
	try {
		const raw = JSON.parse(readFileSync(stateFile(dataDir), "utf8"));
		return raw && typeof raw.baseline === "object" && typeof raw.last === "object" ? (raw as PromptState) : undefined;
	} catch {
		return undefined;
	}
}

/** A rule file the re-read holds: its path, its name as the owner reads it (relative to the data or package dir) and its lines as read into the contract. */
export type RuleSource = { path: string; file: string; lines: string[] };

const FEATURE_BODY_HEAD = /^### .* \((\/[^;)]+)[;)]/;
const AFTER_FEATURE_BODIES = /^(## |Off until the owner asks)/;

/** The rule files of the contract: the mode text, RULES.md, each feature body and LESSONS.md. Not the identity, the channel setups or the state excerpt. */
export function ruleSources(dataDir: string, pkg: string, parts: RecallParts, modeFile: string): RuleSource[] {
	const shown = (path: string): string => {
		for (const root of [dataDir, pkg]) if (path.startsWith(`${root}/`)) return relative(root, path);
		return path;
	};
	const source = (path: string, text: string): RuleSource => ({ path, file: shown(path), lines: text ? text.split("\n") : [] });
	const out = [source(modeFile, parts.mode), source(join(dataDir, "RULES.md"), parts.rules), source(join(dataDir, "LESSONS.md"), parts.lessons)];
	let cur: RuleSource | undefined;
	for (const line of parts.features.split("\n")) {
		const head = FEATURE_BODY_HEAD.exec(line);
		if (head) out.push((cur = source(head[1]!, "")));
		else if (AFTER_FEATURE_BODIES.test(line)) cur = undefined;
		else cur?.lines.push(line);
	}
	return out;
}

/** The contract text of a data dir, its sizes per part (rest = framing text and anything not listed) and the rule files in it. */
export function measure(dataDir: string, pkg: string = join(import.meta.dir, "..")): { text: string; sizes: Sizes; sources: RuleSource[] } {
	const { text, parts, modeFile } = recallContract(dataDir, pkg);
	const sizes: Sizes = { total: text.length, mode: parts.mode.length, rules: parts.rules.length, lessons: parts.lessons.length, identity: parts.identity.length, features: parts.features.length, setups: parts.setups.length, state: parts.state.length };
	sizes.rest = text.length - PART_KEYS.filter(k => k !== "rest").reduce((n, k) => n + sizes[k], 0);
	return { text, sizes, sources: ruleSources(dataDir, pkg, parts, modeFile) };
}

/** First run stores every size as the baseline; later runs only move a baseline down (a shrink) and fill keys it did not have. */
export function advance(state: PromptState | undefined, sizes: Sizes, now: number): PromptState {
	const baseline: Record<string, Base> = { ...(state?.baseline ?? {}) };
	for (const [key, chars] of Object.entries(sizes)) {
		const was = baseline[key];
		if (!was || chars < was.chars) baseline[key] = { chars, at: now };
	}
	return { baseline, last: sizes };
}

function grown(state: PromptState): { key: string; from: number; to: number; at: number }[] {
	const rows: { key: string; from: number; to: number; at: number }[] = [];
	for (const [key, to] of Object.entries(state.last)) {
		const base = state.baseline[key];
		if (!base) continue;
		const over = to - base.chars;
		const t = key === "total" ? TOTAL_GROWTH : PART_GROWTH;
		if (over >= t.chars && over >= base.chars * t.share) rows.push({ key, from: base.chars, to, at: base.at });
	}
	return rows;
}

/** Real growth: the size finding fires for this state (part C uses it to start a model review early). */
export const promptGrowth = (state: PromptState): boolean => grown(state).length > 0;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function sizeFindings(state: PromptState, now: number): Finding[] {
	const m = msg();
	return grown(state).map(g => ({
		key: `prompt:size:${g.key}`,
		area: "prompt",
		what: m.promptGrew(m.promptPartLabels[g.key] ?? g.key, g.from, g.to, day(g.at)),
		evidence: m.promptSizeEvidence(g.from, g.to, day(g.at)),
		since: now,
		level: g.to - g.from,
	}));
}

// A blocked-command entry ("- deny: <regex> | <reason>", the RULES.md format hub/harnessprojects.ts denyLines reads) is the guard's own
// configuration, not a rule written out beside it: removing it would remove the guard, so it is never proposed.
const DENY_ENTRY = /^\s*- deny:\s/;

const QUOTE_MAX = 80;
const quote = (line: string): string => {
	const one = line.trim().replace(/\s+/g, " ");
	return one.length <= QUOTE_MAX ? one : `${one.slice(0, QUOTE_MAX - 1).trimEnd()}…`;
};
const lineNumber = (path: string, line: string): number => {
	try {
		return readFileSync(path, "utf8").split("\n").indexOf(line) + 1;
	} catch {
		return 0;
	}
};

/** One finding per enforced rule that a rule file line still writes out. The first such line, named by file:line, is what the owner decides on. */
export function enforcedFindings(sources: RuleSource[], now: number): Finding[] {
	const m = msg();
	const out: Finding[] = [];
	for (const rule of ENFORCED_RULES) {
		const hit = sources.map(s => ({ s, line: s.lines.find(l => !DENY_ENTRY.test(l) && rule.match.test(l)) })).find(h => h.line !== undefined);
		if (!hit?.line) continue;
		const at = lineNumber(hit.s.path, hit.line);
		const where = at ? `${hit.s.file}:${at}` : hit.s.file;
		const guard = rule.guard.split(":")[0]!;
		const shown = quote(hit.line);
		out.push({
			key: `prompt:enforced:${rule.id}`,
			area: "prompt",
			what: m.promptEnforced(where, guard),
			evidence: m.promptEnforcedEvidence(where, shown),
			since: now,
			level: hit.line.length,
			decide: { question: m.promptEnforcedAsk(where, shown, guard), options: [{ name: m.promptRemove, result: m.promptRemoveResult }, { name: m.promptKeep, result: m.promptKeepResult }] },
		});
	}
	return out;
}

/** Prompt files past a limit. LESSONS.md: bytes against the gate's cap. RULES.md: characters against the read cut. A feature: its always-loaded line against INLINE_MAX. */
export function capFindings(dataDir: string, now: number): Finding[] {
	const m = msg();
	const out: Finding[] = [];
	const over = (file: string, size: number, cap: number, unit: string) => {
		if (size <= cap) return;
		out.push({ key: `prompt:cap:${file}`, area: "prompt", what: m.promptCapOver(file, size, cap, unit), evidence: m.promptCapEvidence(size, cap, unit), since: now, level: size - cap });
	};
	const read = (name: string): string | undefined => (existsSync(join(dataDir, name)) ? readFileSync(join(dataDir, name), "utf8") : undefined);
	const lessons = read("LESSONS.md");
	if (lessons !== undefined) over("LESSONS.md", Buffer.byteLength(lessons), LESSONS_MAX_BYTES, "bytes");
	const rules = read("RULES.md");
	if (rules !== undefined) over("RULES.md", rules.length, RULES_MAX_CHARS, "chars");
	for (const f of loadFeatureDirs(dataDir).features) if (f.enabled && f.body) over(`features/${f.id}/feature.md`, f.what.length, INLINE_MAX, "chars");
	return out;
}

/** The whole check; `write: false` is the dry run (no state file touched). */
export function runPromptHealth(ctx: { now: number; dataDir: string }, write: boolean): { findings: Finding[]; contractChars: number } {
	const { text, sizes, sources } = measure(ctx.dataDir);
	const state = advance(readState(ctx.dataDir), sizes, ctx.now);
	if (write) {
		const tmp = `${stateFile(ctx.dataDir)}.tmp`;
		writeFileSync(tmp, JSON.stringify(state));
		renameSync(tmp, stateFile(ctx.dataDir));
	}
	return { findings: [...sizeFindings(state, ctx.now), ...enforcedFindings(sources, ctx.now), ...capFindings(ctx.dataDir, ctx.now)], contractChars: text.length };
}

export const promptHealth: DoctorCheck = ctx => runPromptHealth(ctx, !ctx.dry).findings;

if (import.meta.main) {
	const dataDir = process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
	const dry = process.argv.includes("--dry");
	const { findings, contractChars } = runPromptHealth({ now: Date.now(), dataDir }, !dry);
	for (const f of findings) console.log(JSON.stringify(f));
	console.log(`RESULT ${JSON.stringify({ ms: Math.round(performance.now()), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024), contractChars })}`);
}
