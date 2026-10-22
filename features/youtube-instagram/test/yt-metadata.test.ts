// yt-metadata watch: recent uploads missing a configured language, reported once each; first run is a baseline; failure,
// auth, quota and setup paths. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { run } from "../bin/yt-metadata.ts";
import { paths, writeJson } from "../lib/config.ts";
import { calls, fakeCtx, readState, setupEnv, type TestEnv, YT } from "./helpers.ts";

const PLAYLIST = `GET ${YT}/playlistItems`;
const VIDEOS = `GET ${YT}/videos`;
let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const item = (id: string, title: string) => ({ snippet: { title, publishedAt: "2030-06-14T00:00:00Z", resourceId: { videoId: id } } });
const video = (id: string, title: string, langs: string[]) => ({ id, snippet: { title, description: "", categoryId: "22" }, localizations: Object.fromEntries(langs.map(l => [l, { title, description: "" }])) });
const serve = (ctx: ReturnType<typeof fakeCtx>, vids: ReturnType<typeof video>[]) => {
	ctx.routes[PLAYLIST] = () => ({ items: vids.map(v => item(v.id, v.snippet.title)) });
	ctx.routes[VIDEOS] = () => ({ items: vids });
};

test("first run records the recent videos and prints nothing", async () => {
	const ctx = fakeCtx(env);
	serve(ctx, [video("v1", "One", [])]);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(readState(env).data.seen).toEqual(["v1"]);
	expect(new URL(ctx.calls[0].url).searchParams.get("playlistId")).toBe("UU0123456789abcdef");
});

test("opt-in: with no target languages it stays silent and makes no call at all", async () => {
	env.cleanup();
	env = setupEnv(c => {
		c.youtube!.languages = [];
	});
	const ctx = fakeCtx(env);
	serve(ctx, [video("v1", "One", [])]);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
});

test("second run reports each new video with missing languages once", async () => {
	const ctx = fakeCtx(env);
	serve(ctx, [video("v1", "One", [])]);
	await run(ctx, []);
	serve(ctx, [video("v3", "Three", ["en", "ja"]), video("v2", "Title 2", ["en"]), video("v1", "One", [])]);
	expect(await run(ctx, [])).toEqual({ lines: ["needs-translation v2 missing=ja: Title 2"], code: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(calls(ctx, "/videos?").length).toBeGreaterThan(0);
});

test("a transient failure is absorbed twice and reported on the 3rd failed run", async () => {
	const ctx = fakeCtx(env);
	serve(ctx, [video("v1", "One", [])]);
	await run(ctx, []);
	ctx.routes[PLAYLIST] = () => new Response("down", { status: 429 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect((await run(ctx, [])).lines[0]).toBe("DOTZ_FAIL network");
});

test("a rejected login prints DOTZ_FAIL youtube-auth", async () => {
	const ctx = fakeCtx(env, { routes: { [PLAYLIST]: () => new Response("{}", { status: 401 }) } });
	const res = await run(ctx, []);
	expect(res.code).toBe(1);
	expect(res.lines[0]).toBe("DOTZ_FAIL youtube-auth");
});

test("over the daily quota budget it is silent and makes no call", async () => {
	writeJson(paths.quota(), { day: "2030-06-15", units: 8999 });
	const ctx = fakeCtx(env);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
});

test("a 403 quotaExceeded prints one notice for the Pacific day and then stays silent without a call", async () => {
	const ctx = fakeCtx(env, { routes: { [PLAYLIST]: () => Response.json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }) } });
	expect(await run(ctx, [])).toEqual({ lines: ["yt-quota-exhausted until=16:00"], code: 0 });
	const before = ctx.calls.length;
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(before);
});

test("missing config prints DOTZ_FAIL setup", async () => {
	rmSync(paths.config());
	expect((await run(fakeCtx(env), [])).lines[0]).toBe("DOTZ_FAIL setup");
});
