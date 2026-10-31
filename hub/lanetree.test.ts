import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropWorktree, laneWorktree } from "./lanetree.ts";

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
	const path = join(mkdtempSync(join(tmpdir(), "dotz-lanetree-wt-")), name);
	sh(repo, "worktree", "add", "-q", "-b", `lane/${name}`, path, "HEAD");
	const lane = { name, cwd: path, worktree: { path, repo, branch: `lane/${name}`, base: "main" } } as never as Parameters<typeof dropWorktree>[0];
	return { repo, path, lane };
}

test("a lane in a tracked subfolder gets a worktree and the same subfolder inside it", () => {
	const { repo } = setup("tree-sub-base");
	mkdirSync(join(repo, "src", "deep"), { recursive: true });
	writeFileSync(join(repo, "src", "deep", "x.ts"), "1\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "src");
	const place = laneWorktree("tree-sub", join(repo, "src", "deep"));
	expect(place.worktree).toBeDefined();
	expect(place.cwd).toBe(join(place.worktree!.path, "src", "deep"));
	expect(existsSync(place.cwd)).toBe(true);
});

test("a lane in an ignored folder (a `*` .gitignore, as ~/.dotz) runs in place without a worktree", () => {
	const { repo } = setup("tree-ign-base");
	writeFileSync(join(repo, ".gitignore"), "*\n");
	sh(repo, "add", "-f", ".gitignore");
	sh(repo, "commit", "-qm", "ignore all");
	const cwd = join(repo, "projects", "kdb");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "notes.md"), "x\n");
	expect(laneWorktree("tree-ign", cwd)).toEqual({ cwd });
	expect(sh(repo, "worktree", "list")).not.toContain("tree-ign/worktree");
});

test("a nested repo inside an ignored folder gets its worktree from that repo", () => {
	const { repo } = setup("tree-nest-base");
	writeFileSync(join(repo, ".gitignore"), "*\n");
	sh(repo, "add", "-f", ".gitignore");
	sh(repo, "commit", "-qm", "ignore all");
	const inner = join(repo, "projects", "inner");
	mkdirSync(inner, { recursive: true });
	sh(inner, "init", "-q", "-b", "main");
	writeFileSync(join(inner, "b.txt"), "1\n");
	sh(inner, "add", "-A");
	sh(inner, "commit", "-qm", "inner");
	const place = laneWorktree("tree-nest", inner);
	expect(place.worktree?.repo).toBe(sh(inner, "rev-parse", "--show-toplevel"));
	expect(place.cwd).toBe(place.worktree!.path);
	expect(existsSync(join(place.cwd, "b.txt"))).toBe(true);
});

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
