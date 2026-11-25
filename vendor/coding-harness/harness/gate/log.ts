import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentHome, harnessDir, logsDir } from "../agent-home.ts";
import type { Outcome } from "./decision.ts";
import type { AcceptedComment } from "./escape.ts";
import { isRecord } from "./util.ts";

/** One line of gate.jsonl: what a stop decided, per repo, how many findings of each `stage:class` it had, the why comments it let stay, the repos it let finish with source changed and nothing run after the last edit (`unverified`), the repos it let finish with source changed and no gate file after asking for one (`ungated`), the checks it let an interactive session finish with while they still ran (`deferred`, by name), and the sub-paths of the skill files the run read (`skillFiles`, such as `ulw/playbooks/feature.md`; left out when it read none), whether the run handed writes to a worker or applied a patch (`delegated`, left out when it did not), and the commit the installed harness was set up from (`harness`, left out when `setupCommit` finds none), and the folder of each repo that is a main checkout (`folder`, by repo, as it was when the row was written; left out when none is). */
export interface GateRow {
	at: string;
	session: string;
	cwd: string;
	repos: string[];
	changed: number;
	skills: string[];
	skillFiles?: string[];
	delegated?: boolean;
	outcome: Record<string, Outcome>;
	findings?: Record<string, number>;
	waiver?: string;
	error?: string;
	warnings?: string[];
	unverified?: string[];
	ungated?: string[];
	deferred?: string[];
	harness?: string;
	why?: AcceptedComment[];
	folder?: Record<string, string>;
}

/** How a gate check's process ended: it exited 0 (`pass`), exited otherwise or could not start (`fail`), ran out of its `timeoutSec` (`timeout`), or was killed by the gate before it ended (`cancelled`). */
export type CheckResultKind = "pass" | "fail" | "timeout" | "cancelled";

/** One line of gate.jsonl for a check run that ended: the check's name, the repo it ran in, when it started and ended (ISO times), how long it ran in milliseconds, and how it ended. It has no `outcome`, so it is not a stop. */
export interface CheckRow {
	at: string;
	check: string;
	repo: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	result: CheckResultKind;
}

const isCheckResult = (value: unknown): value is CheckResultKind => value === "pass" || value === "fail" || value === "timeout" || value === "cancelled";

/** The check row `line` holds; undefined when it is any other line. */
export function parseCheckRow(line: string): CheckRow | undefined {
	let data: unknown;
	try {
		data = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(data)) return undefined;
	const { at, check, repo, startedAt, endedAt, durationMs, result } = data;
	if (typeof at !== "string" || typeof check !== "string" || typeof repo !== "string" || typeof startedAt !== "string" || typeof endedAt !== "string" || typeof durationMs !== "number") return undefined;
	if (!isCheckResult(result)) return undefined;
	return { at, check, repo, startedAt, endedAt, durationMs, result };
}

/** The last tree state a check passed on, kept per repo and check name: the fingerprint over the check's paths, the command, and, when the whole working tree (untracked files included, ignored ones left out) is known to have been the same before and after the run, its git tree id (`tree`). */
export interface Passed {
	fingerprint: string;
	command: string;
	tree?: string;
}

/** The directory the gate keeps its per-repo and per-run state in: DONE_GATE_STATE_DIR, or `gate-state` under `agentHome()`. */
export const stateDir = () => process.env.DONE_GATE_STATE_DIR ?? join(agentHome(), "gate-state");

/** A short name for `repo` that is safe in a file name; what the gate keeps for one repo lives under it. */
export const repoStateKey = (repo: string): string => createHash("sha256").update(repo).digest("hex").slice(0, 24);
const statePath = (repo: string) => join(stateDir(), `${repoStateKey(repo)}.json`);

/** Where every stop is logged: DONE_GATE_LOG_DIR/gate.jsonl. */
export const gateLogFile = () => join(process.env.DONE_GATE_LOG_DIR ?? logsDir(), "gate.jsonl");

/** The size at which gate.jsonl is moved to gate.jsonl.1 and a fresh gate.jsonl is started: 5 MiB. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

const COMMIT_ID = /^[0-9a-f]{7,64}$/;

/** The commit this copy of the harness was set up from: the first line of `.setup-version` in DONE_GATE_HARNESS_DIR, or in `harnessDir()`; undefined when the file is absent, unreadable, or its first line is not a commit id (7 to 64 lower-case hex digits). */
export function setupCommit(): string | undefined {
	try {
		const dir = process.env.DONE_GATE_HARNESS_DIR ?? harnessDir();
		const first = readFileSync(join(dir, ".setup-version"), "utf8").split("\n", 1)[0].trim();
		return COMMIT_ID.test(first) ? first : undefined;
	} catch {
		return undefined;
	}
}

export function readPassed(repo: string): Record<string, Passed> {
	const passed: Record<string, Passed> = {};
	try {
		const data: unknown = JSON.parse(readFileSync(statePath(repo), "utf8"));
		if (isRecord(data) && isRecord(data.checks)) {
			for (const [name, entry] of Object.entries(data.checks)) if (isRecord(entry) && typeof entry.fingerprint === "string" && typeof entry.command === "string") passed[name] = { fingerprint: entry.fingerprint, command: entry.command, ...(typeof entry.tree === "string" ? { tree: entry.tree } : {}) };
		}
	} catch {
		return passed;
	}
	return passed;
}

export function writePassed(repo: string, passed: Record<string, Passed>): void {
	try {
		mkdirSync(stateDir(), { recursive: true });
		const file = statePath(repo);
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify({ repo, checks: passed }));
		renameSync(temp, file);
	} catch {
		return;
	}
}

/** Records a pass of check `name` in `repo`. An entry without a `tree` leaves an equal recorded pass (same fingerprint and command) as it is, so it keeps the tree it was recorded with. */
export function recordPass(repo: string, name: string, entry: Passed): void {
	const all = readPassed(repo);
	const have = all[name];
	if (entry.tree === undefined && have?.fingerprint === entry.fingerprint && have.command === entry.command) return;
	writePassed(repo, { ...all, [name]: entry });
}

function rotate(file: string): void {
	try {
		if (statSync(file).size >= MAX_LOG_BYTES) renameSync(file, `${file}.1`);
	} catch {
		return;
	}
}

/** Appends one row (a stop's or an ended check run's) to gate.jsonl; a log that has reached 5 MiB is first moved to gate.jsonl.1, replacing the older one. A row that cannot be written is lost. */
export function appendRow(row: GateRow | CheckRow): void {
	try {
		const file = gateLogFile();
		mkdirSync(dirname(file), { recursive: true });
		rotate(file);
		appendFileSync(file, `${JSON.stringify(row)}\n`);
	} catch {
		return;
	}
}
