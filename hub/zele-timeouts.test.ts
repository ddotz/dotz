import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance } from "./runtime/test-clock.ts";
import { zeleAccounts, zeleRead } from "./zele.ts";

// A zele binary that never answers: the mail read fails with its reason and the account list is empty, as when zele is missing.
const dir = mkdtempSync(join(tmpdir(), "dotz-zele-hang-"));
const oldPath = process.env.PATH;
beforeAll(() => {
	writeFileSync(join(dir, "zele"), "#!/bin/sh\nexec sleep 30\n");
	chmodSync(join(dir, "zele"), 0o755);
	process.env.PATH = `${dir}:${oldPath}`;
});
afterAll(() => {
	process.env.PATH = oldPath;
	rmSync(dir, { recursive: true, force: true });
});

test("a thread read that hangs fails with a timeout reason", async () => {
	const reading = zeleRead("t1", "").then(() => "read", (e: Error) => e.message);
	await advance(60_000);
	expect(await reading).toBe("timed out");
});

test("an account check that hangs gives no accounts", async () => {
	const asking = zeleAccounts();
	await advance(30_000);
	expect(await asking).toEqual([]);
});
