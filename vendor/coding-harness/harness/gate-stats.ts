import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { gateLogFile } from "./gate/log.ts";
import type { GateRow } from "./gate/log.ts";
import type { AcceptedComment } from "./gate/escape.ts";
import { mistakeStats } from "./gate/mistakes.ts";
import type { MistakeStats } from "./gate/mistakes.ts";

/** The size of one read of a log file: rows are split from chunks of this many bytes, never from the whole file. */
export const LOG_CHUNK_BYTES = 64 * 1024;

export interface Row extends Omit<GateRow, "outcome"> {
	outcome: Record<string, string>;
	harness?: string;
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
	readUlw: number;
	whyAccepted: number;
}

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
	return {
		at: raw.at,
		session: typeof raw.session === "string" ? raw.session : cwd,
		cwd,
		repos: Object.keys(outcome),
		changed: typeof raw.changed === "number" ? raw.changed : 0,
		skills: Array.isArray(raw.skills) ? (raw.skills as unknown[]).filter((skill): skill is string => typeof skill === "string") : [],
		outcome,
		...(findings ? { findings } : {}),
		...(typeof raw.waiver === "string" ? { waiver: raw.waiver } : {}),
		...(typeof raw.harness === "string" ? { harness: raw.harness } : {}),
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
			if (!row) skipped++;
			else if (Date.parse(row.at) >= since) rows.push(row);
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

	const userWaived = rows.filter(row => Object.values(row.outcome).includes("user-waived")).length;
	const summary: Summary = { rows: rows.length, counts, runs: runs.length, withChanges: 0, firstTryPass: 0, blockedRuns: 0, blockedThenFixed: 0, neverFinished: unfinished.length, unsatisfied: 0, unverified: 0, ungated: 0, userWaived, refusals, noGate: {}, readUlw: 0, whyAccepted: rows.reduce((sum, row) => sum + (row.why?.length ?? 0), 0) };
	for (const run of runs) {
		const last = run[run.length - 1];
		const first = run.find(row => overall(row) !== "running") ?? run[0];
		const changes = run.some(row => row.changed > 0);
		const blocked = run.some(row => overall(row) === "blocked");
		if (changes) {
			summary.withChanges++;
			if (["pass", "waived"].includes(overall(first))) summary.firstTryPass++;
			if (run.some(row => row.skills.includes("ulw"))) summary.readUlw++;
		}
		if (blocked) {
			summary.blockedRuns++;
			if (overall(last) === "fixed") summary.blockedThenFixed++;
		}
		if (overall(last) === "unsatisfied") summary.unsatisfied++;
		if (run.some(row => (row.unverified?.length ?? 0) > 0)) summary.unverified++;
		if (run.some(row => (row.ungated?.length ?? 0) > 0)) summary.ungated++;
		for (const repo of new Set(run.flatMap(row => Object.entries(row.outcome).filter(([, outcome]) => outcome === "no-gate").map(([name]) => name)))) summary.noGate[repo] = (summary.noGate[repo] ?? 0) + 1;
	}
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
		`  read skill://ulw:     ${share(summary.readUlw, summary.withChanges)}`,
		"",
		"stops refused, per finding class:",
	);
	const classes = Object.entries(summary.refusals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	lines.push(...(classes.length ? classes.map(([name, count]) => `  ${String(count).padStart(4)}  ${name}`) : ["  none"]), "", `why comments accepted as outside constraints (to check): ${summary.whyAccepted}`, "", "repos edited without a gate file (runs):");
	const repos = Object.entries(summary.noGate).sort((a, b) => b[1] - a[1]);
	lines.push(...(repos.length ? repos.map(([repo, runs]) => `  ${String(runs).padStart(4)}  ${repo}`) : ["  none"]));
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
}
