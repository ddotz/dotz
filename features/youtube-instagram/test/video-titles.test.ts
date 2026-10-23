// Video titles of the comments: ONE videos.list call per batch of ids, a cache by id (a title for 7 days, a missing video for 1 day), an answer
// from the cache when the call fails, and the title on the yt-comment watch line. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { run } from "../bin/yt-comments.ts";
import { paths, readJson } from "../lib/config.ts";
import { videoInfos } from "../lib/youtube.ts";
import { calls, fakeCtx, setupEnv, type TestEnv, YT, ytThread } from "./helpers.ts";

const VIDEOS = `GET ${YT}/videos`;
let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const item = (id: string, title: string) => ({ id, snippet: { title, thumbnails: { medium: { url: `https://img.example/${id}.jpg` } } } });

test("videoInfos asks for all new ids in one call, then answers from the cache without a call", async () => {
	const ctx = fakeCtx(env, { routes: { [VIDEOS]: () => ({ items: [item("a", "첫 영상"), item("b", "둘째 영상")] }) } });
	const first = await videoInfos(ctx, ["a", "b", "a", "gone"]);
	expect(first).toEqual({ a: { title: "첫 영상", thumb: "https://img.example/a.jpg" }, b: { title: "둘째 영상", thumb: "https://img.example/b.jpg" } });
	expect(calls(ctx, "/videos")).toHaveLength(1);
	const q = new URL(ctx.calls[0].url).searchParams;
	expect(q.get("part")).toBe("snippet");
	expect(q.get("id")).toBe("a,b,gone");

	expect(await videoInfos(ctx, ["a", "b", "gone"])).toEqual(first);
	expect(calls(ctx, "/videos")).toHaveLength(1);
	expect(Object.keys(readJson<Record<string, unknown>>(paths.videos()) ?? {}).sort()).toEqual(["a", "b", "gone"]);
});

test("videoInfos splits 120 ids into batches of 50 and asks again only after the cache is stale", async () => {
	const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
	const ctx = fakeCtx(env, { routes: { [VIDEOS]: c => ({ items: new URL(c.url).searchParams.get("id")!.split(",").map(id => item(id, `t-${id}`)) }) } });
	expect(Object.keys(await videoInfos(ctx, ids))).toHaveLength(120);
	expect(calls(ctx, "/videos").map(c => new URL(c.url).searchParams.get("id")!.split(",").length)).toEqual([50, 50, 20]);

	const week = fakeCtx(env, { now: "2030-06-23T12:00:00.000Z", routes: ctx.routes });
	await videoInfos(week, ["v0", "v1"]);
	expect(calls(week, "/videos")).toHaveLength(1);
});

test("a failing videos call never fails the caller: the cache answers and unknown ids are left out", async () => {
	const ok = fakeCtx(env, { routes: { [VIDEOS]: () => ({ items: [item("a", "첫 영상")] }) } });
	await videoInfos(ok, ["a"]);
	const down = fakeCtx(env, { now: "2030-06-23T12:00:00.000Z", routes: { [VIDEOS]: () => new Response("{}", { status: 500 }) } });
	expect(await videoInfos(down, ["a", "never"])).toEqual({ a: { title: "첫 영상", thumb: "https://img.example/a.jpg" } });
});

test("the yt-comment watch line carries the video title", async () => {
	const t = (id: string, at: string, videoId: string) => ytThread(id, "Bob", "UCbob", "hi", at, { videoId });
	const ctx = fakeCtx(env, { routes: { [`GET ${YT}/commentThreads`]: () => ({ items: [t("c1", "2030-06-15T10:00:00Z", "v1")] }) } });
	await run(ctx, []);
	ctx.routes[`GET ${YT}/commentThreads`] = () => ({ items: [t("c3", "2030-06-15T11:30:00Z", "v2"), t("c2", "2030-06-15T11:00:00Z", "v1"), t("c1", "2030-06-15T10:00:00Z", "v1")] });
	ctx.routes[VIDEOS] = () => ({ items: [item("v1", "첫 영상"), item("v2", "둘째 \"영상\"")] });
	const r = await run(ctx, []);
	expect(r.lines).toEqual([`yt-comment c2 video=v1 title="첫 영상" by=Bob: hi`, `yt-comment c3 video=v2 title="둘째 \\"영상\\"" by=Bob: hi`]);
	expect(calls(ctx, "/videos")).toHaveLength(1);
});
