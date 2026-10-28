import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Input } from "./work-hours.ts";

const SCRIPT = join(import.meta.dir, "work-hours.ts");
const accounts = (workLeft: number | null, homeLeft: number | null): Input["accounts"] => [
	{ name: "work", alias: "회사 계정", blocked: null, five_hour_left: workLeft },
	{ name: "home", alias: "개인 계정", blocked: null, five_hour_left: homeLeft },
];

async function dryRun(input: Input): Promise<string[]> {
	const p = Bun.spawn(["bun", SCRIPT], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	expect(await p.exited).toBe(0);
	return out.split("\n").filter(Boolean);
}

// 2026-10-21 is a Wednesday; 01:00Z = 10:00 KST. 2026-10-24 is a Saturday.
test("weekday 10:00 KST: the work account", async () => {
	expect((await dryRun({ now: "2026-10-21T01:00:00Z", current: "home", accounts: accounts(80, 90) }))[0]).toBe("work");
});

test("Saturday: the personal account", async () => {
	expect((await dryRun({ now: "2026-10-24T01:00:00Z", current: "work", accounts: accounts(80, 90) }))[0]).toBe("home");
});

test("weekday 10:00 KST but the work account has 5% of its 5-hour window left: the personal one", async () => {
	const out = await dryRun({ now: "2026-10-21T01:00:00Z", current: "work", accounts: accounts(5, 90) });
	expect(out[0]).toBe("home");
});

test("both under the threshold: no opinion (empty output)", async () => {
	expect(await dryRun({ now: "2026-10-21T01:00:00Z", current: "work", accounts: accounts(5, 3) })).toEqual([]);
});
