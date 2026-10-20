// Settings → 업데이트 against real git repos in a temp dir: a bare "origin", a clone the updater works on, and a second
// clone that pushes newer commits. The test command is a shell check so a commit can make "the tests" fail on purpose.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, check, defaultExec, type Exec, fetchError, scrub } from "./selfupdate.ts";

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
afterEach(() => rmSync(root, { recursive: true, force: true }));

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
