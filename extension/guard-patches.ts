// Applied-patch detection, split out of guard.ts: which `git apply` commands name a patch, and whether a worker's patch is
// already in the tree (reverse check in the command's directories and worktrees, or the 30-day git-log fallback).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { debug } from "./guard-debug.ts";

// `git` with any number of `-C <dir>` options (quoted or bare), then `apply`: the one matcher for every place that
// recognises an applying orchestrator command.
export const GIT_APPLY = String.raw`\bgit(?:\s+-C\s+(?:"[^"]*"|'[^']*'|[^\s;&|)]+))*\s+apply\b`;
export const GIT_APPLY_RE = new RegExp(GIT_APPLY);
// Patch files an applying command names; --stat/--check/--reverse/--summary/--numstat runs apply nothing.
export const GIT_APPLY_NAMED = new RegExp(`${GIT_APPLY}(?![^|;&]*--(?:stat|check|reverse|summary|numstat))[^|;&]*?(\\S+\\.patch)`, "g");

function reverseChecks(cwd: string, patch: string): boolean {
	try {
		execFileSync("git", ["apply", "--reverse", "--check", patch], { cwd, stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

// Worktree paths of the repo containing `dir` (empty when `dir` is no repo). `cache` lives for one refresh.
function worktreesOf(dir: string, cache: Map<string, string[]>): string[] {
	const hit = cache.get(dir);
	if (hit) return hit;
	let found: string[] = [];
	try {
		const out = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3_000, encoding: "utf8" });
		found = out.split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9)).filter(path => existsSync(path));
	} catch {}
	cache.set(dir, found);
	for (const path of found) if (!cache.has(path)) cache.set(path, found);
	return found;
}

// Directories a shell command ran `git apply` in: the tool cwd, then each `cd <dir>` / `git -C <dir>` it names, resolved in order.
export function applyDirsOf(command: string, toolCwd: string): string[] {
	const dirs = [toolCwd];
	let at = toolCwd;
	const unquote = (raw: string) => raw.replace(/^['"]|['"]$/g, "");
	const target = (raw: string) => {
		const dir = unquote(raw);
		return resolve(at, dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir);
	};
	for (const m of command.matchAll(/(?:^|[;&|(]\s*|&&\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)|\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
		if (m[1]) at = target(m[1]);
		else dirs.push(target(m[2]));
		if (m[1]) dirs.push(at);
	}
	return dirs;
}

// A patch counts as applied when it reverses cleanly in any of `dirs` or any worktree of their repos
// (a lane worktree or another cwd is where it may actually have gone in).
export function patchIsApplied(dirs: string[], patch: string, cache: Map<string, string[]> = new Map()): boolean {
	const tried = new Set<string>();
	const attempt = (dir: string) => {
		const key = resolve(dir);
		if (tried.has(key) || !existsSync(key)) return false;
		tried.add(key);
		return reverseChecks(key, patch);
	};
	for (const dir of dirs) if (attempt(dir)) return true;
	for (const dir of dirs) for (const tree of worktreesOf(dir, cache)) if (attempt(tree)) return true;
	return false;
}

// History fallback (session start only) for patches that were merged with --3way or edited by hand (so the reverse check
// fails) or whose lines were touched by later commits: the patch has landed when at least 80% of its distinctive changed
// lines (sign + trimmed text, at least 8 chars, not punctuation-only) appear as same-sign changed lines in the last 30 days
// of `git log --branches -p` over the files it touches, in any repo containing one of `dirs`. Files no commit ever touched
// (throwaway smoke scripts a lane leaves out) are ignored; fewer than 3 distinctive lines left is too weak to decide.
function changedLines(diff: string): Map<string, Set<string>> {
	const byFile = new Map<string, Set<string>>();
	let lines: Set<string> | undefined;
	let inHunk = false;
	for (const row of diff.split("\n")) {
		const header = row.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (header) {
			inHunk = false;
			lines = byFile.get(header[2]) ?? new Set();
			byFile.set(header[2], lines);
		} else if (row.startsWith("@@")) {
			inHunk = true;
		} else if (lines && inHunk && (row[0] === "+" || row[0] === "-")) {
			const text = row.slice(1).trim();
			if (text.length >= 8 && /[A-Za-z0-9]/.test(text)) lines.add(row[0] + text);
		}
	}
	return byFile;
}

export function patchLanded(dirs: string[], patch: string): boolean {
	let wanted: Map<string, Set<string>>;
	try {
		wanted = changedLines(readFileSync(patch, "utf8"));
	} catch {
		return false;
	}
	if (!wanted.size) return false;
	const seen = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		let top: string;
		try {
			top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
		} catch {
			continue;
		}
		if (!top || seen.has(top)) continue;
		seen.add(top);
		try {
			const log = execFileSync("git", ["-C", top, "log", "--branches", "--since=30.days", "-p", "--format=", "--", ...wanted.keys()], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, maxBuffer: 512 * 1024 * 1024 });
			const history = changedLines(log);
			const changed = new Set<string>();
			for (const lines of history.values()) for (const line of lines) changed.add(line);
			let total = 0;
			let hits = 0;
			for (const [file, lines] of wanted) {
				if (!history.has(file)) continue;
				total += lines.size;
				for (const line of lines) if (changed.has(line)) hits++;
			}
			if (total >= 3 && hits >= Math.ceil(total * 0.8)) return true;
		} catch (error) {
			debug({ phase: "patch-landed-error", dir: top, message: String(error) });
		}
	}
	return false;
}
