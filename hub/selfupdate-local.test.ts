// Self-update with local work on a git install, against real temp repos (bare origin, the install, a pusher; no network).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, DATA_DIR } from "./config.ts";
import { keepsLocal } from "./selfupdate-local.ts";
import { type AutoHooks, apply, autoCheck, check } from "./selfupdate.ts";

let root: string, origin: string, work: string, pusher: string, logDir: string;
const sh = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.toString().trim();
};
const commit = (dir: string, file: string, text: string, msg: string) => {
	writeFileSync(join(dir, file), text);
	sh(dir, "add", file);
	sh(dir, "commit", "-q", "-m", msg);
};
const push = (file: string, text: string, msg: string) => {
	commit(pusher, file, text, msg);
	sh(pusher, "push", "-q", "origin", "HEAD:main");
};
const head = (dir: string) => sh(dir, "rev-parse", "HEAD");
const branches = () => sh(work, "branch", "--list", "dotz-local/*").split("\n").filter(Boolean);
const logFiles = () => (existsSync(logDir) ? readdirSync(logDir) : []);
const testCmd = ["sh", "-c", "test ! -f FAIL"];
const opts = () => ({ dir: work, remote: "origin", branch: "main", testCmd, logDir });
const setCfg = (v: Record<string, unknown> | undefined) => {
	(cfg as Record<string, unknown>).self_update = v;
	rmSync(join(DATA_DIR, "self-update.json"), { force: true });
};
const hooks = () => {
	const h = { worklog: [] as string[], alerts: [] as string[], restarts: 0 };
	const api: AutoHooks = { worklog: t => void h.worklog.push(t), alert: t => void h.alerts.push(t), restartIdle: () => (h.restarts++, "queued") };
	return { h, api };
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-selfupdate-local-"));
	origin = join(root, "origin.git");
	work = join(root, "work");
	pusher = join(root, "pusher");
	logDir = join(root, "logs");
	sh(root, "init", "-q", "--bare", origin);
	sh(root, "clone", "-q", origin, pusher);
	commit(pusher, "a.txt", "1\n", "first");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	sh(root, "clone", "-q", origin, work);
	setCfg(undefined);
});
afterEach(() => {
	setCfg(undefined);
	rmSync(root, { recursive: true, force: true });
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

test("a rebase whose checks fail saves the commits and does not move the checkout", async () => {
	commit(work, "FAIL", "boom\n", "makes tests fail");
	const mine = head(work);
	push("a.txt", "2\n", "second");
	const j = await apply(opts());
	expect(j.status).toBe("refused");
	expect(j.keep?.line).toContain("\ud14c\uc2a4\ud2b8");
	expect(head(work)).toBe(mine);
	expect(branches()).toHaveLength(1);
});

test("a conflict is saved as a branch and a patch first, the checkout stays until the button, then the button moves and applies", async () => {
	commit(work, "a.txt", "local\n", "my conflicting change");
	const mine = head(work);
	push("a.txt", "2\n", "second");
	const upstream = head(pusher);
	const c = await check(opts());
	expect(c.keep?.line).toContain("\ub0b4 \uc218\uc815\uc744 \ubcf4\uad00\ud558\uace0 \uc0c8 \ubc84\uc804 \ubc1b\uae30");
	expect(c.keep?.line).toContain("my conflicting change");
	const br = c.keep?.saved?.branch ?? "";
	expect(br).toMatch(/^dotz-local\/\d{8}-\d{4}/);
	expect(sh(work, "rev-parse", br)).toBe(mine);
	expect(readFileSync(c.keep?.saved?.patch ?? "", "utf8")).toContain("my conflicting change");
	const refused = await apply(opts());
	expect(refused.status).toBe("refused");
	expect(head(work)).toBe(mine);
	expect(branches()).toHaveLength(1);
	const j = await apply(opts(), { keep: true });
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(upstream);
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("2\n");
	expect(sh(work, "rev-parse", br)).toBe(mine);
	expect(j.note).toContain(br);
	expect(logFiles().filter(f => f.endsWith(".patch"))).toHaveLength(1);
});

test("uncommitted changes are saved as a patch and a plain copy, then only the button moves on", async () => {
	push("b.txt", "1\n", "adds b");
	writeFileSync(join(work, "a.txt"), "my edit\n");
	writeFileSync(join(work, "notes.txt"), "untracked\n");
	const before = head(work);
	const refused = await apply(opts());
	expect(refused.status).toBe("refused");
	expect(head(work)).toBe(before);
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("my edit\n");
	const dirtyDirs = logFiles().filter(f => f.endsWith("-dirty"));
	expect(dirtyDirs).toHaveLength(1);
	expect(readFileSync(join(logDir, dirtyDirs[0], "files", "notes.txt"), "utf8")).toBe("untracked\n");
	expect(readFileSync(join(logDir, dirtyDirs[0], "files", "a.txt"), "utf8")).toBe("my edit\n");
	expect(readFileSync(join(logDir, `${dirtyDirs[0]}.patch`), "utf8")).toContain("+my edit");
	await check(opts());
	expect(logFiles().filter(f => f.endsWith("-dirty"))).toHaveLength(1);
	const j = await apply(opts(), { keep: true });
	expect(j.status).toBe("updated");
	expect(head(work)).toBe(head(pusher));
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("1\n");
});

test("auto-apply on an install that is not a developer checkout saves the conflicting work, updates and says how to get it back", async () => {
	setCfg({ auto_apply: true, keep_local: false });
	commit(work, "a.txt", "local\n", "my conflicting change");
	push("a.txt", "2\n", "second");
	const { h, api } = hooks();
	await autoCheck(opts(), api);
	expect(head(work)).toBe(head(pusher));
	expect(branches()).toHaveLength(1);
	expect(h.alerts).toEqual([]);
	expect(h.restarts).toBe(1);
	expect(h.worklog).toHaveLength(1);
	expect(h.worklog[0]).toContain("dotz-local/");
	expect(h.worklog[0]).toContain("git cherry-pick");
});

test("auto-apply never discards the work of a developer checkout", async () => {
	setCfg({ auto_apply: true });
	commit(work, "a.txt", "local\n", "my conflicting change");
	const mine = head(work);
	push("a.txt", "2\n", "second");
	writeFileSync(join(work, "wip.txt"), "wip\n");
	const { h, api } = hooks();
	await autoCheck(opts(), api);
	expect(head(work)).toBe(mine);
	expect(existsSync(join(work, "wip.txt"))).toBe(true);
	expect(h.restarts).toBe(0);
	expect(h.alerts).toHaveLength(1);
	expect(h.alerts[0]).toContain("\ub0b4 \uc218\uc815\uc744 \ubcf4\uad00\ud558\uace0 \uc0c8 \ubc84\uc804 \ubc1b\uae30");
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
