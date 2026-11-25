import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readPassed } from "./log.ts";

const execFileAsync = promisify(execFile);
const TREE_LIMIT_MS = 10_000;

async function git(repo: string, args: string[], signal: AbortSignal): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal });
	return stdout.trim();
}

/**
 * The git tree id of the whole working tree of `repo`: every file git does not ignore, untracked ones included, as `git add -A` into an
 * empty scratch index and `git write-tree` see it. Undefined when git cannot say within 10 s. Git's own hook environment is left out of it.
 * Synchronous, so a check started right after it cannot change the files it reads first.
 */
export function workingTreeId(repo: string): string | undefined {
	const dir = mkdtempSync(join(tmpdir(), "gate-tree-"));
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
		delete env.GIT_DIR;
		delete env.GIT_WORK_TREE;
		const options = { encoding: "utf8" as const, maxBuffer: 64 * 1024 * 1024, timeout: TREE_LIMIT_MS, env };
		execFileSync("git", ["-C", repo, "add", "-A"], options);
		return execFileSync("git", ["-C", repo, "write-tree"], options).trim();
	} catch {
		return undefined;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** `before`, the working-tree id taken just before a check started, when the tree is still exactly that one now; otherwise undefined. */
export function unchangedTree(repo: string, before: string | undefined): string | undefined {
	if (before === undefined) return undefined;
	return before === workingTreeId(repo) ? before : undefined;
}

/**
 * Which of `expected` (check name to the command the caller would run) the gate recorded a pass for on exactly the tree about to be
 * committed: the recorded pass has that command and the git tree id of the whole working tree it ran on equals the tree id of the
 * index. Any difference anywhere in the tree, the gate file included, runs everything; the staged gate file is never read. Git's own
 * environment (GIT_INDEX_FILE, as a hook sees it) is honoured: this reads the index the commit is made from.
 */
export async function reusablePasses(repo: string, expected: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string[]> {
	const staged = await git(repo, ["write-tree"], signal);
	const passed = readPassed(repo);
	return Object.entries(expected)
		.filter(([name, command]) => passed[name]?.command === command && passed[name].tree === staged)
		.map(([name]) => name);
}
