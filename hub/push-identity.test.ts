import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIX_COMMAND, isPublicRemote } from "./commit-identity.ts";
import { run } from "./history-rewrite.ts";
import { recordReview, type Run } from "./mergegate.ts";
import { refusal } from "./push-identity.ts";

const HOOKS = join(import.meta.dir, "..", ".githooks");
const PERSONAL = "dev@gmail.com";
const NOREPLY = "1+dev@users.noreply.github.com";
const SLOW = 60_000; // every push boots bun several times inside the hook

let root: string, publicRemote: string, fork: string, work: string;
const raw = (cwd: string, args: string[], env: Record<string, string> = {}) => {
	const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env } });
	return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const git = (cwd: string, ...args: string[]) => {
	const r = raw(cwd, args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
	return r.out;
};
const push = (cwd: string, ...args: string[]) => raw(cwd, ["push", "-q", ...args]);
const commit = (cwd: string, name: string, env: Record<string, string> = {}) => {
	writeFileSync(join(cwd, name), name);
	git(cwd, "add", name);
	const r = raw(cwd, ["commit", "-q", "-m", name], env);
	if (r.code !== 0) throw new Error(r.err);
	return git(cwd, "rev-parse", "HEAD");
};
const remoteMain = (bare: string) => raw(bare, ["rev-parse", "--verify", "-q", "refs/heads/main"]).out;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "push-identity-"));
	publicRemote = join(root, "ddotz", "dotz.git");
	fork = join(root, "alice", "dotz.git");
	for (const bare of [publicRemote, fork]) {
		mkdirSync(bare, { recursive: true });
		git(bare, "init", "-q", "--bare", "-b", "main");
	}
	work = join(root, "work");
	mkdirSync(join(work, "hub"), { recursive: true });
	git(work, "init", "-q", "-b", "main");
	git(work, "config", "user.name", "dev");
	git(work, "config", "user.email", PERSONAL);
	git(work, "config", "core.hooksPath", HOOKS);
	git(work, "remote", "add", "origin", publicRemote);
	git(work, "remote", "add", "fork", fork);
	// the hook also runs the repo's limits on the pushed tree; this stand-in passes them
	writeFileSync(join(work, "hub", "engineering-rules.test.ts"), `import { test } from "bun:test";\ntest("limits", () => {});\n`);
	git(work, "add", ".");
	git(work, "commit", "-q", "-m", "base");
	git(work, "-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "main"); // the history already public, personal address and all
	git(work, "config", "user.email", NOREPLY);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a PR commit pushed by hand to main is refused until that PR has a universal review; other branches and plain commits pass", async () => {
	const main = "refs/heads/main";
	const dataDir = join(root, "data");
	commit(work, "plain");
	expect(await refusal(run, work, publicRemote, "HEAD", main, dataDir)).toBeUndefined();
	git(work, "commit", "-q", "--allow-empty", "-m", "다른 설치의 수정 (#7)");
	const refused = await refusal(run, work, publicRemote, "HEAD", main, dataDir);
	expect(refused).toContain("#7");
	expect(refused).toContain("dotz_merge");
	expect(await refusal(run, work, publicRemote, "HEAD", "refs/heads/topic", dataDir)).toBeUndefined();
	expect(await refusal(run, work, fork, "HEAD", main, dataDir)).toBeUndefined();
	const gh: Run = async () => ({ code: 0, stdout: `${"a".repeat(40)}\thttps://github.com/ddotz/dotz/pull/7\n`, stderr: "" });
	await recordReview({ cwd: work, pr: "7", verdict: "CLEAR", scope: "personal" }, { dir: dataDir, gh });
	expect(await refusal(run, work, publicRemote, "HEAD", main, dataDir)).toContain("#7");
	await recordReview({ cwd: work, pr: "7", verdict: "CLEAR", scope: "universal" }, { dir: dataDir, gh });
	expect(await refusal(run, work, publicRemote, "HEAD", main, dataDir)).toBeUndefined();
});

test("the hook passes the pushed ref, so a hand-landed PR commit never reaches main", () => {
	const before = remoteMain(publicRemote);
	git(work, "commit", "-q", "--allow-empty", "-m", "다른 설치의 수정 (#9)");
	const r = raw(work, ["push", "-q", "origin", "main"], { DOTZ_DIR: join(root, "data") });
	expect(r.code).not.toBe(0);
	expect(r.err).toContain("#9");
	expect(remoteMain(publicRemote)).toBe(before);
}, SLOW);

test("a push from a personal git config is refused on one line that says how to fix it and repeats no address", () => {
	git(work, "config", "user.email", PERSONAL);
	const before = remoteMain(publicRemote);
	commit(work, "leak");
	const r = push(work, "origin", "main");
	expect(r.code).not.toBe(0);
	const line = r.err.split("\n").find(l => l.startsWith("push-identity:")) ?? "";
	expect(line).toContain(FIX_COMMAND);
	expect(r.err).not.toContain(PERSONAL);
	expect(remoteMain(publicRemote)).toBe(before);
}, SLOW);

test("a personal author or a personal committer alone is refused, on a branch and on a tag", () => {
	commit(work, "author", { GIT_AUTHOR_EMAIL: PERSONAL });
	expect(push(work, "origin", "main").code).not.toBe(0);
	git(work, "reset", "-q", "--hard", "HEAD~1");
	commit(work, "committer", { GIT_COMMITTER_EMAIL: PERSONAL });
	expect(push(work, "origin", "HEAD:refs/heads/topic").code).not.toBe(0);
	git(work, "tag", "t1");
	expect(push(work, "origin", "refs/tags/t1").code).not.toBe(0);
	expect(raw(publicRemote, ["for-each-ref"]).out.split("\n")).toHaveLength(1);
}, SLOW);

test("commits already on the remote never block: noreply work on top goes through, also from a checkout that has not fetched and by bare URL", () => {
	const top = commit(work, "clean");
	expect(push(work, "origin", "main").code).toBe(0);
	expect(remoteMain(publicRemote)).toBe(top);
	expect(push(work, publicRemote, "HEAD:refs/heads/by-url").code).toBe(0);
	git(work, "update-ref", "-d", "refs/remotes/origin/main");
	expect(push(work, "origin", "HEAD:refs/heads/untracked").code).toBe(0);
	git(work, "fetch", "-q", "origin");
	const other = join(root, "other");
	git(root, "clone", "-q", publicRemote, other);
	git(other, "-c", "user.name=t", "-c", `user.email=${NOREPLY}`, "commit", "-q", "--allow-empty", "-m", "ahead");
	git(other, "-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "main");
	expect(push(work, "origin", "HEAD:refs/heads/behind").code).toBe(0); // this checkout does not know the remote's tip yet
	expect(push(work, publicRemote, "HEAD:refs/heads/behind-by-url").code).toBe(0);
}, SLOW);

test("a commit only on a remote's pull request ref still counts as new", () => {
	const contributed = commit(work, "contributed", { GIT_AUTHOR_EMAIL: PERSONAL });
	git(work, "-c", "core.hooksPath=/dev/null", "push", "-q", "origin", `${contributed}:refs/pull/1/head`);
	expect(push(work, "origin", "main").code).not.toBe(0);
}, SLOW);

test("a tracking ref the remote's branches do not back counts for nothing", () => {
	const hidden = commit(work, "hidden", { GIT_COMMITTER_EMAIL: PERSONAL });
	git(work, "update-ref", "refs/remotes/origin/pr/1", hidden);
	expect(push(work, "origin", "main").code).not.toBe(0);
}, SLOW);

test("git's own output never reaches a refusal, and stderr lines are not commits", async () => {
	const sha = "a".repeat(40);
	const empty = { code: 0, out: "" };
	const failed = await refusal(async cmd => cmd[1] === "ls-remote" ? empty : { code: 128, out: `${sha}\tname\t${PERSONAL}\tname\t${PERSONAL}\tsubject\nfatal: bad object` }, work, publicRemote, "HEAD");
	expect(failed).toContain("exit 128");
	expect(failed).not.toContain(PERSONAL);
	const noisy = await refusal(async cmd => cmd[1] === "ls-remote" ? empty : { code: 0, out: `No signature\n${sha}\tdev\t${NOREPLY}\tdev\t${NOREPLY}\tsubject` }, work, publicRemote, "HEAD");
	expect(noisy).toBeUndefined();
});

test("another remote is out of scope", () => {
	git(work, "config", "user.email", PERSONAL);
	const leak = commit(work, "fork-work");
	expect(push(work, "fork", "main").code).toBe(0);
	expect(remoteMain(fork)).toBe(leak);
}, SLOW);

test("a worktree inherits the clone's noreply identity, so its commits pass", () => {
	const wt = join(root, "lane");
	git(work, "worktree", "add", "-q", "-b", "lane/x", wt);
	commit(wt, "lane-work");
	expect(git(wt, "log", "-1", "--format=%ae %ce")).toBe(`${NOREPLY} ${NOREPLY}`);
	expect(push(wt, "origin", "lane/x").code).toBe(0);
}, SLOW);

test("only the public repo counts as public, in every URL form", () => {
	for (const url of ["https://github.com/ddotz/dotz", "https://github.com/ddotz/dotz.git", "https://token@github.com/DDOTZ/dotz.git/", "git@github.com:ddotz/dotz.git", "ssh://git@github.com/ddotz/dotz.git"]) expect(isPublicRemote(url)).toBe(true);
	for (const url of ["https://github.com/alice/dotz.git", "git@github.com:alice/dotz.git", "https://github.com/ddotz/dotz-site.git", "https://github.com/xddotz/dotz.git"]) expect(isPublicRemote(url)).toBe(false);
});
