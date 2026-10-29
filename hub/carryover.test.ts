// Carry-over wake for update backups (hub/carryover.ts), against a real temp repo (no network).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingBackups } from "./carryover.ts";
import { defaultExec } from "./selfupdate.ts";

let root: string, repo: string, logDir: string, dataDir: string;
const sh = (...args: string[]) => {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.toString();
};
const commit = (file: string, text: string) => {
	writeFileSync(join(repo, file), text);
	sh("add", file);
	sh("commit", "-q", "-m", file);
};
const two = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
const SECRET = "SECRET-LINE-IN-DIFF";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-carry-"));
	repo = join(root, "repo");
	logDir = join(root, "logs");
	dataDir = join(root, "data");
	mkdirSync(repo);
	mkdirSync(logDir);
	sh("init", "-q");
	commit("base.txt", "one\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const backupBranch = (name: string) => {
	sh("checkout", "-q", "-b", name);
	commit("hub/i18n-ko.ts", `${SECRET}\nline2\n`.replace(/^/, ""));
	sh("checkout", "-q", "main");
	commit("upstream.txt", "new upstream work\n");
};

test("a backup branch wakes once with its name, files and a short stat, never the diff", async () => {
	mkdirSync(join(repo, "hub"));
	const name = `dotz-local/${stamp(new Date())}`;
	backupBranch(name);
	const first = await pendingBackups(defaultExec, repo, logDir, dataDir);
	expect(first).toHaveLength(1);
	expect(first[0].where).toContain(name);
	expect(first[0].files).toContain("hub/i18n-ko.ts");
	expect(first[0].stat).toBe("파일 1개, +2 -0");
	expect(first[0].read).toContain(name);
	expect(JSON.stringify(first[0])).not.toContain(SECRET);
	expect(JSON.parse(readFileSync(join(dataDir, "self-update", "carryover-handled.json"), "utf8"))[name]).toBeString();
	expect(await pendingBackups(defaultExec, repo, logDir, dataDir)).toEqual([]);
});

test("a new backup after a handled one wakes again, only for the new one", async () => {
	mkdirSync(join(repo, "hub"));
	const old = `dotz-local/${stamp(new Date(Date.now() - 60_000))}`;
	backupBranch(old);
	expect(await pendingBackups(defaultExec, repo, logDir, dataDir)).toHaveLength(1);
	sh("checkout", "-q", "-b", `${old}-2`);
	commit("second.txt", "x\n");
	sh("checkout", "-q", "main");
	const next = await pendingBackups(defaultExec, repo, logDir, dataDir);
	expect(next.map(b => b.id)).toEqual([`${old}-2`]);
});

test("an uncommitted-change backup (patch + copy folder) wakes once", async () => {
	const name = `dotz-local-${stamp(new Date())}-dirty`;
	writeFileSync(join(repo, "base.txt"), "one\nchanged\n");
	writeFileSync(join(logDir, `${name}.patch`), sh("diff", "HEAD"));
	mkdirSync(join(logDir, name));
	sh("checkout", "--", "base.txt");
	const first = await pendingBackups(defaultExec, repo, logDir, dataDir);
	expect(first).toHaveLength(1);
	expect(first[0].files).toContain("base.txt");
	expect(first[0].where).toContain(name);
	expect(await pendingBackups(defaultExec, repo, logDir, dataDir)).toEqual([]);
});

test("a backup older than 30 days is marked handled without a wake", async () => {
	sh("branch", "dotz-local/20200101-1200");
	commit("later.txt", "x\n");
	expect(await pendingBackups(defaultExec, repo, logDir, dataDir)).toEqual([]);
	expect(JSON.parse(readFileSync(join(dataDir, "self-update", "carryover-handled.json"), "utf8"))["dotz-local/20200101-1200"]).toBeString();
});

test("no backups, or not a git folder, wakes nothing and writes nothing", async () => {
	expect(await pendingBackups(defaultExec, repo, logDir, dataDir)).toEqual([]);
	expect(await pendingBackups(defaultExec, root, logDir, dataDir)).toEqual([]);
});

// Mac mini 2026-10-29: the same local edit, saved twice and already in the new version, woke the assistant twice. Neither needs a wake.
test("a backup already in the files or already upstream is handled quietly", async () => {
	const name = `dotz-local-${stamp(new Date())}-dirty`;
	writeFileSync(join(repo, "base.txt"), "one\nchanged\n");
	writeFileSync(join(logDir, `${name}.patch`), sh("diff", "HEAD"));
	mkdirSync(join(logDir, name));
	commit("base.txt", "one\nchanged\n");
	sh("checkout", "-q", "-b", "dotz-local/20261029-1033");
	commit("x.txt", "x\n");
	sh("checkout", "-q", "main");
	sh("cherry-pick", "dotz-local/20261029-1033");
	expect(await pendingBackups(defaultExec, repo, logDir, dataDir)).toEqual([]);
	expect(Object.keys(JSON.parse(readFileSync(join(dataDir, "self-update", "carryover-handled.json"), "utf8"))).sort()).toEqual([name, "dotz-local/20261029-1033"].sort());
});
