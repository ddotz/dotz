// watchkit: quiet hours across midnight, zone-time conversion, the runner's retry / counter / skip rules and failure mapping.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { SetupError } from "../lib/config.ts";
import { AuthError, failFrom, inQuietHours, oneLine, runWatch, TransientError, zonedDay, zonedToDate } from "../lib/watchkit.ts";
import { fakeCtx, readState, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const cfgWith = (quiet?: { from: string; to: string }) => ({ timezone: "Asia/Seoul", quiet_hours: quiet }) as never;

test("quiet hours include the start, exclude the end and wrap past midnight", () => {
	const day = cfgWith({ from: "00:00", to: "08:00" });
	expect(inQuietHours(day, new Date("2030-06-14T15:00:00Z"))).toBe(true);
	expect(inQuietHours(day, new Date("2030-06-14T22:59:00Z"))).toBe(true);
	expect(inQuietHours(day, new Date("2030-06-14T23:00:00Z"))).toBe(false);
	const night = cfgWith({ from: "22:00", to: "06:00" });
	expect(inQuietHours(night, new Date("2030-06-15T13:30:00Z"))).toBe(true);
	expect(inQuietHours(night, new Date("2030-06-15T12:00:00Z"))).toBe(false);
	expect(inQuietHours(cfgWith({ from: "08:00", to: "08:00" }), new Date("2030-06-15T00:00:00Z"))).toBe(false);
	expect(inQuietHours(cfgWith(), new Date("2030-06-15T00:00:00Z"))).toBe(false);
});

test("zone time helpers convert both ways", () => {
	expect(zonedToDate(2030, 6, 16, 18, 0, "Asia/Seoul").toISOString()).toBe("2030-06-16T09:00:00.000Z");
	expect(zonedToDate(2030, 3, 10, 9, 0, "America/New_York").toISOString()).toBe("2030-03-10T13:00:00.000Z");
	expect(zonedDay(new Date("2030-06-16T06:59:00Z"), "America/Los_Angeles")).toBe("2030-06-15");
	expect(oneLine("  a \n b\t c ", 3)).toBe("a b");
});

test("the runner retries a transient failure once after a sleep and a recovery inside the run resets the counter", async () => {
	const ctx = fakeCtx(env);
	let calls = 0;
	const res = await runWatch<{ n: number }>(ctx, {
		body: async (_cfg, prev) => {
			calls++;
			if (calls === 1) throw new TransientError();
			return { lines: ["x"], state: { n: (prev?.n ?? 0) + 1 } };
		},
	});
	expect(res).toEqual({ lines: ["x"], code: 0 });
	expect(calls).toBe(2);
	expect(ctx.sleeps).toHaveLength(1);
	expect(readState(env)).toEqual({ fails: 0, data: { n: 1 } });
});

test("skip leaves the state and the fail counter alone, and a failed run keeps the baseline", async () => {
	const ctx = fakeCtx(env);
	await runWatch<{ n: number }>(ctx, { body: async () => ({ lines: [], state: { n: 5 } }) });
	await runWatch<{ n: number }>(ctx, {
		body: async () => {
			throw new TransientError();
		},
	});
	expect(readState(env)).toEqual({ fails: 1, data: { n: 5 } });
	expect(await runWatch<{ n: number }>(ctx, { body: async () => "skip" })).toEqual({ lines: [], code: 0 });
	expect(readState(env).fails).toBe(1);
});

test("failure mapping covers auth, setup, network and unexpected errors", () => {
	expect(failFrom(new AuthError("youtube")).lines[0]).toBe("DOTZ_FAIL youtube-auth");
	expect(failFrom(new AuthError("instagram")).lines[0]).toBe("DOTZ_FAIL instagram-auth");
	expect(failFrom(new SetupError("nope")).lines).toEqual(["DOTZ_FAIL setup", "nope"]);
	expect(failFrom(new TransientError()).lines[0]).toBe("DOTZ_FAIL network");
	expect(failFrom(new Error("boom"))).toEqual({ lines: ["DOTZ_FAIL error", "boom"], code: 1 });
});
