import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { agentHome } from "./agent-home.ts";
import { gateLogFile, parseCheckRow } from "./gate/log.ts";
import type { GateRow } from "./gate/log.ts";
import { skillsRead } from "./gate/tool-paths.ts";
import { isRecord, list } from "./gate/util.ts";
import type { AcceptedComment } from "./gate/escape.ts";
import { mistakeStats } from "./gate/mistakes.ts";
import type { MistakeStats } from "./gate/mistakes.ts";

/** The size of one read of a log file: rows are split from chunks of this many bytes, never from the whole file. */
export const LOG_CHUNK_BYTES = 64 * 1024;

export interface Row extends Omit<GateRow, "outcome"> {
	outcome: Record<string, string>;
	harness?: string;
	folder?: Record<string, string>;
}

export interface Summary {
	rows: number;
	counts: Record<string, number>;
	runs: number;
	withChanges: number;
	firstTryPass: number;
	blockedRuns: number;
	blockedThenFixed: number;
	neverFinished: number;
	unsatisfied: number;
	unverified: number;
	ungated: number;
	userWaived: number;
	refusals: Record<string, number>;
	noGate: Record<string, number>;
	slots: Record<string, number>;
	heavyRuns: number;
	readUlw: number;
	whyAccepted: number;
}

const HEAVY_FILES = 3;

export const OUTCOMES = ["clean", "pass", "blocked", "running", "deferred", "fixed", "waived", "user-waived", "unsatisfied", "no-gate", "error"];
const PRECEDENCE = ["blocked", "running", "error", "unsatisfied", "deferred", "user-waived", "waived", "fixed", "pass", "clean", "no-gate"];

function countsOf(value: unknown): Record<string, number> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const counts: Record<string, number> = {};
	for (const [key, count] of Object.entries(value)) if (typeof count === "number" && Number.isFinite(count)) counts[key] = count;
	return counts;
}

function whyOf(value: unknown): AcceptedComment[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const accepted: AcceptedComment[] = [];
	for (const entry of value as unknown[]) {
		if (typeof entry !== "object" || entry === null) continue;
		const { file, line, text } = entry as Record<string, unknown>;
		if (typeof file === "string" && typeof line === "number" && typeof text === "string") accepted.push({ file, line, text });
	}
	return accepted;
}

export function parseRow(line: string): Row | undefined {
	let data: unknown;
	try {
		data = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof data !== "object" || data === null) return undefined;
	const raw = data as Record<string, unknown>;
	if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at)) || typeof raw.outcome !== "object" || raw.outcome === null) return undefined;
	const outcome: Record<string, string> = {};
	for (const [repo, value] of Object.entries(raw.outcome)) if (typeof value === "string") outcome[repo] = value;
	const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
	const findings = countsOf(raw.findings);
	const why = whyOf(raw.why);
	const unverified = Array.isArray(raw.unverified) ? (raw.unverified as unknown[]).filter((repo): repo is string => typeof repo === "string") : [];
	const ungated = Array.isArray(raw.ungated) ? (raw.ungated as unknown[]).filter((repo): repo is string => typeof repo === "string") : [];
	const skillFiles = Array.isArray(raw.skillFiles) ? (raw.skillFiles as unknown[]).filter((ref): ref is string => typeof ref === "string") : [];
	const folders = isRecord(raw.folder) ? Object.entries(raw.folder).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "") : [];
	return {
		at: raw.at,
		session: typeof raw.session === "string" ? raw.session : cwd,
		cwd,
		repos: Object.keys(outcome),
		changed: typeof raw.changed === "number" ? raw.changed : 0,
		skills: Array.isArray(raw.skills) ? (raw.skills as unknown[]).filter((skill): skill is string => typeof skill === "string") : [],
		outcome,
		...(skillFiles.length ? { skillFiles } : {}),
		...(raw.delegated === true ? { delegated: true } : {}),
		...(findings ? { findings } : {}),
		...(typeof raw.waiver === "string" ? { waiver: raw.waiver } : {}),
		...(typeof raw.harness === "string" ? { harness: raw.harness } : {}),
		...(folders.length > 0 ? { folder: Object.fromEntries(folders) } : {}),
		...(why ? { why } : {}),
		...(unverified.length ? { unverified } : {}),
		...(ungated.length ? { ungated } : {}),
	};
}

function eachLine(file: string, visit: (line: string) => void): void {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return;
	}
	try {
		const chunk = Buffer.allocUnsafe(LOG_CHUNK_BYTES);
		const decoder = new StringDecoder("utf8");
		let rest = "";
		for (;;) {
			const read = readSync(fd, chunk, 0, chunk.length, null);
			if (read === 0) break;
			const lines = (rest + decoder.write(chunk.subarray(0, read))).split("\n");
			rest = lines.pop() ?? "";
			for (const line of lines) visit(line);
		}
		visit(rest + decoder.end());
	} finally {
		closeSync(fd);
	}
}

/** Rows of the last `days` days from `<file>.1` and then `<file>`, oldest first, read line by line; `skipped` counts lines that are not a row. */
export function readRows(file: string, days: number, now = Date.now()): { rows: Row[]; skipped: number } {
	const since = now - days * 86_400_000;
	const rows: Row[] = [];
	let skipped = 0;
	for (const path of [`${file}.1`, file]) {
		eachLine(path, line => {
			if (line.trim() === "") return;
			const row = parseRow(line);
			if (!row) {
				if (parseCheckRow(line) === undefined) skipped++;
			} else if (Date.parse(row.at) >= since) rows.push(row);
		});
	}
	return { rows: rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), skipped };
}

const TEMP_ROOTS = [...new Set(["/tmp", "/private/tmp", tmpdir(), realpathSync(tmpdir())])].map(root => root.replace(/\/+$/, ""));

/** Whether a stop ran with its working directory in a temp directory: gate verification sandboxes and scratch repos, not the user's work. */
export const isScratch = (row: Row): boolean => TEMP_ROOTS.some(root => row.cwd === root || row.cwd.startsWith(`${root}/`));

/** The rows that measure real work (temp-directory stops dropped), how many were dropped, and the hours the kept rows span, which can be far less than the days asked for when the log is young. */
export function countable(rows: readonly Row[]): { rows: Row[]; excluded: number; spanHours: number; first?: string } {
	const kept = rows.filter(row => !isScratch(row));
	const first = kept[0]?.at;
	const last = kept[kept.length - 1]?.at;
	const spanHours = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 360_000) / 10 : 0;
	return { rows: kept, excluded: rows.length - kept.length, spanHours, ...(first ? { first } : {}) };
}

const overall = (row: Row): string => PRECEDENCE.find(outcome => Object.values(row.outcome).includes(outcome)) ?? "clean";

/** The name a repo of `row` is grouped and listed by: the folder the row's `folder` map gives for it (the repo is a checkout slot of that folder), else the repo itself. */
export function repoLabel(row: Row, repo: string): string {
	return row.folder?.[repo] ?? repo;
}

/** The runs of `rows` (oldest first): each is the stretch of one session's stops from the first refusal to the stop finally allowed, an allowed stop with no refusal before it being a run of its own; `unfinished` counts the runs that ended without an allowed stop. */
export function runsOf(rows: readonly Row[]): { runs: Row[][]; unfinished: number } {
	const runs: Row[][] = [];
	const open = new Map<string, Row[]>();
	for (const row of rows) {
		const run = open.get(row.session) ?? [];
		run.push(row);
		if (["blocked", "running"].includes(overall(row))) {
			open.set(row.session, run);
		} else {
			open.delete(row.session);
			runs.push(run);
		}
	}
	const unfinished = [...open.values()];
	runs.push(...unfinished);
	return { runs, unfinished: unfinished.length };
}

/**
 * A run is the stretch of one session's stops from the first refusal to the stop finally allowed; an allowed stop with no
 * refusal before it is a run of its own. First-try pass: the run's first evaluation was `pass` or `waived`. A stop refused
 * for findings counts once towards each `stage:class` among them. A run with a row that has `unverified` finished with
 * nothing run after its last source edit; one with a row that has `ungated` finished in a repo that still had no gate file
 * after being asked for one.
 */
export function summarize(rows: readonly Row[]): Summary {
	const counts: Record<string, number> = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]));
	for (const row of rows) for (const outcome of Object.values(row.outcome)) counts[outcome] = (counts[outcome] ?? 0) + 1;
	const refusals: Record<string, number> = {};
	for (const row of rows) {
		if (!["blocked", "running"].includes(overall(row))) continue;
		for (const name of Object.keys(row.findings ?? {})) refusals[name] = (refusals[name] ?? 0) + 1;
	}

	const { runs, unfinished } = runsOf(rows);

	const userWaived = rows.filter(row => Object.values(row.outcome).includes("user-waived")).length;
	const summary: Summary = { rows: rows.length, counts, runs: runs.length, withChanges: 0, firstTryPass: 0, blockedRuns: 0, blockedThenFixed: 0, neverFinished: unfinished, unsatisfied: 0, unverified: 0, ungated: 0, userWaived, refusals, noGate: {}, slots: {}, heavyRuns: 0, readUlw: 0, whyAccepted: rows.reduce((sum, row) => sum + (row.why?.length ?? 0), 0) };
	for (const run of runs) {
		const last = run[run.length - 1];
		const first = run.find(row => overall(row) !== "running") ?? run[0];
		const changes = run.some(row => row.changed > 0);
		const blocked = run.some(row => overall(row) === "blocked");
		if (changes) {
			summary.withChanges++;
			if (["pass", "waived"].includes(overall(first))) summary.firstTryPass++;
		}
		if (run.some(row => row.changed > HEAVY_FILES || row.delegated === true)) {
			summary.heavyRuns++;
			if (run.some(row => row.skills.includes("ulw"))) summary.readUlw++;
		}
		if (blocked) {
			summary.blockedRuns++;
			if (overall(last) === "fixed") summary.blockedThenFixed++;
		}
		if (overall(last) === "unsatisfied") summary.unsatisfied++;
		if (run.some(row => (row.unverified?.length ?? 0) > 0)) summary.unverified++;
		if (run.some(row => (row.ungated?.length ?? 0) > 0)) summary.ungated++;
		for (const repo of new Set(run.flatMap(row => Object.entries(row.outcome).filter(([, outcome]) => outcome === "no-gate").map(([name]) => repoLabel(row, name))))) summary.noGate[repo] = (summary.noGate[repo] ?? 0) + 1;
	}
	const slotsOf = new Map<string, Set<string>>();
	for (const row of rows) {
		for (const repo of Object.keys(row.outcome)) {
			const label = repoLabel(row, repo);
			if (label !== repo) slotsOf.set(label, (slotsOf.get(label) ?? new Set()).add(repo));
		}
	}
	for (const [folder, slots] of slotsOf) summary.slots[folder] = slots.size;
	return summary;
}

const share = (part: number, whole: number): string => (whole === 0 ? "n/a" : `${part}/${whole} (${Math.round((100 * part) / whole)}%)`);

function mistakeLines(mistakes: MistakeStats): string[] {
	const kinds = Object.entries(mistakes.byKind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return [
		"mistake obligations:",
		`  opened:     ${mistakes.opened}`,
		`  resolved:   ${mistakes.resolved}${kinds.length ? ` (${kinds.map(([kind, count]) => `${kind} ${count}`).join(", ")})` : ""}`,
		`  unencoded:  ${mistakes.unencoded}`,
		`  refused checks: ${mistakes.refused}`,
		`  encoded share of the closed ones: ${share(mistakes.resolved, mistakes.resolved + mistakes.unencoded)}`,
	];
}

/** Stops, runs with changes and first-try pass rate per harness commit (first 12 characters of the row's `harness`; `unknown` for rows without one); no lines when no row carries one. */
export function harnessLines(rows: readonly Row[]): string[] {
	if (!rows.some(row => row.harness !== undefined)) return [];
	const groups = new Map<string, Row[]>();
	for (const row of rows) {
		const key = row.harness === undefined ? "unknown" : row.harness.slice(0, 12);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const lines = ["by harness commit:"];
	for (const [key, group] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
		const summary = summarize(group);
		lines.push(`  ${key.padEnd(12)}  ${String(group.length).padStart(5)} stops  ${String(summary.runs).padStart(4)} runs  first-try pass ${share(summary.firstTryPass, summary.withChanges)}`);
	}
	return lines;
}

const PLAYBOOKS = "ulw/playbooks/";

/** The directory names under `<agent home>/skills` that hold a SKILL.md, sorted. */
export function installedSkills(): string[] {
	const root = join(agentHome(), "skills");
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	return entries.filter(name => existsSync(join(root, name, "SKILL.md"))).sort();
}

const byCount = (counts: Map<string, number>): string[] => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => `  ${String(count).padStart(4)}  ${name}`);

/** How many runs read each skill (the rows' `skills`) and each playbook (the `skillFiles` under `ulw/playbooks/`), most first, then the `installed` skills no run read. A run counts a skill once however many of its stops list it. */
export function skillUseLines(rows: readonly Row[], installed: readonly string[]): string[] {
	const { runs } = runsOf(rows);
	const skills = new Map<string, number>();
	const playbooks = new Map<string, number>();
	for (const run of runs) {
		for (const name of new Set(run.flatMap(row => row.skills))) skills.set(name, (skills.get(name) ?? 0) + 1);
		for (const ref of new Set(run.flatMap(row => row.skillFiles ?? []).filter(file => file.startsWith(PLAYBOOKS)))) playbooks.set(ref, (playbooks.get(ref) ?? 0) + 1);
	}
	const unread = installed.filter(name => !skills.has(name));
	return [
		`runs that read each skill (of ${runs.length} runs):`,
		...(skills.size ? byCount(skills) : ["  none"]),
		"runs that read each playbook:",
		...(playbooks.size ? byCount(playbooks) : ["  none"]),
		`skills with zero reads (${unread.length}): ${unread.join(", ")}`,
	];
}

/** What one worker session did: the skills it read and the rules injected into it. */
export interface WorkerUse {
	file: string;
	skills: string[];
	rules: string[];
}

function workerFiles(dir: string, depth: number, out: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) workerFiles(path, depth + 1, out);
		else if (depth >= 1 && entry.name.endsWith(".jsonl") && entry.name !== "changes.jsonl") out.push(path);
	}
}

function workerUse(file: string): WorkerUse | undefined {
	const skills = new Set<string>();
	const rules = new Set<string>();
	let assistant = false;
	eachLine(file, line => {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(value)) return;
		if (value.type === "ttsr_injection") {
			for (const rule of list(value.injectedRules) ?? []) if (typeof rule === "string") rules.add(rule);
			return;
		}
		const message = value.type === "message" && isRecord(value.message) ? value.message : undefined;
		if (message?.role !== "assistant") return;
		assistant = true;
		for (const part of list(message.content) ?? []) {
			if (!isRecord(part) || part.type !== "toolCall" || !isRecord(part.arguments)) continue;
			const tool = typeof part.name === "string" ? part.name : undefined;
			for (const name of skillsRead(tool, part.arguments)) skills.add(name);
		}
	});
	return assistant ? { file, skills: [...skills].sort(), rules: [...rules].sort() } : undefined;
}

/** The worker sessions under `root` (`<root>/<cwd-slug>/<main session>/…/<worker>.jsonl`, never the main session files or `changes.jsonl`) last modified within `days` days of `now`, each with the skills it read and the rules injected into it; files with no assistant message are dropped and unreadable lines ignored. */
export function workerUses(days: number, root = join(homedir(), ".omp", "agent", "sessions"), now = Date.now()): WorkerUse[] {
	const files: string[] = [];
	let slugs: Dirent[];
	try {
		slugs = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const slug of slugs) if (slug.isDirectory()) workerFiles(join(root, slug.name), 0, files);
	const since = now - days * 86_400_000;
	const uses: WorkerUse[] = [];
	for (const file of files.sort()) {
		let mtime: number;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			continue;
		}
		if (mtime < since) continue;
		const use = workerUse(file);
		if (use) uses.push(use);
	}
	return uses;
}

/** Per skill and per injected rule the number of workers that read or got it, most first, under the number of workers scanned, and the count of workers that read `typescript-best-practices`. */
export function workerUseLines(uses: readonly WorkerUse[]): string[] {
	const skills = new Map<string, number>();
	const rules = new Map<string, number>();
	for (const use of uses) {
		for (const name of new Set(use.skills)) skills.set(name, (skills.get(name) ?? 0) + 1);
		for (const name of new Set(use.rules)) rules.set(name, (rules.get(name) ?? 0) + 1);
	}
	return [
		`workers scanned: ${uses.length}`,
		"workers that read each skill:",
		...(skills.size ? byCount(skills) : ["  none"]),
		"workers that got each injected rule:",
		...(rules.size ? byCount(rules) : ["  none"]),
		`workers that read typescript-best-practices: ${skills.get("typescript-best-practices") ?? 0}`,
	];
}

export function render(summary: Summary, days: number, skipped = 0, mistakes?: MistakeStats): string {
	const lines = [`done gate, last ${days} day${days === 1 ? "" : "s"}: ${summary.rows} stops in ${summary.runs} runs${skipped ? `, ${skipped} unreadable lines skipped` : ""}`, "", "outcomes (per repo and stop):"];
	for (const outcome of Object.keys(summary.counts)) lines.push(`  ${outcome.padEnd(12)} ${summary.counts[outcome]}`);
	lines.push(
		"",
		`runs with changes: ${summary.withChanges}`,
		`  first-try pass rate:  ${share(summary.firstTryPass, summary.withChanges)}`,
		`  blocked then fixed:   ${share(summary.blockedThenFixed, summary.blockedRuns)} of the refused runs; ${summary.neverFinished} never finished`,
		`  unsatisfied (the gate gave up and let the session finish): ${summary.unsatisfied}`,
		`  unverified (finished with source changed and nothing run after the last edit): ${summary.unverified}`,
		`  ungated (finished with source changed in a repo with no gate file, after being asked for one): ${summary.ungated}`,
		`  let through by /gate-ok (user-waived stops): ${summary.userWaived}`,
		`  read skill://ulw, over HEAVY runs only (more than ${HEAVY_FILES} files changed or a writing worker spawned): ${share(summary.readUlw, summary.heavyRuns)}`,
		"",
		"stops refused, per finding class:",
	);
	const classes = Object.entries(summary.refusals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	lines.push(...(classes.length ? classes.map(([name, count]) => `  ${String(count).padStart(4)}  ${name}`) : ["  none"]), "", `why comments accepted as outside constraints (to check): ${summary.whyAccepted}`, "", "repos edited without a gate file (runs):");
	const repos = Object.entries(summary.noGate).sort((a, b) => b[1] - a[1]);
	lines.push(...(repos.length ? repos.map(([repo, runs]) => `  ${String(runs).padStart(4)}  ${repo}${(summary.slots[repo] ?? 0) > 1 ? ` (${summary.slots[repo]} slots)` : ""}`) : ["  none"]));
	if (mistakes) lines.push("", ...mistakeLines(mistakes));
	return lines.join("\n");
}

if (import.meta.main) {
	const arg = process.argv[2];
	const days = arg === undefined ? 7 : Number(arg);
	if (!(Number.isFinite(days) && days > 0)) {
		console.error("usage: bun harness/gate-stats.ts [days]");
		process.exit(2);
	}
	const file = gateLogFile();
	const { rows, skipped } = readRows(file, days);
	if (!existsSync(file)) console.log(`no gate log yet: ${file}\n`);
	const scope = countable(rows);
	console.log(`${scope.excluded} stops in temp directories excluded; the counted stops span ${scope.spanHours}h${scope.first ? ` from ${scope.first}` : ""} (window asked: ${days} day${days === 1 ? "" : "s"})\n`);
	console.log(render(summarize(scope.rows), days, skipped, mistakeStats(days)));
	const byHarness = harnessLines(scope.rows);
	if (byHarness.length) console.log(`\n${byHarness.join("\n")}`);
	console.log(`\n${skillUseLines(scope.rows, installedSkills()).join("\n")}`);
	console.log(`\n${workerUseLines(workerUses(days)).join("\n")}`);
}
