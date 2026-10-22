// Settings → 업데이트 against real git repos in a temp dir: a bare "origin", a clone the updater works on, and a second
// clone that pushes newer commits. The test command is a shell check so a commit can make "the tests" fail on purpose.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, DATA_DIR } from "./config.ts";
import { type AutoHooks, apply, autoCheck, check, defaultExec, type Exec, failureBlocks, fetchError, scrub } from "./selfupdate.ts";

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
const head = (dir: string) => sh(dir, "rev-parse", "HEAD");
// "Tests" fail while a file named FAIL is in the checkout.
const testCmd = ["sh", "-c", "test ! -f FAIL"];
const opts = (exec?: Exec) => ({ dir: work, remote: "origin", branch: "main", testCmd, logDir, exec });

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-selfupdate-"));
	origin = join(root, "origin.git");
	work = join(root, "work");
	pusher = join(root, "pusher");
	logDir = join(root, "logs");
	sh(root, "init", "-q", "--bare", origin);
	sh(root, "clone", "-q", origin, pusher);
	commit(pusher, "a.txt", "1\n", "first");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	sh(root, "clone", "-q", origin, work);
});
afterEach(() => {
	(cfg as Record<string, unknown>).self_update = undefined;
	rmSync(root, { recursive: true, force: true });
});

test("check lists the incoming commits and changes nothing in the checkout", async () => {
	const before = head(work);
	commit(pusher, "a.txt", "2\n", "second change");
	commit(pusher, "b.txt", "x\n", "third change");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	const c = await check(opts());
	expect(c.ok).toBe(true);
	expect(c.incomingTotal).toBe(2);
	expect(c.incoming.map(i => i.subject)).toEqual(["third change", "second change"]);
	expect(c.blocked).toEqual([]);
	expect(head(work)).toBe(before);
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("1\n");
});

test("uncommitted changes refuse the update, name the file and keep it", async () => {
	const before = head(work);
	commit(pusher, "a.txt", "2\n", "second");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	writeFileSync(join(work, "a.txt"), "my edit\n");
	writeFileSync(join(work, "notes.txt"), "untracked\n");
	const j = await apply(opts());
	expect(j.status).toBe("refused");
	expect(j.message).toContain("a.txt");
	expect(j.message).toContain("notes.txt");
	expect(head(work)).toBe(before);
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("my edit\n");
	expect(existsSync(join(work, "notes.txt"))).toBe(true);
});

test("local commits that are not on origin refuse the update and are listed, never dropped", async () => {
	commit(work, "mine.txt", "local\n", "my local work");
	const mine = head(work);
	commit(pusher, "a.txt", "2\n", "second");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	const j = await apply(opts());
	expect(j.status).toBe("refused");
	expect(j.message).toContain("my local work");
	expect(head(work)).toBe(mine);
});

test("a clean checkout fast-forwards to origin, tests pass, every step is logged", async () => {
	const before = head(work);
	commit(pusher, "a.txt", "2\n", "second");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	const target = head(pusher);
	const seen: string[] = [];
	const j = await apply(opts(async (cmd, cwd, ms) => (seen.push(cmd.join(" ")), defaultExec(cmd, cwd, ms))));
	expect(j.status).toBe("updated");
	expect(j.from).toBe(before);
	expect(j.to).toBe(target);
	expect(head(work)).toBe(target);
	expect(seen.some(c => c.startsWith("git merge --ff-only "))).toBe(true);
	expect(seen.some(c => c === "bun install")).toBe(false);
	const logs = readdirSync(logDir).map(f => readFileSync(join(logDir, f), "utf8")).join("");
	expect(logs).toContain("fast-forward");
	expect(logs).toContain("받았어요");
});

test("a changed package.json runs bun install before the tests", async () => {
	commit(pusher, "package.json", "{}\n", "deps");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	const seen: string[] = [];
	const exec: Exec = async (cmd, cwd, ms) => {
		seen.push(cmd.join(" "));
		return cmd[0] === "bun" ? { code: 0, out: "" } : defaultExec(cmd, cwd, ms);
	};
	const j = await apply(opts(exec));
	expect(j.status).toBe("updated");
	expect(seen.indexOf("bun install")).toBeGreaterThan(-1);
	expect(seen.indexOf("bun install")).toBeLessThan(seen.indexOf(testCmd.join(" ")));
});

test("failing tests put the checkout back on the old commit", async () => {
	const before = head(work);
	commit(pusher, "FAIL", "boom\n", "breaks the tests");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	const j = await apply(opts());
	expect(j.status).toBe("failed");
	expect(j.message).toContain("테스트 실패");
	expect(head(work)).toBe(before);
	expect(existsSync(join(work, "FAIL"))).toBe(false);
	expect(sh(work, "status", "--porcelain")).toBe("");
});

test("failureBlocks keeps the error block bun prints before each (fail) line, and nothing from passing tests", () => {
	const out = [
		"bun test v1.4.2",
		"",
		"hub/a.test.ts:",
		"(pass) a > fine [0.10ms]",
		"12 |   const id = await ask({ site: \"shop-once\" });",
		"13 |   expect(leaks).not.toContain(bit);",
		"                       ^",
		"error: expect(received).not.toContain(expected)",
		"",
		"Expected to not contain: \"7391\"",
		"Received: \"...7391...\"",
		"",
		"      at <anonymous> (hub/auth.test.ts:94:30)",
		"(fail) one-time form [2.40ms]",
		"(pass) a > also fine [0.20ms]",
		"",
		"hub/b.test.ts:",
		"error: boom",
		"      at <anonymous> (hub/b.test.ts:5:9)",
		"(fail) b > broken [1.00ms]",
		"",
		" 1142 pass",
		" 2 fail",
	].join("\n");
	const kept = failureBlocks(out);
	expect(kept).toContain("error: expect(received).not.toContain(expected)");
	expect(kept).toContain("Expected to not contain: \"7391\"");
	expect(kept).toContain("(fail) one-time form [2.40ms]");
	expect(kept).toContain("error: boom\n      at <anonymous> (hub/b.test.ts:5:9)\n(fail) b > broken [1.00ms]");
	expect(kept).not.toContain("(pass)");
	expect(kept).not.toContain("a.test.ts:\n");
	expect(failureBlocks("(pass) x [1ms]\n 3 pass\n 0 fail")).toBe("");
	// capped: many failures keep a bounded number of blocks and say how many were dropped
	const many = Array.from({ length: 40 }, (_, i) => `error: e${i}\n(fail) t${i} [1ms]`).join("\n");
	const capped = failureBlocks(many);
	expect(capped).toContain("error: e0");
	expect(capped).not.toContain("error: e39");
	expect(capped).toContain("25 more failure(s) not kept");
});

test("a failing apply logs the failing test block, not only the tail", async () => {
	commit(pusher, "FAIL", "boom\n", "breaks the tests");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	const exec: Exec = async (cmd, cwd, ms) =>
		cmd.join(" ") === testCmd.join(" ") ? { code: 1, out: `${"noise\n".repeat(100)}error: expect(received).toBe(expected)\n(fail) the broken one [1ms]\n 1 fail\n` } : defaultExec(cmd, cwd, ms);
	const j = await apply(opts(exec));
	expect(j.status).toBe("failed");
	const logged = readdirSync(logDir).map(f => readFileSync(join(logDir, f), "utf8")).join("\n");
	expect(logged).toContain("failed tests\nnoise");
	expect(logged).toContain("error: expect(received).toBe(expected)\n(fail) the broken one [1ms]");
});

test("nothing new is reported as current and does not run the tests", async () => {
	const seen: string[] = [];
	const j = await apply(opts(async (cmd, cwd, ms) => (seen.push(cmd.join(" ")), defaultExec(cmd, cwd, ms))));
	expect(j.status).toBe("current");
	expect(seen).not.toContain(testCmd.join(" "));
});

test("a fetch failure says why and how to fix it", async () => {
	sh(work, "remote", "set-url", "origin", join(root, "missing.git"));
	const c = await check(opts());
	expect(c.ok).toBe(false);
	expect(c.error?.reason).toBeTruthy();
	const auth = fetchError("fatal: could not read Username for 'https://github.com': terminal prompts disabled", "origin");
	expect(auth.fix).toContain("gh auth login");
	expect(scrub("https://x-access-token:ghp_abcdefghijklmnop@github.com/o/r")).not.toContain("ghp_");
});

// auto_apply: the daily check applies by itself. Local repos only, no network; hooks record what main.ts would do.
const autoOn = () => {
	(cfg as Record<string, unknown>).self_update = { auto_apply: true };
	rmSync(join(DATA_DIR, "self-update.json"), { force: true });
};
const hooks = () => {
	const h = { worklog: [] as string[], alerts: [] as string[], restarts: 0 };
	const api: AutoHooks = { worklog: t => void h.worklog.push(t), alert: t => void h.alerts.push(t), restartIdle: () => (h.restarts++, "queued") };
	return { h, api };
};
const pushNew = (file = "a.txt") => {
	commit(pusher, file, "2\n", "second");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
};

test("auto_apply off (default): a new commit only notifies, nothing is applied or restarted", async () => {
	(cfg as Record<string, unknown>).self_update = undefined;
	rmSync(join(DATA_DIR, "self-update.json"), { force: true });
	const before = head(work);
	pushNew();
	const { h, api } = hooks();
	await autoCheck(opts(), api);
	expect(head(work)).toBe(before);
	expect(h).toEqual({ worklog: [], alerts: [], restarts: 0 });
});

test("auto_apply applies a clean, not-ahead checkout, says so in worklog and restarts through the idle gate", async () => {
	autoOn();
	pushNew();
	const target = head(pusher);
	const { h, api } = hooks();
	await autoCheck(opts(), api);
	expect(head(work)).toBe(target);
	expect(h.worklog).toHaveLength(1);
	expect(h.worklog[0]).toContain("자동 업데이트");
	expect(h.restarts).toBe(1);
	expect(h.alerts).toEqual([]);
});

test("auto_apply refuses a dirty checkout: alert with a choice block, once, nothing changes, no restart", async () => {
	autoOn();
	const before = head(work);
	pushNew();
	writeFileSync(join(work, "a.txt"), "my edit\n");
	const { h, api } = hooks();
	await autoCheck(opts(), api);
	await autoCheck(opts(), api);
	expect(head(work)).toBe(before);
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("my edit\n");
	expect(h.alerts).toHaveLength(1);
	expect(h.alerts[0]).toContain("결정:");
	expect(h.alerts[0]).toContain("1) ");
	expect(h.restarts).toBe(0);
	expect(h.worklog).toEqual([]);
});

test("auto_apply refuses when local commits are ahead of origin", async () => {
	autoOn();
	commit(work, "mine.txt", "local\n", "my local work");
	const mine = head(work);
	pushNew();
	const { h, api } = hooks();
	await autoCheck(opts(), api);
	expect(head(work)).toBe(mine);
	expect(h.alerts).toHaveLength(1);
	expect(h.alerts[0]).toContain("로컬 커밋");
	expect(h.restarts).toBe(0);
});

test("auto_apply reverts on a test failure, alerts with a choice block, does not retry that commit and does not restart", async () => {
	autoOn();
	const before = head(work);
	commit(pusher, "FAIL", "boom\n", "breaks the tests");
	sh(pusher, "push", "-q", "origin", "HEAD:main");
	const seen: string[] = [];
	const exec: Exec = async (cmd, cwd, ms) => (seen.push(cmd.join(" ")), defaultExec(cmd, cwd, ms));
	const { h, api } = hooks();
	await autoCheck(opts(exec), api);
	expect(head(work)).toBe(before);
	expect(h.alerts).toHaveLength(1);
	expect(h.alerts[0]).toContain("테스트 실패");
	expect(h.alerts[0]).toContain("결정:");
	expect(h.restarts).toBe(0);
	expect(h.worklog).toEqual([]);
	const merges = seen.filter(c => c.startsWith("git merge --ff-only ")).length;
	await autoCheck(opts(exec), api);
	expect(seen.filter(c => c.startsWith("git merge --ff-only ")).length).toBe(merges);
	expect(h.alerts).toHaveLength(1);
});
