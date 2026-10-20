// dotz_watch robustness from 오모냥's launchd watchers: process-group SIGKILL deadline, per-kind retry, owner-approval gate.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, paths } from "./config.ts";
import { advance, clock } from "./runtime/test-clock.ts";
import { addWatch, allWatches, approveWatch, exec, listWatches, patchWatch, removeWatch, runWatch, startWatches } from "./watch.ts";

const notes: { name: string; reason: string }[] = [];
let waiter: (() => void) | undefined;
const nextNote = () => new Promise<void>(r => (waiter = r));
beforeAll(() =>
	startWatches((w, reason) => {
		notes.push({ name: w.name, reason });
		waiter?.();
	}),
);
afterEach(() => {
	for (const w of allWatches()) removeWatch(w.id);
	notes.length = 0;
});
const state = (name: string) => allWatches().find(w => w.name === name)!.state;
const approval = (name: string) => join(DATA_DIR, "approvals", name);

// No wall-clock waits: the shell reports the grandchild's pid through a FIFO once it runs, and only then is the deadline
// reached. The read can only finish once every holder of the output pipe is gone (the read grace is a fake-clock timer
// nobody advances), so the run settling proves the grandchild exited; ps then sees that pid gone or a zombie, never
// running. A name match (pgrep) also saw unreaped zombies and other runs' sleeps.
test("the deadline SIGKILLs the whole process group, so a background grandchild cannot hold the read", async () => {
	const fifo = join(mkdtempSync(join(tmpdir(), "dotz-pgkill-")), "pid");
	expect((await Bun.spawn(["mkfifo", fifo]).exited)).toBe(0);
	const run = exec(["/bin/zsh", "-c", `sleep 600 & echo $! > ${fifo}; wait`], undefined, 1000);
	const pid = Number((await readFile(fifo, "utf8")).trim());
	expect(pid).toBeGreaterThan(0);
	await advance(1000);
	const r = await run;
	expect(r.timedOut).toBe(true);
	expect(r.output).toContain("killed after 1 s");
	const ps = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" });
	const stat = (await new Response(ps.stdout).text()).trim();
	expect(stat === "" || stat.startsWith("Z")).toBe(true);
});

test("each failure kind waits its own retry minutes, the last one repeats, and an empty list stops the watch", async () => {
	const out = join(DATA_DIR, "watch-kind.txt");
	writeFileSync(out, "DOTZ_FAIL retry\n");
	addWatch({ name: "t-retry", command: `cat '${out}'; exit 1`, on: "fail", to: "alert", retry: { retry: [2, 5], badpw: [] } }, "");
	await runWatch("t-retry");
	expect(state("t-retry")).toMatchObject({ kind: "retry", kindFails: 1, nextAt: Date.now() + 2 * 60_000 });
	await runWatch("t-retry");
	await runWatch("t-retry");
	expect(state("t-retry")).toMatchObject({ kindFails: 3, nextAt: Date.now() + 5 * 60_000 });
	writeFileSync(out, "DOTZ_FAIL badpw\n");
	await runWatch("t-retry");
	expect(state("t-retry").paused).toBe("badpw");
	expect(notes.at(-1)?.reason).toContain("stopped after a badpw failure");
	const runs = state("t-retry").lastRun;
	clock.now += 1000;
	await runWatch("t-retry");
	expect(state("t-retry").lastRun).toBe(runs);
});

test("the approval gate asks the owner once, the check sees the approval, and the step consumes it", async () => {
	const cmd = `if [ "$DOTZ_APPROVED" = 1 ]; then echo DOTZ_APPROVAL_USED; echo DOTZ_FAIL fido; exit 1; fi; echo DOTZ_FAIL approval; exit 1`;
	addWatch({ name: "t-approve", command: cmd, on: "fail", to: "alert", approval_minutes: 30, retry: { fido: [30] } }, "");
	await runWatch("t-approve");
	await runWatch("t-approve");
	expect(notes.filter(n => n.reason.includes("needs the owner's approval"))).toHaveLength(1);
	approveWatch("t-approve");
	expect(existsSync(approval("t-approve"))).toBe(true);
	await runWatch("t-approve");
	expect(existsSync(approval("t-approve"))).toBe(false);
	expect(state("t-approve")).toMatchObject({ kind: "fido", nextAt: Date.now() + 30 * 60_000 });
});

const stored = (name: string) => JSON.parse(readFileSync(paths.watches, "utf8")).find((w: { name: string }) => w.name === name);

test("a watch edit is persisted, validated, and the timer follows the new interval", async () => {
	const out = join(DATA_DIR, "watch-patch.txt");
	writeFileSync(out, "");
	const w = addWatch({ name: "t-patch", command: `echo run >> '${out}'; wc -l < '${out}'`, every_minutes: 60, on: "change", to: "alert" }, "");
	await runWatch("t-patch");
	const view = patchWatch(w.id, { every_minutes: 5, on: "match", pattern: "^2$" });
	expect(view).toMatchObject({ every_minutes: 5, on: "match", pattern: "^2$" });
	expect(stored("t-patch")).toMatchObject({ every_minutes: 5, on: "match", pattern: "^2$" });
	const second = nextNote();
	await advance(6 * 60_000);
	await second;
	expect(notes.at(-1)).toEqual({ name: "t-patch", reason: "matched /^2$/" });
	expect(readFileSync(out, "utf8")).toBe("run\nrun\n");
	expect(patchWatch("t-patch", { on: "change" })).not.toHaveProperty("pattern");
	for (const bad of [{ every_minutes: 0 }, { every_minutes: 10081 }, { every_minutes: 2.5 }, { every_minutes: "5" }, { on: "sometimes" }, { pattern: "x" }, { on: "match", pattern: "(" }, { paused: "yes" }]) expect(() => patchWatch(w.id, bad)).toThrow();
	expect(stored("t-patch")).toMatchObject({ every_minutes: 5, on: "change" });
	expect(() => patchWatch("nope", { paused: true })).toThrow("no watch");
});

test("a paused watch stays listed and persisted but stops running; resuming arms it again", async () => {
	const out = join(DATA_DIR, "watch-pause.txt");
	writeFileSync(out, "");
	const w = addWatch({ name: "t-pause", command: `echo run >> '${out}'; wc -l < '${out}'`, every_minutes: 5, on: "change", to: "alert" }, "");
	await runWatch("t-pause");
	patchWatch(w.id, { paused: true });
	await advance(30 * 60_000);
	await runWatch("t-pause");
	expect(readFileSync(out, "utf8")).toBe("run\n");
	expect(notes).toEqual([]);
	expect(listWatches().find(x => x.name === "t-pause")).toMatchObject({ paused: true });
	expect(stored("t-pause").paused).toBe(true);
	const resumed = nextNote();
	patchWatch(w.id, { paused: false });
	expect(listWatches().find(x => x.name === "t-pause")).not.toHaveProperty("paused");
	await advance(5 * 60_000);
	await resumed;
	expect(readFileSync(out, "utf8")).toBe("run\nrun\n");
});

test("an approval expires after approval_minutes", async () => {
	const seen = join(DATA_DIR, "watch-approved.txt");
	writeFileSync(seen, "");
	addWatch({ name: "t-expire", command: `echo $DOTZ_APPROVED >> '${seen}'`, on: "fail", to: "alert", approval_minutes: 30 }, "");
	await runWatch("t-expire");
	approveWatch("t-expire");
	await runWatch("t-expire");
	clock.now += 31 * 60_000;
	await runWatch("t-expire");
	expect(readFileSync(seen, "utf8")).toBe("0\n1\n0\n");
	expect(existsSync(approval("t-expire"))).toBe(false);
	expect(() => addWatch({ name: "t-bad", command: "true", retry: { fido: [0] } }, "")).toThrow("retry.fido");
});
