// Reading the owner's past replies back (comment hub `history`): YouTube threads newest first with its page, target, deadline and failure bounds,
// and Instagram's paged media list. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mediaHistory } from "../lib/instagram.ts";
import { HISTORY_PAGES, ownerHistory } from "../lib/youtube.ts";
import { CHANNEL, calls, fakeCtx, IG, NOW, setupEnv, type TestEnv, YT } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const BASE = Date.parse(NOW);
const answered = (id: string, by = "UCfan") => ({
	snippet: { videoId: "v1", totalReplyCount: 1, topLevelComment: { id, snippet: { authorDisplayName: "fan", authorChannelId: { value: by }, textDisplay: `q ${id}`, publishedAt: "2030-06-10T00:00:00Z" } } },
	replies: { comments: [{ id: `${id}.r`, snippet: { parentId: id, authorDisplayName: "owner", authorChannelId: { value: CHANNEL }, textDisplay: `a ${id}`, publishedAt: "2030-06-11T00:00:00Z" } }] },
});
const open = (id: string) => ({ snippet: { videoId: "v1", topLevelComment: { id, snippet: { authorDisplayName: "fan", authorChannelId: { value: "UCfan" }, textDisplay: "q", publishedAt: "2030-06-10T00:00:00Z" } } } });
const page = (ids: string[], more: boolean) => ({ items: ids.map(id => answered(id)), ...(more ? { nextPageToken: "next" } : {}) });
const route = (h: (n: number) => unknown) => ({ [`GET ${YT}/commentThreads`]: (_c: unknown, n: number) => h(n) });

test("the threads the channel answered come back newest first with its replies; open threads and its own top comments are left out", async () => {
	const ctx = fakeCtx(env, { routes: route(() => ({ items: [answered("a"), open("b"), answered("c", CHANNEL)] })) });
	const out = await ownerHistory(ctx, CHANNEL, { target: 1000, deadline: BASE + 1e6 });
	expect(out.map(c => c.id)).toEqual(["a"]);
	expect(out[0]!.ownerReplies!.map(r => r.text)).toEqual(["a a"]);
	expect(calls(ctx, "/commentThreads")).toHaveLength(1);
});

test("paging stops as soon as the target of replies is reached", async () => {
	const ctx = fakeCtx(env, { routes: route(n => page([`p${n}a`, `p${n}b`], true)) });
	const out = await ownerHistory(ctx, CHANNEL, { target: 3, deadline: BASE + 1e6 });
	expect(calls(ctx, "/commentThreads")).toHaveLength(2);
	expect(out).toHaveLength(4);
});

test("never more than 30 pages, and the last page ends it", async () => {
	const endless = fakeCtx(env, { routes: route(n => page([`t${n}`], true)) });
	expect(await ownerHistory(endless, CHANNEL, { target: 1e6, deadline: BASE + 1e6 })).toHaveLength(HISTORY_PAGES);
	expect(calls(endless, "/commentThreads")).toHaveLength(30);
	const short = fakeCtx(env, { routes: route(n => page([`s${n}`], n < 2)) });
	expect(await ownerHistory(short, CHANNEL, { target: 1e6, deadline: BASE + 1e6 })).toHaveLength(3);
});

test("a deadline that has passed reads nothing; one that passes during a read keeps the rows so far", async () => {
	const past = fakeCtx(env, { routes: route(() => page(["x"], false)) });
	expect(await ownerHistory(past, CHANNEL, { target: 1000, deadline: BASE })).toEqual([]);
	expect(calls(past, "/commentThreads")).toHaveLength(0);
	let clock = BASE;
	const ctx = fakeCtx(env, { routes: route(n => ((clock = BASE + 10_000), page([`d${n}`], true))) });
	ctx.now = () => new Date(clock);
	const out = await ownerHistory(ctx, CHANNEL, { target: 1000, deadline: BASE + 5000 });
	expect(out.map(c => c.id)).toEqual(["d0"]);
	expect(calls(ctx, "/commentThreads")).toHaveLength(1);
});

test("a page that fails keeps the rows read so far; a read that got nothing throws; no threads at all is an empty list", async () => {
	const later = fakeCtx(env, { routes: route(n => (n === 0 ? page(["k"], true) : new Response("down", { status: 500 }))) });
	expect((await ownerHistory(later, CHANNEL, { target: 1000, deadline: BASE + 1e6 })).map(c => c.id)).toEqual(["k"]);
	const first = fakeCtx(env, { routes: route(() => new Response("down", { status: 500 })) });
	await expect(ownerHistory(first, CHANNEL, { target: 1000, deadline: BASE + 1e6 })).rejects.toThrow();
	const none = fakeCtx(env, { routes: route(() => ({ items: [] })) });
	expect(await ownerHistory(none, CHANNEL, { target: 1000, deadline: BASE + 1e6 })).toEqual([]);
});

test("mediaHistory pages the account's media newest first and stops at the cap", async () => {
	const media = (n: number) => ({ data: Array.from({ length: 50 }, (_, i) => ({ id: `m${n}-${i}`, comments_count: 1, timestamp: "2030-06-01T00:00:00+0000", media_type: "IMAGE", media_url: "https://x/i.jpg" })), paging: { next: "https://x/next", cursors: { after: `a${n}` } } });
	const ctx = fakeCtx(env, { routes: { [`GET ${IG}/me/media`]: (_c, n) => media(n) } });
	const out = await mediaHistory(ctx, 100);
	expect(out).toHaveLength(100);
	expect(out[0]).toMatchObject({ id: "m0-0", comments_count: 1, thumb: "https://x/i.jpg" });
	expect(calls(ctx, "/me/media")).toHaveLength(2);
	expect(new URL(calls(ctx, "/me/media")[1]!.url).searchParams.get("after")).toBe("a0");
});
