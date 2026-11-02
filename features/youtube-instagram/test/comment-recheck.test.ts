// Re-reading comments the owner may have answered later: YouTube threads by id (owner reply, more than 5 replies, deleted thread),
// the answered option of commentThreadsSince, Instagram paging of comments and the single-object author lookup. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { commentsRead, replyAuthor } from "../lib/instagram.ts";
import { commentThreadsSince, threadsByIds } from "../lib/youtube.ts";
import { CHANNEL, calls, fakeCtx, IG, setupEnv, type TestEnv, YT, ytThread } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const reply = (id: string, parent: string, by: string, text: string, at: string) => ({ id, snippet: { parentId: parent, authorDisplayName: by, authorChannelId: { value: by === "owner" ? CHANNEL : "UCfan" }, textDisplay: text, publishedAt: at } });
const thread = (id: string, replies: ReturnType<typeof reply>[], total = replies.length) => ({
	snippet: { videoId: "v1", totalReplyCount: total, topLevelComment: { id, snippet: { authorDisplayName: "fan", authorChannelId: { value: "UCfan" }, textDisplay: "q", publishedAt: "2030-06-10T00:00:00Z" } } },
	replies: replies.length ? { comments: replies } : undefined,
});

test("threadsByIds returns the owner's replies of the threads still there and leaves a deleted thread out, in one call of 1 unit", async () => {
	const ctx = fakeCtx(env, {
		routes: { [`GET ${YT}/commentThreads`]: () => ({ items: [thread("a", [reply("a.1", "a", "fan", "me too", "2030-06-11T00:00:00Z"), reply("a.2", "a", "owner", "답했어요", "2030-06-11T01:00:00Z")]), thread("b", [])] }) },
	});
	const out = await threadsByIds(ctx, CHANNEL, ["a", "b", "deleted"]);
	expect(Object.keys(out).sort()).toEqual(["a", "b"]);
	expect(out.a).toEqual({ videoId: "v1", replies: [{ id: "a.2", parentId: "a", author: "owner", text: "답했어요", publishedAt: "2030-06-11T01:00:00Z" }] });
	expect(out.b!.replies).toEqual([]);
	expect(calls(ctx, "/commentThreads")).toHaveLength(1);
	expect(new URL(ctx.calls.at(-1)!.url).searchParams.get("id")).toBe("a,b,deleted");
});

test("a thread with more replies than the call returned is read through comments.list and its pages", async () => {
	const five = ["1", "2", "3", "4", "5"].map(n => reply(`a.${n}`, "a", "fan", `r${n}`, "2030-06-11T00:00:00Z"));
	const ctx = fakeCtx(env, {
		routes: {
			[`GET ${YT}/commentThreads`]: () => ({ items: [thread("a", five, 8)] }),
			[`GET ${YT}/comments`]: (_c, n) => (n === 0 ? { items: five, nextPageToken: "p2" } : { items: [reply("a.6", "a", "fan", "r6", "2030-06-12T00:00:00Z"), reply("a.7", "a", "owner", "늦은 답", "2030-06-13T00:00:00Z")] }),
		},
	});
	const out = await threadsByIds(ctx, CHANNEL, ["a"]);
	expect(out.a!.replies.map(r => r.id)).toEqual(["a.7"]);
	const pages = calls(ctx, "/comments?");
	expect(pages).toHaveLength(2);
	expect(new URL(pages[0]!.url).searchParams.get("parentId")).toBe("a");
	expect(new URL(pages[1]!.url).searchParams.get("pageToken")).toBe("p2");
});

test("commentThreadsSince lists an answered thread with the owner's replies only when asked to", async () => {
	const since = "2030-06-01T00:00:00Z";
	const routes = { [`GET ${YT}/commentThreads`]: () => ({ items: [{ ...thread("a", [reply("a.1", "a", "owner", "answer", "2030-06-11T01:00:00Z")]), id: "a" }] }) };
	expect((await commentThreadsSince(fakeCtx(env, { routes }), CHANNEL, since)).comments).toEqual([]);
	const asked = (await commentThreadsSince(fakeCtx(env, { routes }), CHANNEL, since, 3, true)).comments;
	expect(asked.map(c => c.id)).toEqual(["a"]);
	expect(asked[0]!.ownerReplies!.map(r => r.id)).toEqual(["a.1"]);
	const plain = fakeCtx(env, { routes: { [`GET ${YT}/commentThreads`]: () => ({ items: [ytThread("p", "P", "UCp", "t", "2030-06-11T00:00:00Z")] }) } });
	expect((await commentThreadsSince(plain, CHANNEL, since, 3, true)).comments[0]!.ownerReplies).toBeUndefined();
});

test("commentsRead follows the pages by their after cursor and says when it stopped early", async () => {
	const page = (ids: string[], after?: string) => ({ data: ids.map(id => ({ id, text: id, username: "u", timestamp: "2030-06-02T00:00:00+0000" })), ...(after ? { paging: { next: "https://x/next", cursors: { after } } } : {}) });
	const ctx = fakeCtx(env, { routes: { [`GET ${IG}/m1/comments`]: (_c, n) => (n === 0 ? page(["k1", "k2"], "c1") : page(["k3"])) } });
	const r = await commentsRead(ctx, "m1");
	expect(r.comments.map(c => c.id)).toEqual(["k1", "k2", "k3"]);
	expect(r.complete).toBe(true);
	expect(new URL(ctx.calls[1]!.url).searchParams.get("after")).toBe("c1");
	expect(ctx.calls.every(c => !c.url.includes("ig-token"))).toBe(true);

	const endless = fakeCtx(env, { routes: { [`GET ${IG}/m1/comments`]: () => page(["k1"], "more") } });
	const cut = await commentsRead(endless, "m1");
	expect(cut.complete).toBe(false);
	expect(calls(endless, "/m1/comments")).toHaveLength(10);
});

test("a comment with more replies than the nested list holds gets them from its replies edge", async () => {
	const ctx = fakeCtx(env, {
		routes: {
			[`GET ${IG}/m1/comments`]: () => ({ data: [{ id: "k1", text: "q", username: "fan", timestamp: "2030-06-02T00:00:00+0000", replies: { data: [{ id: "r1", text: "a" }], paging: { next: "https://x/n", cursors: { after: "z" } } } }] }),
			[`GET ${IG}/k1/replies`]: () => ({ data: [{ id: "r1", text: "a" }, { id: "r2", text: "b" }] }),
		},
	});
	const r = await commentsRead(ctx, "m1");
	expect(r.comments[0]!.replies.map(x => x.id)).toEqual(["r1", "r2"]);
});

test("replyAuthor asks for username and from on the single reply and returns both", async () => {
	const ctx = fakeCtx(env, { routes: { [`GET ${IG}/r1`]: () => ({ id: "r1", username: "owner_ig", from: { id: "17841", username: "owner_ig" } }) } });
	expect(await replyAuthor(ctx, "r1")).toEqual({ username: "owner_ig", fromId: "17841" });
	expect(new URL(ctx.calls[0]!.url).searchParams.get("fields")).toBe("username,from");
	const onlyFrom = fakeCtx(env, { routes: { [`GET ${IG}/r2`]: () => ({ from: { id: "9", username: "viaFrom" } }) } });
	expect(await replyAuthor(onlyFrom, "r2")).toEqual({ username: "viaFrom", fromId: "9" });
});
