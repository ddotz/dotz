import { expect, test } from "bun:test";
import { createApprovalSender, MAY_HAVE_GONE_OUT, runCli, type SendResult } from "./approval-send.ts";
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

test("a send CLI that hangs is reported as timed out", async () => {
	const running = runCli(["sleep", "30"]);
	await advance(15 * 60_000);
	const r = await running;
	expect(r.code).not.toBe(0);
	expect(r.out).toContain("timed out");
	expect(r.timedOut).toBe(true);
});

// A send killed at its limit may have gone out: it ends unsure with the existing text, never failed (the owner would send it twice). A plain failure stays failed.
async function endOf(run: () => Promise<{ code: number; out: string; timedOut?: boolean }>): Promise<SendResult> {
	const reports: SendResult[] = [];
	const s = createApprovalSender({ kind: () => ({ kind: "mail", lane: "mail:zele" }), run, report: r => void reports.push(r), log: () => undefined });
	expect(s.enqueue({ ref: "RAAAAAA", conv: "ch:1", action: "send", title: "x (RAAAAAA)" })).toBe(true);
	await s.idle();
	return reports.at(-1)!;
}

test("a send that timed out ends unsure with the may-have-gone-out text", async () => {
	const end = await endOf(async () => ({ code: 124, out: "\ntimed out", timedOut: true }));
	expect(end.state).toBe("unsure");
	expect(end.text).toBe(MAY_HAVE_GONE_OUT);
});

test("a send that failed on its own still ends failed", async () => {
	const end = await endOf(async () => ({ code: 1, out: "로그인이 풀렸어요" }));
	expect(end.state).toBe("failed");
});
