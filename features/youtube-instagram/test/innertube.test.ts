// InnerTube comment reader: feed, watch page and /next parsing on fixtures, the per-scope seen ids, the Data API fallback and the
// watch line with the video title. Fake fetch only, no network and no real channel.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { run as watch } from "../bin/yt-comments.ts";
import { InnerTubeError, innertubeComments, newestToken, parseComments, parseFeed, parseWatchPage } from "../lib/innertube.ts";
import { readCommentsSince } from "../lib/yt-read.ts";
import { CHANNEL, type FakeCtx, fakeCtx, NOW, readState, setupEnv, type TestEnv, YT, ytThread } from "./helpers.ts";

const FEED = `<feed><entry><yt:videoId>vid00000001</yt:videoId><title>First &amp; best</title></entry><entry><yt:videoId>vid00000002</yt:videoId><title>Second</title></entry></feed>`;
const page = (token: string, ids = `"INNERTUBE_API_KEY":"KEY123","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20300101.00.00"`) =>
	`<html><script>var ytcfg={${ids}}</script><script>var ytInitialData = {"contents":{"a":{"itemSectionRenderer":{"sectionIdentifier":"comment-item-section","contents":[{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"${token}"}}}}]}}},"text":"} tricky {"};</script></html>`;
const headerFor = (v: string) => ({ onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [{ commentsHeaderRenderer: { sortMenu: { sortFilterSubMenuRenderer: { subMenuItems: [{ title: "Top comments", serviceEndpoint: { continuationCommand: { token: "top" } } }, { title: "Newest first", serviceEndpoint: { continuationCommand: { token: `newest-${v}` } } }] } } } }] } }] });
const entity = (id: string, by: string, byChannel: string, text: string, when: string, o: { level?: number; replies?: string } = {}) => ({
	payload: { commentEntityPayload: { properties: { commentId: id, content: { content: text }, publishedTime: when, replyLevel: o.level ?? 0 }, author: { displayName: `@${by}`, channelId: byChannel }, toolbar: { replyCount: o.replies ?? "" } } },
});
const newest = (...m: ReturnType<typeof entity>[]) => ({ frameworkUpdates: { entityBatchUpdate: { mutations: m } } });

let env: TestEnv;
let comments: Record<string, ReturnType<typeof newest>>;
beforeEach(() => {
	env = setupEnv();
	comments = {
		vid00000001: newest(entity("c1", "fan", "UCfan", "hello", "3 minutes ago"), entity("c1r", "owner", CHANNEL, "thanks", "1 minute ago", { level: 1 })),
		vid00000002: newest(entity("c2", "other", "UCother", "nice", "2 hours ago"), entity("c3", "me", CHANNEL, "pinned", "1 day ago"), entity("c4", "chatty", "UCchat", "hi", "5 hours ago", { replies: "2" })),
	};
});
afterEach(() => env.cleanup());

function serve(ctx: FakeCtx, o: { broken?: boolean } = {}) {
	ctx.routes["GET https://www.youtube.com/feeds/videos.xml"] = () => new Response(FEED);
	ctx.routes["GET https://www.youtube.com/watch"] = call => (o.broken ? new Response("no", { status: 500 }) : new Response(page(`t-${new URL(call.url).searchParams.get("v")}`)));
	ctx.routes["POST https://www.youtube.com/youtubei/v1/next"] = call => {
		const token = JSON.parse(call.body).continuation as string;
		return token.startsWith("t-") ? headerFor(token.slice(2)) : comments[token.slice("newest-".length)];
	};
}
test("the feed gives ids and decoded titles", () => {
	expect(parseFeed(FEED)).toEqual([{ id: "vid00000001", title: "First & best" }, { id: "vid00000002", title: "Second" }]);
});

test("the watch page gives the key, the client version (either name) and the comments continuation, braces in strings included", () => {
	expect(parseWatchPage(page("tok"))).toEqual({ key: "KEY123", version: "2.20300101.00.00", token: "tok" });
	expect(parseWatchPage(page("tok", `"INNERTUBE_API_KEY":"K2","INNERTUBE_CLIENT_VERSION":"2.1"`))).toMatchObject({ key: "K2", version: "2.1" });
	expect(() => parseWatchPage("<html>nothing</html>")).toThrow(InnerTubeError);
	expect(() => parseWatchPage(`<script>var ytcfg={"INNERTUBE_API_KEY":"K","INNERTUBE_CLIENT_VERSION":"2.1"}</script><script>var ytInitialData = {"a":1};</script>`)).toThrow("comments continuation");
});

test("the newest-first entry of the sort menu is picked, and top-level comments are parsed with estimated times", () => {
	expect(newestToken(headerFor("x"))).toBe("newest-x");
	const now = new Date(NOW);
	const got = parseComments(comments.vid00000001, { id: "vid00000001", title: "First" }, now);
	expect(got).toEqual([{ id: "c1", videoId: "vid00000001", videoTitle: "First", author: "fan", authorChannelId: "UCfan", text: "hello", publishedAt: new Date(now.getTime() - 3 * 60_000).toISOString(), replyCount: 0 }]);
});

test("innertubeComments reads the newest videos through feed, watch page and two next calls each, without any Data API call", async () => {
	const ctx = fakeCtx(env);
	serve(ctx);
	const out = await innertubeComments(ctx, CHANNEL);
	expect(out.map(c => c.id).sort()).toEqual(["c1", "c2", "c3", "c4"]);
	expect(ctx.calls.some(c => c.url.includes("googleapis.com"))).toBe(false);
	expect(JSON.parse(ctx.calls.find(c => c.url.includes("/next"))!.body)).toMatchObject({ context: { client: { clientName: "WEB", clientVersion: "2.20300101.00.00" } } });
});

test("the first read of a scope records and reports nothing; later reads give only unseen comments of others without replies", async () => {
	const ctx = fakeCtx(env);
	serve(ctx);
	const read = (since?: string) => readCommentsSince(ctx, CHANNEL, since, 3, { scope: "watch", allowApi: false });
	expect((await read(undefined))!.comments).toEqual([]);
	expect((await read(NOW))!.comments).toEqual([]);
	comments.vid00000002 = newest(entity("c5", "newbie", "UCnew", "question?", "1 minute ago"), entity("c6", "me", CHANNEL, "own", "1 minute ago"), entity("c7", "busy", "UCbusy", "answered", "2 minutes ago", { replies: "1" }), entity("c2", "other", "UCother", "nice", "2 hours ago"));
	const got = await read(NOW);
	expect(got!.comments.map(c => [c.id, c.videoTitle, c.author])).toEqual([["c5", "Second", "newbie"]]);
	expect((await read(NOW))!.comments).toEqual([]);
	expect((await readCommentsSince(ctx, CHANNEL, NOW, 3, { scope: "app", allowApi: false }))!.comments).toEqual([]);
	expect(ctx.calls.some(c => c.url.includes("googleapis.com"))).toBe(false);
});

test("when InnerTube fails the Data API answers if it may, and nothing is read if it may not", async () => {
	const ctx = fakeCtx(env);
	serve(ctx, { broken: true });
	ctx.routes[`GET ${YT}/commentThreads`] = () => ({ items: [ytThread("a1", "Fan", "UCfan", "api hello", "2030-06-15T11:00:00.000Z")] });
	const since = "2030-06-15T10:00:00.000Z";
	expect(await readCommentsSince(ctx, CHANNEL, since, 3, { scope: "watch", allowApi: false })).toBeUndefined();
	expect(ctx.calls.some(c => c.url.includes("googleapis.com"))).toBe(false);
	const r = await readCommentsSince(ctx, CHANNEL, since, 3, { scope: "watch", allowApi: true });
	expect(r!.comments.map(c => c.id)).toEqual(["a1"]);
});

test("the watch prints the video title from InnerTube without asking the Data API, and the first run prints nothing", async () => {
	const ctx = fakeCtx(env);
	serve(ctx);
	expect((await watch(ctx, [])).lines).toEqual([]);
	expect(readState(env).data.since).toBe(NOW);
	comments.vid00000002 = newest(entity("c2", "other", "UCother", "nice", "2 hours ago"), entity("c9", "Kim", "UCkim", "great video", "1 minute ago"));
	const ctx2 = fakeCtx(env);
	serve(ctx2);
	const res = await watch(ctx2, []);
	expect(res.lines).toEqual([`yt-comment c9 video=vid00000002 title="Second" by=Kim: great video`]);
	expect(ctx2.calls.some(c => c.url.includes("googleapis.com"))).toBe(false);
});
