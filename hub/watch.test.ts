// dotz_watch robustness from 오모냥's launchd watchers: process-group SIGKILL deadline, per-kind retry, owner-approval gate.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

test("the deadline SIGKILLs the whole process group, so a background grandchild cannot hold the read", async () => {
	const run = exec(["/bin/zsh", "-c", "sleep 47 & sleep 47"], undefined, 1000);
	await advance(1000);
	const r = await run;
	expect(r.timedOut).toBe(true);
	expect(r.output).toContain("killed after 1 s");
	expect((await Bun.spawn(["pgrep", "-f", "sleep 47"]).exited)).toBe(1);
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
