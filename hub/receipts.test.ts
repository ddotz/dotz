import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithReceipt } from "./receipts.ts";
import { clock } from "./runtime/test-clock.ts";

let root = "";
let repo = "";
let dir = "";
const sh = (cmd: string) => Bun.spawnSync(["bash", "-c", cmd], { cwd: repo });
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-receipts-"));
	repo = join(root, "repo");
	dir = join(root, "store");
	mkdirSync(repo);
	sh("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// The command appends a line per real execution, so the counter file shows how often it actually ran.
const counted = (exit = 0) => `echo x >> ${join(root, "count")}; echo out; exit ${exit}`;
const runs = () => (existsSync(join(root, "count")) ? readFileSync(join(root, "count"), "utf8").trim().split("\n").length : 0);
const go = (command: string, env?: string[]) => runWithReceipt({ command, cwd: repo, env, dir });

test("same key is reused without running the command again", async () => {
	const first = await go(counted());
	const second = await go(counted());
	expect([first.reused, second.reused]).toEqual([false, true]);
	expect(second.key).toBe(first.key);
	expect(second.stdout).toBe("out\n");
	expect(runs()).toBe(1);
});

test("a pass is reused for 6 hours, then run again", async () => {
	await go(counted());
	clock.now += 6 * 3600_000 - 1;
	expect((await go(counted())).reused).toBe(true);
	clock.now += 1;
	expect((await go(counted())).reused).toBe(false);
	expect(runs()).toBe(2);
});

test("outside git nothing is reused (the content is unknown)", async () => {
	const plain = join(root, "plain");
	mkdirSync(plain);
	const first = await runWithReceipt({ command: counted(), cwd: plain, dir });
	const second = await runWithReceipt({ command: counted(), cwd: plain, dir });
	expect([first.head, first.reused, second.reused]).toEqual(["no-git", false, false]);
	expect(runs()).toBe(2);
});

test("a new commit is a new key", async () => {
	const first = await go(counted());
	sh("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m next");
	const second = await go(counted());
	expect(second.reused).toBe(false);
	expect(second.head).not.toBe(first.head);
	expect(runs()).toBe(2);
});

test("uncommitted edits, tracked or untracked, are a new key", async () => {
	writeFileSync(join(repo, "a.txt"), "1");
	sh("git add a.txt && git -c user.email=t@t -c user.name=t commit -q -m a");
	await go(counted());
	writeFileSync(join(repo, "a.txt"), "2");
	expect((await go(counted())).reused).toBe(false);
	expect((await go(counted())).reused).toBe(true);
	writeFileSync(join(repo, "new.txt"), "1");
	expect((await go(counted())).reused).toBe(false);
	writeFileSync(join(repo, "new.txt"), "2");
	expect((await go(counted())).reused).toBe(false);
	expect(runs()).toBe(4);
});

test("a failure is not cached as truth", async () => {
	const first = await go(counted(3));
	const second = await go(counted(3));
	expect([first.exitCode, first.reused, second.exitCode, second.reused]).toEqual([3, false, 3, false]);
	expect(runs()).toBe(2);
});

test("env values that matter are part of the key", async () => {
	process.env.DOTZ_RECEIPT_TEST = "a";
	await go(counted(), ["DOTZ_RECEIPT_TEST"]);
	expect((await go(counted(), ["DOTZ_RECEIPT_TEST"])).reused).toBe(true);
	process.env.DOTZ_RECEIPT_TEST = "b";
	expect((await go(counted(), ["DOTZ_RECEIPT_TEST"])).reused).toBe(false);
	delete process.env.DOTZ_RECEIPT_TEST;
});

test("stored output is capped to a tail", async () => {
	const r = await go("head -c 20000 /dev/zero | tr '\\0' a; echo END");
	expect(r.stdout.length).toBe(4096);
	expect(r.stdout.endsWith("END\n")).toBe(true);
});

test("receipts older than 7 days are pruned on write", async () => {
	mkdirSync(join(dir, "receipts"), { recursive: true });
	const old = join(dir, "receipts", "old.json");
	writeFileSync(old, JSON.stringify({ key: "old", ranAt: Date.now() - 8 * 24 * 3600_000 }));
	await go(counted());
	expect(existsSync(old)).toBe(false);
	expect(readdirSync(join(dir, "receipts")).length).toBe(1);
});
