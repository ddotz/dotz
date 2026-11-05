import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
