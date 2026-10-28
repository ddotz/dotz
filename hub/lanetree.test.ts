import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropWorktree } from "./lanetree.ts";

const sh = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};
// A repo on main with a lane worktree on lane/<name> whose branch tip is already in main (its work was merged).
function setup(name: string) {
	const repo = mkdtempSync(join(tmpdir(), "dotz-lanetree-"));
	sh(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "1\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "one");
	const path = join(repo, "..", `${name}-wt-${Date.now()}`);
	sh(repo, "worktree", "add", "-q", "-b", `lane/${name}`, path, "HEAD");
	const lane = { name, cwd: path, worktree: { path, repo, branch: `lane/${name}`, base: "main" } } as never as Parameters<typeof dropWorktree>[0];
	return { repo, path, lane };
}

test("a merged lane with nothing of its own is removed with its branch", () => {
	const { repo, path, lane } = setup("tree-merged");
	expect(dropWorktree(lane)).toContain("worktree removed");
	expect(existsSync(path)).toBe(false);
	expect(() => sh(repo, "rev-parse", "--verify", "--quiet", "refs/heads/lane/tree-merged")).toThrow();
});

test("commits on a detached HEAD (a rebase that moved off the branch) keep the worktree, though the branch itself is merged", () => {
	const { path, lane } = setup("tree-detached");
	sh(path, "checkout", "-q", "--detach");
	writeFileSync(join(path, "b.txt"), "2\n");
	sh(path, "add", "-A");
	sh(path, "commit", "-qm", "rebased work");
	expect(dropWorktree(lane)).toContain("worktree kept");
	expect(existsSync(path)).toBe(true);
});

test("a rebase stopped half way keeps the worktree", () => {
	const { repo, path, lane } = setup("tree-rebase");
	writeFileSync(join(path, "a.txt"), "lane\n");
	sh(path, "commit", "-qam", "lane change");
	writeFileSync(join(repo, "a.txt"), "main\n");
	sh(repo, "commit", "-qam", "main change");
	Bun.spawnSync(["git", "rebase", "main"], { cwd: path, env: { ...process.env, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
	sh(path, "checkout", "--theirs", "a.txt");
	sh(path, "add", "a.txt");
	expect(dropWorktree(lane)).toContain("worktree kept");
	expect(existsSync(path)).toBe(true);
});
