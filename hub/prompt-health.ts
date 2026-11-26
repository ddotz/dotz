// Daily prompt health check of the doctor (no model call, reads files only). It measures the whole contract the orchestrator re-reads after a
// compaction (hub/recall-contract.ts, the builder extension/index.ts recall() uses, called without modeInSystem so identity and MODE are in it
// wherever a runtime keeps them) and reports three things as findings:
//   1. size: the text or one of its parts grew well past a baseline kept in <DATA_DIR>/prompt-health.json
//   2. enforced: a line still spells out a rule that code already enforces (hub/enforced-rules.ts); a proposal, nothing is edited
//   3. caps: a prompt file past its size limit (LESSONS.md, RULES.md) or a feature line past INLINE_MAX
// `bun hub/prompt-health.ts --dry` prints the findings and a RESULT line and writes no state.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { THRESHOLDS } from "./doctor-limits.ts";
import { type DoctorCheck, EVIDENCE_CHARS, evidenceLines, type Finding, lineSubject } from "./doctor-types.ts";
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
export const BOUNDARIES_MAX_CHARS = 4_000;

export const PART_KEYS = ["mode", "rules", "lessons", "identity", "features", "owner", "setups", "state", "rest"] as const;
export const CONTRACT_SHAPE = 3;
export type Sizes = Record<string, number>;
type Base = { chars: number; at: number };
/** baseline: the lowest size seen per key and when it was set; last: the sizes of the latest run. Key "total" is the whole text. */
export type PromptState = { baseline: Record<string, Base>; last: Sizes; shape: number };

export const stateFile = (dataDir: string): string => join(dataDir, "prompt-health.json");

export function readState(dataDir: string): PromptState | undefined {
	try {
		const raw = JSON.parse(readFileSync(stateFile(dataDir), "utf8"));
		return raw && typeof raw.baseline === "object" && typeof raw.last === "object" && raw.shape === CONTRACT_SHAPE ? (raw as PromptState) : undefined;
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
	const out = [source(modeFile, parts.mode), source(join(dataDir, "RULES.md"), parts.rules), source(join(dataDir, "memory", "boundaries.md"), parts.boundaries), source(join(dataDir, "LESSONS.md"), parts.lessons)];
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
	const sizes: Sizes = { total: text.length, mode: parts.mode.length, rules: parts.rules.length + parts.boundaries.length, lessons: parts.lessons.length, identity: parts.identity.length, features: parts.features.length, owner: parts.owner.length, setups: parts.setups.length, state: parts.state.length };
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
	return { baseline, last: sizes, shape: CONTRACT_SHAPE };
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
		what: m.promptGrew(g.key === "total" ? undefined : (m.promptPartLabels[g.key] ?? g.key), g.from, g.to, m.doctor.day(g.at)),
		ask: true,
		evidence: evidenceLines([m.promptSizeEvidence(g.from, g.to, day(g.at))], m.doctor.more),
		since: now,
		level: g.to - g.from,
	}));
}

// A blocked-command entry ("- deny: <regex> | <reason>", the RULES.md format hub/harnessprojects.ts denyLines reads) is the guard's own
// configuration, not a rule written out beside it: removing it would remove the guard, so it is never proposed.
const DENY_ENTRY = /^\s*- deny:\s/;

/** The edit a prompt card proposes (see `Finding.change`). */
export type Change = NonNullable<Finding["change"]>;
/** A prompt card as its check builds it: its lines, its title parts and its two options. */
export type PromptCard = { evidence: string[] } & NonNullable<Finding["decide"]>;

/** Where a quoted line is: the one file line it is, or why there is not exactly one. */
export type Located = { kind: "found"; path: string; file: string; line: number; text: string } | { kind: "nowhere" } | { kind: "files"; files: string[] } | { kind: "twice"; file: string };

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const PKG = join(import.meta.dir, "..");

/** A line as compared between a quote and a file: spacing squashed, a leading list mark dropped. */
export const bareLine = (s: string): string => squash(s).replace(/^[-*+] +/, "");

/** The one line of the files in `sources` that `quote` is (whole, ignoring spacing and a list mark; a feature line with `{repo}` as the re-read text has it), read from the files themselves, so `line` is the file's own line number and `text` the line as written. */
export function locate(quote: string, sources: Pick<RuleSource, "path" | "file">[]): Located {
	const want = bareLine(quote), hits: Extract<Located, { kind: "found" }>[] = [], seen = new Set<string>();
	if (!want) return { kind: "nowhere" };
	for (const s of sources) {
		if (seen.has(s.path) || !existsSync(s.path)) continue;
		seen.add(s.path);
		const feature = basename(s.path) === "feature.md";
		readFileSync(s.path, "utf8").split(/\r?\n/).forEach((text, i) => {
			if (bareLine(feature ? text.replaceAll("{repo}", PKG) : text) === want) hits.push({ kind: "found", path: s.path, file: s.file, line: i + 1, text });
		});
	}
	const files = [...new Set(hits.map(h => h.path))];
	if (files.length > 1) return { kind: "files", files: [...new Set(hits.map(h => h.file))] };
	const [hit] = hits;
	if (hits.length > 1 && hit) return { kind: "twice", file: hit.file };
	return hit ?? { kind: "nowhere" };
}

/** Why a line was not found exactly once, for a log line. */
export function notOne(at: Exclude<Located, { kind: "found" }>): string {
	switch (at.kind) {
		case "nowhere":
			return "it is in no re-read file";
		case "files":
			return `it is in ${at.files.join(" and ")}`;
		case "twice":
			return `it is in ${at.file} more than once`;
		default: {
			const _exhaustive: never = at;
			return _exhaustive;
		}
	}
}

/** An apply option's result, with the undo sentence only when git tracks the file at `path` itself (git is asked only when a folder above it holds `.git`; when git cannot be run, the sentence is left out). */
export function withUndo(result: string, path: string): string {
	for (let dir = dirname(path); !existsSync(join(dir, ".git")); dir = dirname(dir)) if (dirname(dir) === dir) return result;
	try {
		const git = Bun.spawnSync(["git", "-C", dirname(path), "ls-files", "--error-unmatch", "--", basename(path)], { stdout: "ignore", stderr: "ignore", timeout: 10_000 });
		return git.exitCode === 0 ? `${result} ${msg().promptUndo}` : result;
	} catch (e) {
		console.error(`prompt health: git could not be run for ${path} (${(e as Error).message}); the card has no undo sentence`);
		return result;
	}
}

const BACK = 16;

function shownEnd(x: string[], start: number, room: number, need: number): { end: number; atWord: boolean } {
	const lead = start > 0 ? 1 : 0;
	if (lead + x.length - start <= room) return { end: x.length, atWord: true };
	const last = start + room - lead - 1;
	for (let p = last; p >= need && p > start; p--) if (x[p] === " ") return { end: p, atWord: true };
	return { end: last, atWord: false };
}

function changedParts(from: string, to: string, room: number): { parts: [string, string]; whole: boolean } {
	const a = [...squash(from)], b = [...squash(to)];
	let same = 0, tail = 0;
	while (same < a.length && same < b.length && a[same] === b[same]) same++;
	while (tail < a.length - same && tail < b.length - same && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const need = (x: string[]): number => (same < x.length ? (x[same] === " " ? same + 2 : same + 1) : x.length);
	const whole = (x: string[]): number => Math.max(need(x), Math.min(x.length, x.length - tail + 1));
	const starts = [0, ...a.flatMap((c, i) => (c === " " && i + 1 <= same - BACK ? [i + 1] : []))];
	const fits = (start: number, want: (x: string[]) => number, atWord: boolean) => [a, b].every(x => {
		const cut = shownEnd(x, start, room, need(x));
		return cut.end >= want(x) && (cut.atWord || !atWord);
	});
	const start = starts.find(s => fits(s, whole, true)) ?? starts.find(s => fits(s, need, true)) ?? starts.find(s => fits(s, need, false)) ?? Math.max(0, same - BACK);
	const part = (x: string[]): string => {
		const { end } = shownEnd(x, start, room, need(x));
		return `${start > 0 ? "…" : ""}${x.slice(start, end).join("").trim()}${end < x.length ? "…" : ""}`;
	};
	return { parts: [part(a), part(b)], whole: fits(start, whole, false) };
}

const LEAD_WORDS = 2, TRAIL_WORDS = 1;
type Stretch = { a: [number, number]; b: [number, number] };

function stretchesOf(a: string[], b: string[]): Stretch[] {
	let head = 0, foot = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	while (foot < a.length - head && foot < b.length - head && a[a.length - 1 - foot] === b[b.length - 1 - foot]) foot++;
	const n = a.length - head - foot, m = b.length - head - foot, left = new Uint16Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) left[i * (m + 1) + j] = a[head + i] === b[head + j] ? left[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(left[(i + 1) * (m + 1) + j]!, left[i * (m + 1) + j + 1]!);
	const out: Stretch[] = [];
	let i = 0, j = 0, open: Stretch | undefined;
	while (i < n || j < m) {
		if (i < n && j < m && a[head + i] === b[head + j] && left[i * (m + 1) + j] === left[(i + 1) * (m + 1) + j + 1]! + 1) {
			open = undefined;
			i++;
			j++;
			continue;
		}
		if (!open) out.push((open = { a: [head + i, head + i], b: [head + j, head + j] }));
		if (j >= m || (i < n && left[(i + 1) * (m + 1) + j]! >= left[i * (m + 1) + j + 1]!)) open.a[1] = head + ++i;
		else open.b[1] = head + ++j;
	}
	return out.reduce<Stretch[]>((merged, s) => {
		const last = merged.at(-1);
		if (last && s.a[0] - last.a[1] <= LEAD_WORDS + TRAIL_WORDS) {
			last.a[1] = s.a[1];
			last.b[1] = s.b[1];
		} else merged.push(s);
		return merged;
	}, []);
}

function stretchParts(from: string, to: string, room: number, window: [string, string]): { parts: [string, string]; left: number } | undefined {
	const a = squash(from).split(" "), b = squash(to).split(" "), all = stretchesOf(a, b);
	if (all.length < 2) return undefined;
	const side = (x: string[], key: keyof Stretch, shown: Stretch[]): string => {
		const spans = shown.map((s, i) => [Math.max(s[key][0] - LEAD_WORDS, i ? shown[i - 1]![key][1] : 0), Math.min(s[key][1] + TRAIL_WORDS, x.length)] as const);
		return `${spans[0]![0] > 0 ? "…" : ""}${spans.map(([s, e]) => x.slice(s, e).join(" ")).join(" … ")}${spans.at(-1)![1] < x.length ? "…" : ""}`;
	};
	for (let k = all.length; k > 0; k--) {
		const parts: [string, string] = [side(a, "a", all.slice(0, k)), side(b, "b", all.slice(0, k))];
		if (parts.every(p => [...p].length <= room)) return { parts, left: all.length - k };
	}
	return { parts: window, left: all.length - 1 };
}

/** The first lines of a card that proposes `change`: the kind with the file and line, then the line as it is and what it becomes (on a long line both open at the earliest word that lets the changed part show, at least its first character, never later than shortly before it; a line ends inside a word when no space is in reach), or the one line to delete. When the changes of a long line do not fit one window, both lines show each changed place with the words around it, `…` between them, and the places that do not fit either are counted on a line of their own. */
export function editLines(kind: string, shown: string, change: Change): string[] {
	const m = msg(), head = `${kind} · ${m.promptAt(shown, change.line)}`;
	if (!change.to) return [head, m.promptDelete(squash(change.from))];
	const room = EVIDENCE_CHARS - Math.max([...m.promptBefore("")].length, [...m.promptAfter("")].length), one = changedParts(change.from, change.to, room);
	const apart = one.whole ? undefined : stretchParts(change.from, change.to, room, one.parts), [from, to] = apart?.parts ?? one.parts;
	return [apart?.left ? `${head} · ${m.promptMoreChanges(apart.left)}` : head, m.promptBefore(from), m.promptAfter(to)];
}

/** The card about a line that spells out an enforced rule: the kind with file and line, the line to delete, and what already enforces it; titled by the text and the line. */
export function ruleCard(c: { rule: string; guard: string; shown: string; change: Change }): PromptCard {
	const m = msg(), t = m.doctor;
	const words: Record<string, string> = {
		"limit-stop": m.promptGuardLimitStop,
		"expensive-model": m.promptGuardExpensiveModel,
		"gateway-restart": m.promptGuardGatewayRestart,
		"brief-done-when": m.promptGuardBriefDoneWhen,
		"session-min-hours": m.promptGuardSessionMinHours,
		"recommend-mark": m.promptGuardRecommendMark,
		"telemetry-off": m.promptGuardTelemetryOff,
	};
	return {
		evidence: evidenceLines([...editLines(t.ruleKind, c.shown, c.change), m.promptGuard(words[c.rule] ?? c.guard, c.guard)], t.more),
		subject: lineSubject(t, c.shown, c.change.from, t.ruleQuestion),
		question: t.ruleQuestion,
		options: [{ name: m.promptRemove, result: withUndo(m.promptRemoveResult(c.shown), c.change.file) }, { name: m.promptKeep, result: m.promptKeepResult(THRESHOLDS.repeatDays), keep: true }],
	};
}

/** One finding per enforced rule that a rule file line still writes out: in the first source whose first such line is found exactly once in its file, carried as a deletion in `change`; a rule written out only where no one line is found gives none and one log line. */
export function enforcedFindings(sources: RuleSource[], now: number, log: (line: string) => void = line => console.error(line)): Finding[] {
	const m = msg();
	const out: Finding[] = [];
	for (const rule of ENFORCED_RULES) {
		const missed: string[] = [];
		for (const s of sources) {
			const line = s.lines.find(l => !DENY_ENTRY.test(l) && rule.match.test(l));
			if (line === undefined) continue;
			const at = locate(line, [s]);
			if (at.kind !== "found") {
				missed.push(`${s.file}: ${notOne(at)}`);
				continue;
			}
			const guard = rule.guard.split(":")[0]!, change = { file: at.path, line: at.line, from: at.text, to: "" };
			const { evidence, ...decide } = ruleCard({ rule: rule.id, guard, shown: at.file, change });
			out.push({ key: `prompt:enforced:${rule.id}`, area: "prompt", what: m.promptEnforced(`${at.file}:${at.line}`, guard), evidence, since: now, level: line.length, decide, change });
			missed.length = 0;
			break;
		}
		if (missed.length) log(`prompt health: no card for the enforced rule ${rule.id}: ${missed.join("; ")}`);
	}
	return out;
}

/** Prompt files past a limit. LESSONS.md: bytes against the gate's cap. RULES.md and memory/boundaries.md: characters against their caps. A feature: its always-loaded line against INLINE_MAX. */
export function capFindings(dataDir: string, now: number): Finding[] {
	const m = msg();
	const out: Finding[] = [];
	const over = (file: string, size: number, cap: number, unit: string, what = m.promptCapOver(file, size, cap, unit)) => {
		if (size <= cap) return;
		out.push({ key: `prompt:cap:${file}`, area: "prompt", what, ask: true, evidence: evidenceLines([m.promptCapEvidence(size, cap, unit)], m.doctor.more), since: now, level: size - cap });
	};
	const read = (name: string): string | undefined => (existsSync(join(dataDir, name)) ? readFileSync(join(dataDir, name), "utf8") : undefined);
	const lessons = read("LESSONS.md");
	if (lessons !== undefined) over("LESSONS.md", Buffer.byteLength(lessons), LESSONS_MAX_BYTES, "bytes");
	const rules = read("RULES.md");
	if (rules !== undefined) over("RULES.md", rules.length, RULES_MAX_CHARS, "chars");
	const boundaries = read(join("memory", "boundaries.md"));
	if (boundaries !== undefined) over("memory/boundaries.md", boundaries.length, BOUNDARIES_MAX_CHARS, "chars", m.promptInboxOver(boundaries.length, BOUNDARIES_MAX_CHARS));
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
