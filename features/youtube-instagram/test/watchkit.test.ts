// watchkit: quiet hours across midnight, zone-time conversion, the runner's retry / counter / skip rules and failure mapping, and the shared watch rules per watch.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run as dueRun } from "../bin/due.ts";
import { run as igCommentsRun } from "../bin/ig-comments.ts";
import { run as inboxRun } from "../bin/inbox.ts";
import { run as tokensRun } from "../bin/tokens.ts";
import { run as ytCommentsRun } from "../bin/yt-comments.ts";
import { run as ytMetadataRun } from "../bin/yt-metadata.ts";
import { type InstagramSecret, paths, SetupError, writeJson } from "../lib/config.ts";
import { InnerTubeError } from "../lib/innertube.ts";
import { hooks as readHooks } from "../lib/yt-read.ts";
import { AuthError, failFrom, inQuietHours, oneLine, runWatch, TransientError, zonedDay, zonedToDate } from "../lib/watchkit.ts";
import { type FakeCtx, fakeCtx, IG, readState, setupEnv, type TestEnv, YT } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
	// yt-comments reads through the studio InnerTube first; off here, so only the fake fetch is in play.
	readHooks.read = async () => {
		throw new InnerTubeError("off");
	};
});
afterEach(() => {
	readHooks.read = undefined;
	env.cleanup();
});

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

// The rules every watch gets from runWatch, run through each watch that is tied to them (watch x case).
type Run = (ctx: FakeCtx, args: string[]) => Promise<{ lines: string[]; code: number }>;
const QUIET_NOW = "2030-06-15T16:00:00Z";

test.each([
	["due", dueRun],
	["inbox", inboxRun],
	["tokens", tokensRun],
	["yt-comments", ytCommentsRun],
	["yt-metadata", ytMetadataRun],
] as [string, Run][])("%s: missing config prints DOTZ_FAIL setup", async (_name, run) => {
	rmSync(paths.config());
	const res = await run(fakeCtx(env), []);
	expect(res.code).toBe(1);
	expect(res.lines[0]).toBe("DOTZ_FAIL setup");
});

// Each arm() returns a ctx whose next run fails transiently, after any baseline run the watch needs.
const REFRESH = "GET https://graph.instagram.com/refresh_access_token";
const MEDIA = `GET ${IG}/me/media`;
const PLAYLIST = `GET ${YT}/playlistItems`;
const igSecret = (): InstagramSecret => ({ access_token: "ig-token", user_id: "17841", username: "owner_ig", obtained_at: "2030-06-01T00:00:00.000Z", expires_at: "2030-07-31T00:00:00.000Z" });
const TRANSIENT: [string, Run, () => Promise<FakeCtx>][] = [
	["tokens", tokensRun, async () => {
		writeJson(paths.instagram(), igSecret(), true);
		return fakeCtx(env, { routes: { [REFRESH]: () => new Response("{}", { status: 503 }) } });
	}],
	["ig-comments", igCommentsRun, async () => {
		const ctx = fakeCtx(env, { routes: { [MEDIA]: () => ({ data: [{ id: "m1", comments_count: 1, timestamp: "2030-06-01T00:00:00+0000" }] }) } });
		await igCommentsRun(ctx, []);
		ctx.routes[MEDIA] = () => new Response("{}", { status: 500 });
		return ctx;
	}],
	["yt-metadata", ytMetadataRun, async () => {
		const ctx = fakeCtx(env);
		ctx.routes[PLAYLIST] = () => ({ items: [{ snippet: { title: "One", publishedAt: "2030-06-14T00:00:00Z", resourceId: { videoId: "v1" } } }] });
		ctx.routes[`GET ${YT}/videos`] = () => ({ items: [{ id: "v1", snippet: { title: "One", description: "", categoryId: "22" }, localizations: {} }] });
		await ytMetadataRun(ctx, []);
		ctx.routes[PLAYLIST] = () => new Response("down", { status: 429 });
		return ctx;
	}],
];

test.each(TRANSIENT)("%s: a transient failure is absorbed twice and reported on the 3rd failed run", async (_name, run, arm) => {
	const ctx = await arm();
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	const third = await run(ctx, []);
	expect(third.lines[0]).toBe("DOTZ_FAIL network");
	expect(third.code).toBe(1);
});

test.each([
	["ig-comments", igCommentsRun],
	["yt-comments", ytCommentsRun],
] as [string, Run][])("%s: quiet hours are silent and touch nothing", async (_name, run) => {
	const ctx = fakeCtx(env, { now: QUIET_NOW });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
	expect(existsSync(join(env.stateDir, "state.json"))).toBe(false);
});

test.each([
	["yt-metadata", ytMetadataRun, 8999],
	["yt-comments", ytCommentsRun, 9000],
] as [string, Run, number][])("%s: over the daily quota budget it is silent and makes no call", async (_name, run, units) => {
	writeJson(paths.quota(), { day: "2030-06-15", units });
	const ctx = fakeCtx(env);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
});

test("failure mapping covers auth, setup, network and unexpected errors", () => {
	expect(failFrom(new AuthError("youtube")).lines[0]).toBe("DOTZ_FAIL youtube-auth");
	expect(failFrom(new AuthError("instagram")).lines[0]).toBe("DOTZ_FAIL instagram-auth");
	expect(failFrom(new SetupError("nope")).lines).toEqual(["DOTZ_FAIL setup", "nope"]);
	expect(failFrom(new TransientError()).lines[0]).toBe("DOTZ_FAIL network");
	expect(failFrom(new Error("boom"))).toEqual({ lines: ["DOTZ_FAIL error", "boom"], code: 1 });
});
