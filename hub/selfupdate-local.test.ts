// Self-update with local work on a git install, against real temp repos (bare origin, the install, a pusher; no network).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepsLocal } from "./selfupdate-local.ts";
import { autoHooks, commit, failFileTestCmd, git as sh, head, makeRepos, type Repos, setSelfUpdateCfg as setCfg } from "./selfupdate-fixture.ts";
import { apply, autoCheck, check, onLocalSaved } from "./selfupdate.ts";

let r: Repos;
let root: string, work: string, pusher: string, logDir: string;
const push = (file: string, text: string, msg: string) => r.push(file, text, msg);
const branches = () => sh(work, "branch", "--list", "dotz-local/*").split("\n").filter(Boolean);
const logFiles = () => (existsSync(logDir) ? readdirSync(logDir) : []);
const opts = () => ({ dir: work, remote: "origin", branch: "main", testCmd: failFileTestCmd, logDir, dataDir: root });
// Runs the daily auto-check and returns what the orchestrator would have been told about saved local work.
const autoCheckSaved = async () => {
	const saved: { file: string; text: string; turn: string }[] = [];
	onLocalSaved(s => void saved.push(s));
	try {
		const { h, api } = autoHooks();
		await autoCheck(opts(), api);
		return { h, saved };
	} finally {
		onLocalSaved(() => undefined);
	}
};

beforeEach(() => {
	r = makeRepos();
	({ root, work, pusher, logDir } = r);
	setCfg(undefined);
});
afterEach(() => {
	setCfg(undefined);
	r.remove();
});

test("local commits whose patch or content upstream already has are dropped, not saved", async () => {
	commit(work, "same.txt", "x\n", "same patch locally");
	commit(work, "inside.txt", "y\n", "inside a bigger upstream commit");
	push("same.txt", "x\n", "same patch upstream");
	writeFileSync(join(pusher, "inside.txt"), "y\n");
	writeFileSync(join(pusher, "other.txt"), "z\n");
	sh(pusher, "add", ".");
	sh(pusher, "commit", "-q", "-m", "bigger upstream commit");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	const c = await check(opts());
	expect(c.ahead).toEqual([]);
	expect(c.dropped.map(d => d.subject).sort()).toEqual(["inside a bigger upstream commit", "same patch locally"]);
	expect(c.keep).toBeUndefined();
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(head(pusher));
	expect(branches()).toEqual([]);
});

test("local commits that rebase cleanly are applied on the new version after its checks, in a worktree that is gone afterwards", async () => {
	commit(work, "mine.txt", "mine\n", "my own change");
	push("a.txt", "2\n", "second");
	const upstream = head(pusher);
	const c = await check(opts());
	expect(c.keep).toBeUndefined();
	expect(c.ahead.map(a => a.subject)).toEqual(["my own change"]);
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(sh(work, "rev-parse", "HEAD~1")).toBe(upstream);
	expect(sh(work, "log", "-1", "--format=%s")).toBe("my own change");
	expect(readFileSync(join(work, "mine.txt"), "utf8")).toBe("mine\n");
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("2\n");
	expect(sh(work, "status", "--porcelain")).toBe("");
	expect(sh(work, "worktree", "list").split("\n")).toHaveLength(1);
	expect(branches()).toEqual([]);
});

// Owner 2026-10-29: a local edit never stops a shipped update; what cannot ride along is saved and the update goes on.
test("a rebase whose checks fail saves the commits on a branch and still moves to the new version", async () => {
	commit(work, "FAIL", "boom\n", "makes tests fail");
	const mine = head(work);
	push("a.txt", "2\n", "second");
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(head(pusher));
	expect(branches()).toHaveLength(1);
	expect(sh(work, "rev-parse", branches()[0]!)).toBe(mine);
});

test("a conflict is saved as a branch and a patch first, then the update moves on by itself", async () => {
	commit(work, "a.txt", "local\n", "my conflicting change");
	const mine = head(work);
	push("a.txt", "2\n", "second");
	const upstream = head(pusher);
	const c = await check(opts());
	expect(c.keep?.line).toContain("my conflicting change");
	const br = c.keep?.saved?.branch ?? "";
	expect(br).toMatch(/^dotz-local\/\d{8}-\d{4}/);
	expect(sh(work, "rev-parse", br)).toBe(mine);
	expect(readFileSync(c.keep?.saved?.patch ?? "", "utf8")).toContain("my conflicting change");
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(upstream);
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("2\n");
	expect(sh(work, "rev-parse", br)).toBe(mine);
	expect(j.note).toContain(br);
	expect(logFiles().filter(f => f.endsWith(".patch"))).toHaveLength(1);
});

test("uncommitted changes are saved as a patch and a plain copy, the update moves on, and they come back on top as a local patch", async () => {
	push("b.txt", "1\n", "adds b");
	writeFileSync(join(work, "a.txt"), "my edit\n");
	writeFileSync(join(work, "notes.txt"), "untracked\n");
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(head(pusher));
	expect(readFileSync(join(work, "b.txt"), "utf8")).toBe("1\n");
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("my edit\n");
	expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("untracked\n");
	expect(j.note).toContain("다시 얹었어요");
	const dirtyDirs = logFiles().filter(f => f.endsWith("-dirty"));
	expect(dirtyDirs).toHaveLength(1);
	expect(readFileSync(join(logDir, dirtyDirs[0], "files", "notes.txt"), "utf8")).toBe("untracked\n");
	expect(readFileSync(join(logDir, dirtyDirs[0], "files", "a.txt"), "utf8")).toBe("my edit\n");
	expect(readFileSync(join(logDir, `${dirtyDirs[0]}.patch`), "utf8")).toContain("+my edit");
	await check(opts());
	expect(logFiles().filter(f => f.endsWith("-dirty"))).toHaveLength(1);
});

test("an uncommitted change the new version touches too stays in the backup, and the new version is clean", async () => {
	writeFileSync(join(work, "a.txt"), "my edit\n");
	push("a.txt", "2\n", "second");
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(head(pusher));
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("2\n");
	expect(j.note).toContain("보관만 했어요");
	expect(readFileSync(join(logDir, `${logFiles().find(f => f.endsWith("-dirty"))}.patch`), "utf8")).toContain("+my edit");
});

test("an uncommitted change that breaks the tests on the new version is taken off again and kept in the backup", async () => {
	writeFileSync(join(work, "FAIL"), "boom\n");
	sh(work, "add", "-N", "FAIL");
	push("b.txt", "1\n", "adds b");
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(head(pusher));
	expect(existsSync(join(work, "FAIL"))).toBe(false);
	expect(j.note).toContain("빼고 보관만 했어요");
});

test("auto-apply on an install that is not a developer checkout saves the conflicting work, updates and says how to get it back", async () => {
	setCfg({ auto_apply: true, keep_local: false });
	commit(work, "a.txt", "local\n", "my conflicting change");
	push("a.txt", "2\n", "second");
	const { h } = await autoCheckSaved();
	expect(head(work)).toBe(head(pusher));
	expect(branches()).toHaveLength(1);
	expect(h.alerts).toEqual([]);
	expect(h.restarts).toBe(1);
	expect(h.worklog).toHaveLength(1);
	expect(h.worklog[0]).toContain("dotz-local/");
	expect(h.worklog[0]).toContain("git cherry-pick");
});

test("auto-apply on a developer checkout updates too: the conflicting commit is saved on a branch and the untracked work stays", async () => {
	setCfg({ auto_apply: true });
	commit(work, "a.txt", "local\n", "my conflicting change");
	const mine = head(work);
	push("a.txt", "2\n", "second");
	writeFileSync(join(work, "wip.txt"), "wip\n");
	const { h } = await autoCheckSaved();
	expect(head(work)).toBe(head(pusher));
	expect(sh(work, "rev-parse", branches()[0]!)).toBe(mine);
	expect(existsSync(join(work, "wip.txt"))).toBe(true);
	expect(h.restarts).toBe(1);
	expect(h.alerts).toEqual([]);
});

test("saved local commits get a summary in the data dir and queue one orchestrator turn", async () => {
	setCfg({ auto_apply: true, keep_local: false });
	commit(work, "a.txt", "local\n", "my conflicting change");
	commit(work, "mine.txt", "x\n", "my own file");
	push("a.txt", "2\n", "second");
	const { saved } = await autoCheckSaved();
	expect(saved).toHaveLength(1);
	const file = saved[0].file;
	expect(file.startsWith(join(root, "self-update"))).toBe(true);
	const text = readFileSync(file, "utf8");
	for (const part of ["my conflicting change", "a.txt", "my own file", "mine.txt", "dotz-local/"]) expect(text).toContain(part);
	expect(saved[0].turn).toContain(file);
});

test("which checkouts keep their local work: explicit flag, the install.sh marker, the default install folder, else yes", () => {
	expect(keepsLocal(work, undefined, {})).toBe(true);
	expect(keepsLocal(work, false, {})).toBe(false);
	mkdirSync(join(work, ".git"), { recursive: true });
	writeFileSync(join(work, ".git", "dotz-install"), "install.sh --git\n");
	expect(keepsLocal(work, undefined, {})).toBe(false);
	expect(keepsLocal(work, true, {})).toBe(true);
	rmSync(join(work, ".git", "dotz-install"));
	expect(keepsLocal(work, undefined, { DOTZ_HOME: work })).toBe(false);
});
