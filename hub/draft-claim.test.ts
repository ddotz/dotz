import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimHolder, claimSend } from "./draft-claim.ts";

const dir = mkdtempSync(join(tmpdir(), "claim-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("one holder at a time; the release lets the next one claim", () => {
	const f = join(dir, "sending", "R1");
	const a = claimSend(f);
	expect(a).toBeDefined();
	expect(claimSend(f)).toBeUndefined();
	a!();
	expect(existsSync(f)).toBe(false);
	const b = claimSend(f);
	expect(b).toBeDefined();
	b!();
});

test("a claim of a pid another process now uses is dead: the start time differs; a holder's own claim stays live", () => {
	const f = join(dir, "sending", "R3");
	writeFileSync(f, `${process.pid} Mon Jan  1 00:00:00 2001`);
	expect(claimHolder(f)).toBe("dead");
	expect(claimSend(f)).toBeUndefined();
	const mine = claimSend(f, true);
	expect(mine).toBeDefined();
	expect(claimHolder(f)).toBe("live");
	mine!();
});

test("a claim left by a process that is gone may have sent: it is kept until the caller says it takes over; one of a live process is never taken", async () => {
	const gone = Bun.spawn([process.execPath, "-e", "0"]);
	await gone.exited;
	const f = join(dir, "sending", "R2");
	expect(claimHolder(f)).toBe("none");
	writeFileSync(f, String(gone.pid));
	expect(claimHolder(f)).toBe("dead");
	expect(claimSend(f)).toBeUndefined();
	expect(existsSync(f)).toBe(true);
	const taken = claimSend(f, true);
	expect(taken).toBeDefined();
	taken!();
	writeFileSync(f, String(process.ppid));
	expect(claimHolder(f)).toBe("live");
	expect(claimSend(f, true)).toBeUndefined();
});

test("a claim whose pid cannot be read is held by a live sender and never taken over", () => {
	const f = join(dir, "sending", "R4");
	for (const content of ["", "garbage", "-5", "1.5 Mon"]) {
		writeFileSync(f, content);
		expect(claimHolder(f), content).toBe("live");
		expect(claimSend(f, true), content).toBeUndefined();
		expect(existsSync(f)).toBe(true);
	}
});

test("an error other than an existing claim is thrown, not read as a lost race", () => {
	expect(() => claimSend(join(dir, "sending", `R5-${"x".repeat(300)}`))).toThrow();
});

test("a claim path that cannot be read as a claim is left alone even when the caller takes over", () => {
	const f = join(dir, "sending", "R6");
	mkdirSync(join(f, "inner"), { recursive: true });
	expect(claimHolder(f)).toBe("none");
	expect(claimSend(f, true)).toBeUndefined();
	expect(existsSync(join(f, "inner"))).toBe(true);
});
