// yt-comments watch: baseline on the first run, only new unreplied comments afterwards, failure absorption, auth, quiet hours,
// quota and setup failures. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../bin/yt-comments.ts";
import { paths, writeJson } from "../lib/config.ts";
import { CHANNEL, fakeCtx, readState, setupEnv, type TestEnv, ytThread, YT } from "./helpers.ts";

const KEY = `GET ${YT}/commentThreads`;
let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const old = ytThread("c1", "Ann", "UCann", "old", "2030-06-15T10:00:00Z");
const page = [
	ytThread("c5", "Dee", "UCdee", "already answered", "2030-06-15T11:50:00Z", { replyBy: CHANNEL }),
	ytThread("c4", "Me", CHANNEL, "my own comment", "2030-06-15T11:40:00Z"),
	ytThread("c3", "Cy", "UCcy", "multi\nline  text", "2030-06-15T11:30:00Z"),
	ytThread("c2", "Bob", "UCbob", "hi", "2030-06-15T11:00:00Z"),
	old,
];

test("first run records the newest comment time and prints nothing", async () => {
	const ctx = fakeCtx(env, { routes: { [KEY]: () => ({ items: [old] }) } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(readState(env).data.since).toBe("2030-06-15T10:00:00Z");
	expect(ctx.calls).toHaveLength(1);
	expect(ctx.calls[0].headers.authorization).toBe("Bearer yt-access");
});

test("second run prints only new comments without an owner reply, once", async () => {
	const ctx = fakeCtx(env, { routes: { [KEY]: () => ({ items: [old] }) } });
	await run(ctx, []);
	ctx.routes[KEY] = () => ({ items: page });
	expect(await run(ctx, [])).toEqual({ lines: ["yt-comment c2 video=v1 by=Bob: hi", "yt-comment c3 video=v1 by=Cy: multi line text"], code: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	const url = new URL(ctx.calls.at(-1)?.url ?? "");
	expect(url.searchParams.get("allThreadsRelatedToChannelId")).toBe(CHANNEL);
	expect(url.searchParams.get("order")).toBe("time");
	expect(url.searchParams.get("maxResults")).toBe("100");
});

test("comment text is cut at 200 characters", async () => {
	const ctx = fakeCtx(env, { routes: { [KEY]: () => ({ items: [old] }) } });
	await run(ctx, []);
	ctx.routes[KEY] = () => ({ items: [ytThread("c9", "Long", "UClong", "x".repeat(300), "2030-06-15T11:00:00Z"), old] });
	const res = await run(ctx, []);
	expect(res.lines[0]).toBe(`yt-comment c9 video=v1 by=Long: ${"x".repeat(200)}`);
});

test("a transient failure is absorbed twice, reported on the 3rd failed run, and a success resets it", async () => {
	const ctx = fakeCtx(env, { routes: { [KEY]: () => ({ items: [old] }) } });
	await run(ctx, []);
	ctx.routes[KEY] = () => new Response("down", { status: 503 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.sleeps).toHaveLength(1);
	expect(readState(env).fails).toBe(1);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	const third = await run(ctx, []);
	expect(third.code).toBe(1);
	expect(third.lines[0]).toBe("DOTZ_FAIL network");
	ctx.routes[KEY] = () => ({ items: [old] });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(readState(env).fails).toBe(0);
});

test("a network error counts as transient", async () => {
	const ctx = fakeCtx(env, { routes: { [KEY]: () => ({ items: [old] }) } });
	await run(ctx, []);
	ctx.routes[KEY] = () => {
		throw new TypeError("fetch failed");
	};
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(readState(env).fails).toBe(1);
});

test("a rejected login prints DOTZ_FAIL youtube-auth at once", async () => {
	const ctx = fakeCtx(env, { routes: { [KEY]: () => new Response("{}", { status: 401 }) } });
	const res = await run(ctx, []);
	expect(res.code).toBe(1);
	expect(res.lines[0]).toBe("DOTZ_FAIL youtube-auth");
});

test("quiet hours are silent and touch nothing", async () => {
	const ctx = fakeCtx(env, { now: "2030-06-15T16:00:00Z", routes: { [KEY]: () => ({ items: page }) } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
	expect(existsSync(join(env.stateDir, "state.json"))).toBe(false);
});

test("over the daily quota budget it is silent and makes no call", async () => {
	writeJson(paths.quota(), { day: "2030-06-15", units: 9000 });
	const ctx = fakeCtx(env, { routes: { [KEY]: () => ({ items: page }) } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
});

test("missing config prints DOTZ_FAIL setup", async () => {
	rmSync(paths.config());
	const res = await run(fakeCtx(env), []);
	expect(res.code).toBe(1);
	expect(res.lines[0]).toBe("DOTZ_FAIL setup");
});

test("without a watch state folder it fails with setup", async () => {
	const res = await run(fakeCtx(env, { noState: true }), []);
	expect(res.lines[0]).toBe("DOTZ_FAIL setup");
});
