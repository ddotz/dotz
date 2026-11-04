import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGitHooks } from "./git-hooks.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout.trim();
const repo = (hook: boolean) => {
	const dir = mkdtempSync(join(tmpdir(), "git-hooks-"));
	dirs.push(dir);
	git(dir, "init", "-q");
	if (hook) { mkdirSync(join(dir, ".githooks")); writeFileSync(join(dir, ".githooks", "pre-push"), ""); }
	return dir;
};

test("a checkout with the hooks dir is pointed at it, and its worktrees see the same setting", () => {
	const dir = repo(true);
	installGitHooks(dir);
	expect(git(dir, "config", "--get", "core.hooksPath")).toBe(".githooks");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
	const wt = `${dir}-wt`;
	dirs.push(wt);
	git(dir, "worktree", "add", "-q", "--detach", wt);
	expect(git(wt, "config", "--get", "core.hooksPath")).toBe(".githooks");
});

test("an owner's own hooksPath stays", () => {
	const dir = repo(true);
	git(dir, "config", "core.hooksPath", "mine");
	installGitHooks(dir);
	expect(git(dir, "config", "--get", "core.hooksPath")).toBe("mine");
});

test("no hooks dir (an older checkout, a test fixture) sets nothing", () => {
	const dir = repo(false);
	installGitHooks(dir);
	expect(git(dir, "config", "--get", "core.hooksPath")).toBe("");
});
