// Recovery from a rewritten public history, against real temp repos (bare origin, the install, a pusher that force-pushes; no network).
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoHooks, commit, failFileTestCmd, git as sh, head, makeRepos, type Repos, setSelfUpdateCfg as setCfg } from "./selfupdate-fixture.ts";
import { apply, autoCheck, check } from "./selfupdate.ts";

setDefaultTimeout(30_000); // real git repos and test runs: seconds each, more under parallel load

const HOOKS = join(import.meta.dir, "..", ".githooks");
const key = (sha: string) => new Bun.CryptoHasher("sha256").update(sha).digest("hex").slice(0, 16);

let r: Repos;
let root: string, work: string, pusher: string, logDir: string;
const opts = () => ({ dir: work, remote: "origin", branch: "main", testCmd: failFileTestCmd, logDir, dataDir: root, alert: () => {} });
const branches = () => sh(work, "branch", "--list", "dotz-local/*").split("\n").map(b => b.trim()).filter(Boolean);
const isAncestor = (a: string, b: string) => Bun.spawnSync(["git", "merge-base", "--is-ancestor", a, b], { cwd: work }).exitCode === 0;

// What the owner's rewrite does: main and the release tag replaced by a history sharing no commit with the old one, and (unless `marker`
// is off, a plain divergence) the marker tag naming the old commits, all in one atomic force push.
function rewriteOrigin(marker = true): string {
	const oldCommits = sh(pusher, "rev-list", "--all").split("\n");
	sh(pusher, "checkout", "-q", "--orphan", "rewritten");
	sh(pusher, "commit", "-q", "-m", "rewritten");
	sh(pusher, "branch", "-M", "rewritten", "main");
	sh(pusher, "tag", "-f", "v261101.1", "HEAD");
	const refs = ["main", "refs/tags/v261101.1"];
	if (marker) {
		const file = join(root, "marker.txt");
		writeFileSync(file, `${oldCommits.map(key).join("\n")}\n`);
		sh(pusher, "tag", "history-rewrite-1", sh(pusher, "hash-object", "-w", file));
		refs.push("refs/tags/history-rewrite-1");
	}
	sh(pusher, "push", "-q", "--force", "--atomic", "origin", ...refs);
	return head(pusher);
}

beforeEach(() => {
	r = makeRepos();
	({ root, work, pusher, logDir } = r);
	setCfg(undefined);
});
afterEach(() => {
	setCfg(undefined);
	r.remove();
});

test("a clean install at the newest version moves to the rewritten history by itself and keeps nothing", async () => {
	const oldHead = head(work);
	const newHead = rewriteOrigin();
	const { h, api } = autoHooks();
	await autoCheck(opts(), api);
	expect(head(work)).toBe(newHead);
	expect(isAncestor(oldHead, "HEAD")).toBe(false);
	expect(branches()).toEqual([]);
	expect(h.alerts).toEqual([]);
	expect(h.restarts).toBe(1);
	expect((await check(opts())).rewrite).toBeUndefined(); // moved once: the next check has nothing to do
});

test("a local commit is backed up on dotz-local and carried onto the new history; uncommitted work comes back", async () => {
	commit(work, "mine.txt", "mine\n", "my local change");
	commit(work, "mine.txt", "mine\nmore\n", "builds on it, so order matters");
	const local = head(work);
	writeFileSync(join(work, "a.txt"), "edited\n");
	const newHead = rewriteOrigin();
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	const [branch] = branches();
	expect(j.note).toContain(branch!);
	expect(sh(work, "rev-parse", branch!)).toBe(local);
	expect(sh(work, "rev-parse", "HEAD~2")).toBe(newHead);
	expect(sh(work, "log", "-1", "--format=%s")).toBe("builds on it, so order matters");
	expect(readFileSync(join(work, "mine.txt"), "utf8")).toBe("mine\nmore\n");
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("edited\n");
});

test("the unattended check moves an install with local work too: nothing blocks it and nothing is lost", async () => {
	commit(work, "mine.txt", "mine\n", "my local change");
	const local = head(work);
	writeFileSync(join(work, "a.txt"), "edited\n");
	const newHead = rewriteOrigin();
	const { h, api } = autoHooks();
	await autoCheck(opts(), api);
	expect(sh(work, "rev-parse", "HEAD~1")).toBe(newHead);
	expect(sh(work, "rev-parse", branches()[0]!)).toBe(local);
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("edited\n");
	expect(h.alerts).toEqual([]);
	expect(h.restarts).toBe(1);
});

test("a local commit that cannot be carried over stays on its backup branch and the install still moves", async () => {
	commit(work, "a.txt", "local version\n", "clashes with upstream");
	const local = head(work);
	writeFileSync(join(pusher, "a.txt"), "upstream version\n");
	sh(pusher, "commit", "-q", "-am", "upstream edit");
	const newHead = rewriteOrigin();
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(newHead);
	expect(sh(work, "rev-parse", branches()[0]!)).toBe(local);
});

test("local commits that cannot be backed up stop the move, so nothing is lost", async () => {
	commit(work, "mine.txt", "mine\n", "my local change");
	const local = head(work);
	sh(work, "branch", "dotz-local"); // a branch of that name leaves no room for the ref dotz-local/<stamp>
	rewriteOrigin();
	const j = await apply(opts());
	expect(j.status).toBe("failed");
	expect(head(work)).toBe(local);
});

test("a rewrite that keeps an old prefix moves the install once: listed commits the new tip still holds are not old", async () => {
	const kept = head(work);
	commit(pusher, "b.txt", "personal\n", "removed by the rewrite");
	sh(pusher, "tag", "-f", "v261101.1", "HEAD");
	sh(pusher, "push", "-q", "--force", "origin", "main", "refs/tags/v261101.1");
	sh(work, "fetch", "-q", "origin", "main");
	sh(work, "reset", "-q", "--hard", "FETCH_HEAD");
	const oldKeys = sh(pusher, "rev-list", "--all").split("\n");
	sh(pusher, "reset", "-q", "--hard", kept);
	commit(pusher, "b.txt", "scrubbed\n", "scrubbed");
	sh(pusher, "tag", "-f", "v261101.1", "HEAD");
	const file = join(root, "marker.txt");
	writeFileSync(file, `${oldKeys.map(key).join("\n")}\n`);
	sh(pusher, "tag", "history-rewrite-1", sh(pusher, "hash-object", "-w", file));
	sh(pusher, "push", "-q", "--force", "--atomic", "origin", "main", "refs/tags/v261101.1", "refs/tags/history-rewrite-1");
	const { h, api } = autoHooks();
	await autoCheck(opts(), api);
	await autoCheck(opts(), api);
	expect(head(work)).toBe(head(pusher));
	expect(h.restarts).toBe(1);
	expect((await check(opts())).rewrite).toBeUndefined();
});

test("a second marker that rewrites only the last commits and re-points the same version tag moves a release install once, keeping nothing", async () => {
	rewriteOrigin();
	await autoCheck(opts(), autoHooks().api);
	const kept = head(pusher);
	r.push("b.txt", "same tree\n", "carries an address");
	const version = r.release("c.txt", "same tree\n", "release");
	const tag = `v${version}`;
	const oldTag = head(pusher);
	r.push("d.txt", "same tree\n", "after the release");
	const { h, api } = autoHooks();
	await autoCheck(opts(), api);
	expect(head(work)).toBe(oldTag);
	expect(h.restarts).toBe(1);

	const old = sh(pusher, "rev-list", "--reverse", `${kept}..main`).split("\n");
	const moved = new Map<string, string>();
	let parent = kept;
	for (const sha of old) {
		parent = sh(pusher, "-c", "user.email=noreply@t", "commit-tree", `${sha}^{tree}`, "-p", parent, "-m", sh(pusher, "log", "-1", "--format=%B", sha));
		moved.set(sha, parent);
	}
	const newTag = moved.get(oldTag)!;
	sh(pusher, "reset", "-q", "--hard", parent);
	sh(pusher, "tag", "-f", tag, newTag);
	const file = join(root, "marker2.txt");
	writeFileSync(file, `${old.map(key).join("\n")}\n`);
	sh(pusher, "tag", "history-rewrite-2", sh(pusher, "hash-object", "-w", file));
	sh(pusher, "push", "-q", "--force", "--atomic", "origin", "main", `refs/tags/${tag}`, "refs/tags/history-rewrite-2");

	const before = await check(opts());
	expect(before.rewrite).toBeDefined();
	expect(before.ahead).toEqual([]);
	expect(before.keep).toBeUndefined();
	await autoCheck(opts(), api);
	await autoCheck(opts(), api);
	expect(head(work)).toBe(newTag);
	expect(sh(work, "rev-parse", "HEAD^{tree}")).toBe(sh(pusher, "rev-parse", `${oldTag}^{tree}`));
	expect(isAncestor(oldTag, "HEAD")).toBe(false);
	expect(branches()).toEqual([]);
	expect(h.alerts).toEqual([]);
	expect(h.restarts).toBe(2);
	expect((await check(opts())).rewrite).toBeUndefined();
});

test("failing tests on the new history put the install back on the old one", async () => {
	sh(pusher, "rm", "-q", "--cached", "a.txt");
	writeFileSync(join(pusher, "FAIL"), "x\n");
	sh(pusher, "add", "FAIL");
	sh(pusher, "commit", "-q", "-m", "broken");
	const before = head(work);
	rewriteOrigin();
	const j = await apply(opts());
	expect(j.status).toBe("failed");
	expect(head(work)).toBe(before);
});

test("a plain divergence with no marker keeps today's behaviour", async () => {
	const oldHead = head(work);
	rewriteOrigin(false);
	const same = await check(opts());
	expect(same.summary).toBe("업데이트 없음 (261101.1)");
	expect(same.rewrite).toBeUndefined();
	expect((await apply(opts())).status).toBe("current");
	expect(head(work)).toBe(oldHead);
});

test("the git hooks refuse to push or rebase old history once the marker exists, on every ref", () => {
	const oldHead = head(work);
	const hooked = (...args: string[]) => Bun.spawnSync(["git", "-c", `core.hooksPath=${HOOKS}`, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
	rewriteOrigin();
	const branchPush = hooked("push", "origin", `${oldHead}:refs/heads/old-copy`);
	expect(branchPush.exitCode).not.toBe(0);
	expect(branchPush.stderr.toString()).toContain("history-rewrite");
	expect(hooked("push", "origin", `${oldHead}:refs/tags/old-copy`).exitCode).not.toBe(0);
	expect(sh(pusher, "ls-remote", "origin", "old-copy")).toBe("");
	sh(work, "fetch", "-q", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
	expect(hooked("rebase", "origin/main").exitCode).not.toBe(0);
	expect(head(work)).toBe(oldHead);
});
