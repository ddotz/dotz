import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimSend } from "./draft-claim.ts";

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

test("a claim left by a process that is gone is taken over; one of a live process is not", async () => {
	const gone = Bun.spawn([process.execPath, "-e", "0"]);
	await gone.exited;
	const f = join(dir, "sending", "R2");
	writeFileSync(f, String(gone.pid));
	const taken = claimSend(f);
	expect(taken).toBeDefined();
	taken!();
	writeFileSync(f, String(process.ppid));
	expect(claimSend(f)).toBeUndefined();
});
