import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHeavySlot } from "./heavyslot.ts";
import { runWithReceipt } from "./receipts.ts";
import { clock } from "./runtime/test-clock.ts";

let root = "";
let repo = "";
let dir = "";
let realHome = process.env.HOME;
const sh = (cmd: string) => Bun.spawnSync(["bash", "-c", cmd], { cwd: repo });
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-receipts-"));
	// The receipt runs its command in `bash -lc`, which sources the login profile of $HOME (0.5 s on a dev machine);
	// a throwaway HOME keeps the run about the command only.
	realHome = process.env.HOME;
	process.env.HOME = root;
	repo = join(root, "repo");
	dir = join(root, "store");
	mkdirSync(repo);
	sh("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
});
afterEach(() => {
	process.env.HOME = realHome;
	rmSync(root, { recursive: true, force: true });
});

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

test("two concurrent real runs take turns on one heavy slot", async () => {
	process.env.DOTZ_HEAVY_SLOTS = "1";
	const log = join(root, "order");
	const step = (n: number) => `echo start${n} >> ${log}; echo end${n} >> ${log}`;
	const [a, b] = await Promise.all([go(step(1)), go(step(2))]);
	delete process.env.DOTZ_HEAVY_SLOTS;
	expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["start1", "end1", "start2", "end2"]);
	expect(a.slotNote).toBeUndefined();
	expect(b.slotNote).toContain("waited");
	expect(readdirSync(join(dir, "heavy"))).toEqual([]);
});

test("receipts older than 7 days are pruned on write", async () => {
	mkdirSync(join(dir, "receipts"), { recursive: true });
	const old = join(dir, "receipts", "old.json");
	writeFileSync(old, JSON.stringify({ key: "old", ranAt: Date.now() - 8 * 24 * 3600_000 }));
	await go(counted());
	expect(existsSync(old)).toBe(false);
	expect(readdirSync(join(dir, "receipts")).length).toBe(1);
});

// The owner's stop reaches dotz_verify as an abort signal (OmO releases the turn at once, the tool's own work must end too).
test("an abort kills the running command and gives the slot back", async () => {
	const started = Promise.withResolvers<void>();
	const w = watch(root, (_e, name) => name === "pid" && started.resolve());
	const ctl = new AbortController();
	const p = runWithReceipt({ command: `echo $$ > ${join(root, "pid")}.tmp && mv ${join(root, "pid")}.tmp ${join(root, "pid")}; exec sleep 60`, cwd: repo, dir, signal: ctl.signal });
	await started.promise;
	w.close();
	ctl.abort();
	const r = await p;
	expect(r.exitCode).not.toBe(0);
	const pid = Number(readFileSync(join(root, "pid"), "utf8"));
	expect(() => process.kill(pid, 0)).toThrow();
	expect(readdirSync(join(dir, "heavy"))).toEqual([]);
	expect(existsSync(join(dir, "receipts"))).toBe(false);
}, 10_000);

test("an abort while waiting for the slot ends the wait and never runs the command", async () => {
	process.env.DOTZ_HEAVY_SLOTS = "1";
	const held = await acquireHeavySlot({ dir: join(dir, "heavy"), label: "other run" });
	try {
		const ctl = new AbortController();
		const p = runWithReceipt({ command: counted(), cwd: repo, dir, signal: ctl.signal });
		ctl.abort();
		const r = await p;
		expect(r.exitCode).not.toBe(0);
		expect(runs()).toBe(0);
	} finally {
		held.release();
		delete process.env.DOTZ_HEAVY_SLOTS;
	}
	expect(readdirSync(join(dir, "heavy"))).toEqual([]);
}, 10_000);
