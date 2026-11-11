// The usage screen keeps the Claude limit row when a usage read fails: the last good value stays with its read time, one log line
// per failure streak says why, and a value older than its window's reset is never shown as current.
import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQuota } from "./providers.ts";
import { AccountUsage, limitsOf, limitsText } from "./usage-account.ts";

const body = (five: number, week: number) => ({ five_hour: { utilization: five, resets_at: "2030-01-01T05:00:00Z" }, seven_day: { utilization: week, resets_at: "2030-01-07T00:00:00Z" }, seven_day_opus: null });
const T0 = Date.parse("2030-01-01T00:00:00Z");
const acct = { name: "work", pinned: true, token: "t", expiresAt: null };

let dir = "";
let now = T0;
let logs: string[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "usage-last-"));
	now = T0;
	logs = [];
});
const store = async () => new (await import("./usage-last.ts")).UsageLast(join(dir, "usage-last.json"), m => logs.push(m), () => now);

test("a failed `usage --json` read still yields the anthropic row with the old limits and the read time", async () => {
	const { readReports } = await import("./usage-last.ts");
	const last = await store();
	const good = { provider: "anthropic", metadata: { email: "me@example.com" }, limits: limitsOf(body(40, 70)) };
	let ok = true;
	const read = async () => (ok ? { reports: [good] } : { reason: "exit 1" });
	await readReports(read, last);
	ok = false;
	now += 5 * 60_000;
	const reports = await readReports(read, last);
	const row = buildQuota(reports ?? [], ["anthropic"], now).providers.find(p => p.provider === "anthropic");
	expect(row?.limits.find(l => l.id === "anthropic:5h")?.used).toBe(40);
	expect(row?.stale).toBe(true);
	expect(row?.read_at).toBe(T0);
});

test("a fresh read is not marked stale", async () => {
	const { readReports } = await import("./usage-last.ts");
	const reports = await readReports(async () => ({ reports: [{ provider: "anthropic", limits: limitsOf(body(40, 70)) }] }), await store());
	const row = buildQuota(reports ?? [], ["anthropic"], now).providers[0]!;
	expect("stale" in row).toBe(false);
	expect("read_at" in row).toBe(false);
});

for (const [name, failing] of [["answers 500", async () => new Response("", { status: 500 })], ["throws", async (): Promise<Response> => { throw new Error("network down"); }]] as const) {
	test(`an account read that ${name} keeps the saved last value, also on a fresh instance after a restart`, async () => {
		const first = new AccountUsage(async () => Response.json(body(40, 70)), () => now, await store());
		expect((await first.report(acct)).limits.length).toBe(2);
		now += 10 * 60_000;
		const restarted = new AccountUsage(failing, () => now, await store());
		const r = await restarted.report(acct);
		expect(r.problem).toBe("failed");
		expect(r.limits.map(l => l.amount.used)).toEqual([40, 70]);
		expect(r.fetchedAt).toBe(T0);
	});
}

test("one log line per failure streak, and one when the read recovers", async () => {
	let status = 500;
	const u = new AccountUsage(async () => (status === 200 ? Response.json(body(40, 70)) : new Response("", { status })), () => now, await store());
	await u.report(acct);
	status = 500;
	for (let i = 0; i < 4; i++) {
		now += 3 * 60_000;
		await u.report(acct);
	}
	expect(logs.length).toBe(1);
	expect(logs[0]).toContain("account:work");
	expect(logs[0]).toContain("500");
	status = 200;
	now += 3 * 60_000;
	await u.report(acct);
	expect(logs.length).toBe(2);
	expect(logs[1]).toContain("account:work");
	status = 500;
	now += 3 * 60_000;
	await u.report(acct);
	expect(logs.length).toBe(3);
});

test("the omp usage read logs once per streak with the reason, and again on recovery", async () => {
	const { readReports } = await import("./usage-last.ts");
	const last = await store();
	let reason: string | undefined;
	const read = async () => (reason ? { reason } : { reports: [{ provider: "anthropic", limits: limitsOf(body(40, 70)) }] });
	await readReports(read, last);
	reason = "timed out after 45 s";
	for (let i = 0; i < 3; i++) await readReports(read, last);
	expect(logs.length).toBe(1);
	expect(logs[0]).toContain("omp:anthropic");
	expect(logs[0]).toContain("timed out");
	reason = undefined;
	await readReports(read, last);
	expect(logs.length).toBe(2);
});

test("the last good value is written only when a good read changed it", async () => {
	const { readReports } = await import("./usage-last.ts");
	const last = await store();
	const file = join(dir, "usage-last.json");
	let five = 40;
	const read = async () => ({ reports: [{ provider: "anthropic", limits: limitsOf(body(five, 70)) }] });
	await readReports(read, last);
	const saved = readFileSync(file, "utf8");
	now += 60_000;
	await readReports(read, last);
	expect(readFileSync(file, "utf8")).toBe(saved);
	five = 41;
	await readReports(read, last);
	expect(readFileSync(file, "utf8")).not.toBe(saved);
});

test("a held limit whose window has reset is not shown with its old percent", () => {
	const later = Date.parse("2030-01-03T00:00:00Z");
	const r = { provider: "anthropic" as const, account: "work", via: "omo-pinned" as const, limits: limitsOf(body(40, 70)), fetchedAt: T0, problem: "failed" as const };
	const row = buildQuota([r], ["anthropic"], later).providers[0]!;
	const five = row.limits.find(l => l.id === "anthropic:5h")!;
	expect([five.used, five.remaining, five.status]).toEqual([null, null, "reset"]);
	expect(row.limits.find(l => l.id === "anthropic:7d")?.used).toBe(70);
	const text = limitsText(r, later);
	expect(text).not.toContain("40.0% used");
	expect(text).toContain("70.0% used");
});
