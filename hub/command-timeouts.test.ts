import { expect, test } from "bun:test";
import { runCli } from "./approval-send.ts";
import { spawnExec } from "./mail-sync.ts";
import { advance } from "./runtime/test-clock.ts";

// Callers that run an outside command through their own injection point take their normal failure path when the command hangs.
// The preload's manual clock is what ends the limit; the child is a real `sleep`.

test("a mailbox action that hangs comes back as a failed action, not a hang", async () => {
	const running = spawnExec(["sleep", "30"]);
	await advance(120_000);
	const r = await running;
	expect(r.code).not.toBe(0);
	expect(r.stderr).toBe("timed out");
});

test("a send CLI that hangs fails the send with its reason", async () => {
	const running = runCli(["sleep", "30"]);
	await advance(5 * 60_000);
	const r = await running;
	expect(r.code).not.toBe(0);
	expect(r.out).toContain("timed out");
});
