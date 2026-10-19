// dotz_watch robustness from 오모냥's launchd watchers: process-group SIGKILL deadline, per-kind retry, owner-approval gate.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { advance, clock } from "./runtime/test-clock.ts";
import { addWatch, allWatches, approveWatch, exec, removeWatch, runWatch, startWatches } from "./watch.ts";

const notes: { name: string; reason: string }[] = [];
beforeAll(() => startWatches((w, reason) => notes.push({ name: w.name, reason })));
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
