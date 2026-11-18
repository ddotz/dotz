import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gateLogFile } from "./gate/log.ts";

export const DEFAULT_SPLIT = "2026-11-16";
export const MAX_COMMITS_PER_WINDOW = 2000;
export const MAX_HUNKS_PER_COMMIT = 50;
export const FOLLOW_UP_DAYS = 7;
const DAY_SECONDS = 86_400;
const GIT_BUFFER_BYTES = 256 * 1024 * 1024;
const FIELD = "\x1f";
const RECORD = "\x1e";
const REVERT_BODY = /^This reverts commit [0-9a-f]{7,40}/m;
const FIX_SUBJECT = /\bfix|^(?:고침|수정|버그)\s*:/i;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;
const BLAME_HEADER = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/;

export interface WindowStats {
	label: string;
	commits: number;
	reverts: number;
	fixSubjects: number;
	followUpFixes: number;
}

export interface Commit {
	sha: string;
	time: number;
	parent: string | undefined;
	subject: string;
	body: string;
}

function git(repo: string, args: string[]): string {
	const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: GIT_BUFFER_BYTES });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${repo}: ${result.stderr.trim()}`);
	return result.stdout;
}

function listCommits(repo: string, args: string[], limit: number): Commit[] {
	const out = git(repo, ["log", "--no-merges", `-n${limit}`, ...args, `--format=%H${FIELD}%ct${FIELD}%P${FIELD}%s${FIELD}%b${RECORD}`]);
	const commits: Commit[] = [];
	for (const record of out.split(RECORD)) {
		const text = record.replace(/^\n/, "");
		if (text === "") continue;
		const [sha = "", time = "0", parents = "", subject = "", body = ""] = text.split(FIELD);
		commits.push({ sha, time: Number(time), parent: parents.split(" ")[0] || undefined, subject, body });
	}
	return commits;
}

/** Whether the commit is a revert: its subject starts with `Revert "` or its body has a `This reverts commit` line. */
export function isRevert(commit: Pick<Commit, "subject" | "body">): boolean {
	return commit.subject.startsWith('Revert "') || REVERT_BODY.test(commit.body);
}

interface Hunk {
	file: string;
	start: number;
	count: number;
}

function removedHunks(repo: string, commit: Commit & { parent: string }): Hunk[] {
	const diff = git(repo, ["-c", "core.quotepath=off", "diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", commit.parent, commit.sha]);
	const hunks: Hunk[] = [];
	let file: string | undefined;
	for (const line of diff.split("\n")) {
		if (line.startsWith("--- ")) {
			const path = line.slice(4).replace(/\t.*$/, "");
			file = path.startsWith("a/") ? path.slice(2) : undefined;
			continue;
		}
		const match = file === undefined ? null : HUNK_HEADER.exec(line);
		if (!match || file === undefined) continue;
		const count = match[2] === undefined ? 1 : Number(match[2]);
		if (count > 0) hunks.push({ file, start: Number(match[1]), count });
		if (hunks.length >= MAX_HUNKS_PER_COMMIT) break;
	}
	return hunks;
}

function blameTimes(repo: string, rev: string, file: string, hunks: Hunk[]): number[] {
	const ranges = hunks.flatMap(hunk => ["-L", `${hunk.start},${hunk.start + hunk.count - 1}`]);
	const out = git(repo, ["blame", "--porcelain", ...ranges, rev, "--", file]);
	const times = new Map<string, number>();
	let current: string | undefined;
	for (const line of out.split("\n")) {
		const header = BLAME_HEADER.exec(line);
		if (header) current = header[1];
		else if (current && line.startsWith("committer-time ")) times.set(current, Number(line.slice("committer-time ".length)));
	}
	return [...times.values()];
}

/** Whether the commit rewrites lines that another commit of the previous 7 days added (blame on the parent over the first 50 changed hunks). */
export function rewritesRecentLines(repo: string, commit: Commit): boolean {
	if (commit.parent === undefined) return false;
	const hunks = removedHunks(repo, { ...commit, parent: commit.parent });
	const byFile = new Map<string, Hunk[]>();
	for (const hunk of hunks) byFile.set(hunk.file, [...(byFile.get(hunk.file) ?? []), hunk]);
	const earliest = commit.time - FOLLOW_UP_DAYS * DAY_SECONDS;
	for (const [file, fileHunks] of byFile) {
		if (blameTimes(repo, commit.parent, file, fileHunks).some(time => time >= earliest && time <= commit.time)) return true;
	}
	return false;
}

function measure(repo: string, label: string, commits: Commit[]): WindowStats {
	const stats: WindowStats = { label, commits: commits.length, reverts: 0, fixSubjects: 0, followUpFixes: 0 };
	for (const commit of commits) {
		if (isRevert(commit)) stats.reverts++;
		if (!FIX_SUBJECT.test(commit.subject)) continue;
		stats.fixSubjects++;
		if (rewritesRecentLines(repo, commit)) stats.followUpFixes++;
	}
	return stats;
}

const epoch = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

export interface Windows {
	splitDay: string;
	sinceDays?: number;
	now?: number;
}

/** Commit counts, reverts and follow-up fixes of the repo before and after the split day, at most 2000 commits per window. */
export function measureRepo(directory: string, windows: Windows): { before: WindowStats; after: WindowStats } {
	const repo = git(directory, ["rev-parse", "--show-toplevel"]).trim();
	const split = epoch(windows.splitDay);
	const since = windows.sinceDays === undefined ? undefined : Math.floor((windows.now ?? Date.now()) / 1000) - windows.sinceDays * DAY_SECONDS;
	const bound = (commits: Commit[]): Commit[] => commits.filter(commit => since === undefined || commit.time >= since);
	const before = bound(listCommits(repo, [`--before=@${split}`], MAX_COMMITS_PER_WINDOW).filter(commit => commit.time < split));
	const after = bound(listCommits(repo, [`--since=@${split}`], MAX_COMMITS_PER_WINDOW).filter(commit => commit.time >= split));
	return { before: measure(repo, `before ${windows.splitDay}`, before), after: measure(repo, `from ${windows.splitDay}`, after) };
}

/** Opens with source `user` in the mistake log, before and after the split day (and within `sinceDays` when given). */
export function userCorrections(file: string, windows: Windows): { before: number; after: number; skipped: number } {
	const result = { before: 0, after: 0, skipped: 0 };
	if (!existsSync(file)) return result;
	const split = epoch(windows.splitDay) * 1000;
	const since = windows.sinceDays === undefined ? undefined : (windows.now ?? Date.now()) - windows.sinceDays * DAY_SECONDS * 1000;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			result.skipped++;
			continue;
		}
		const { at, event, source } = (entry ?? {}) as Record<string, unknown>;
		const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
		if (Number.isNaN(time)) {
			result.skipped++;
			continue;
		}
		if (event !== "open" || source !== "user" || (since !== undefined && time < since)) continue;
		if (time < split) result.before++;
		else result.after++;
	}
	return result;
}

const per100 = (part: number, whole: number): string => (whole === 0 ? "n/a" : (Math.round((10_000 * part) / whole) / 100).toFixed(2));

/** One table row per window: commits, reverts and follow-up fixes with their rates per 100 commits; `fixsubj` tells a window without fix-labelled subjects (followups 0 by convention) from one without fixes. */
export function renderRepo(repo: string, stats: WindowStats[]): string {
	const lines = [repo, `  ${"window".padEnd(18)}${"commits".padStart(8)}${"reverts".padStart(9)}${"per100".padStart(8)}${"fixsubj".padStart(9)}${"followups".padStart(11)}${"per100".padStart(8)}`];
	for (const window of stats) {
		const rate = (part: number) => per100(part, window.commits).padStart(8);
		lines.push(`  ${window.label.padEnd(18)}${String(window.commits).padStart(8)}${String(window.reverts).padStart(9)}${rate(window.reverts)}${String(window.fixSubjects).padStart(9)}${String(window.followUpFixes).padStart(11)}${rate(window.followUpFixes)}`);
	}
	return lines.join("\n");
}

export function parseArgs(argv: string[]): { repos: string[]; windows: Windows } | undefined {
	const repos: string[] = [];
	let splitDay = DEFAULT_SPLIT;
	let sinceDays: number | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--since-days") {
			sinceDays = Number(argv[++index]);
			if (!(Number.isFinite(sinceDays) && sinceDays > 0)) return undefined;
		} else if (arg === "--split") {
			splitDay = argv[++index] ?? "";
			if (!/^\d{4}-\d{2}-\d{2}$/.test(splitDay) || Number.isNaN(epoch(splitDay))) return undefined;
		} else if (arg.startsWith("--")) {
			return undefined;
		} else {
			repos.push(arg);
		}
	}
	return repos.length === 0 ? undefined : { repos, windows: { splitDay, ...(sinceDays === undefined ? {} : { sinceDays }) } };
}

if (import.meta.main) {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed) {
		console.error("usage: bun harness/outcomes.ts [--since-days N] [--split YYYY-MM-DD] <repo>...");
		process.exit(2);
	}
	for (const repo of parsed.repos) {
		const { before, after } = measureRepo(resolve(repo), parsed.windows);
		console.log(renderRepo(repo, [before, after]), "\n");
	}
	const file = join(dirname(gateLogFile()), "mistakes.jsonl");
	const corrections = userCorrections(file, parsed.windows);
	console.log(`user corrections (opens with source user, ${file})`);
	console.log(`  before ${parsed.windows.splitDay}: ${corrections.before}`);
	console.log(`  from ${parsed.windows.splitDay}:   ${corrections.after}${corrections.skipped ? `\n  ${corrections.skipped} unreadable lines skipped` : ""}`);
}
