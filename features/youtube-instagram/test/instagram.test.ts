// instagram lib: account info, media and comment mapping, replies, Reels publishing with bounded polling, error mapping.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { commentsFor, InstagramError, me, mediaWithCounts, publishReel, refreshIfNeeded, reply } from "../lib/instagram.ts";
import { AuthError, TransientError } from "../lib/watchkit.ts";
import { fakeCtx, IG, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

test("me maps the account fields and honours an explicit token", async () => {
	const ctx = fakeCtx(env, { routes: { [`GET ${IG}/me`]: () => ({ user_id: "17841", username: "owner_ig", followers_count: 120, media_count: 9 }) } });
	expect(await me(ctx, "setup-token")).toEqual({ user_id: "17841", username: "owner_ig", followers: 120, media: 9 });
	expect(ctx.calls[0].headers.authorization).toBe("Bearer setup-token");
	expect(ctx.calls[0].url).not.toContain("setup-token");
});

test("mediaWithCounts and commentsFor map the Graph payloads", async () => {
	const ctx = fakeCtx(env, {
		routes: {
			[`GET ${IG}/me/media`]: () => ({ data: [{ id: "m1", caption: "c", timestamp: "2030-06-01T00:00:00+0000" }] }),
			[`GET ${IG}/m1/comments`]: () => ({ data: [{ id: "k1", text: "hi", username: "fan", timestamp: "2030-06-02T00:00:00+0000", replies: { data: [{ username: "owner_ig", text: "yo" }] } }, { id: "k2", username: "fan2", timestamp: "2030-06-03T00:00:00+0000" }] }),
		},
	});
	expect((await mediaWithCounts(ctx))[0]).toMatchObject({ id: "m1", comments_count: 0 });
	const comments = await commentsFor(ctx, "m1");
	expect(comments[0]).toEqual({ id: "k1", text: "hi", username: "fan", timestamp: "2030-06-02T00:00:00+0000", replies: [{ username: "owner_ig", text: "yo" }] });
	expect(comments[1]).toMatchObject({ text: "", replies: [] });
	expect(new URL(ctx.calls[1].url).searchParams.get("fields")).toContain("replies{username,text}");
});

test("reply posts the message in the body, not the URL", async () => {
	const ctx = fakeCtx(env, { routes: { [`POST ${IG}/k1/replies`]: () => ({ id: "ir1" }) } });
	expect(await reply(ctx, "k1", "감사해요")).toBe("ir1");
	expect(new URLSearchParams(ctx.calls[0].body).get("message")).toBe("감사해요");
	expect(ctx.calls[0].url).not.toContain("message");
});

function reelRoutes(statuses: string[]) {
	return {
		[`POST ${IG}/me/media`]: () => ({ id: "cont1" }),
		[`GET ${IG}/cont1`]: (_c: unknown, n: number) => ({ status_code: statuses[Math.min(n, statuses.length - 1)] }),
		[`POST ${IG}/me/media_publish`]: () => ({ id: "media9" }),
	};
}

test("publishReel polls the container with the injected sleep until FINISHED, then publishes", async () => {
	const ctx = fakeCtx(env, { routes: reelRoutes(["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]) });
	expect(await publishReel(ctx, "https://x.trycloudflare.com/a.mp4", "cap")).toBe("media9");
	expect(ctx.sleeps).toEqual([5000, 5000]);
	expect(new URLSearchParams(ctx.calls[0].body).get("video_url")).toBe("https://x.trycloudflare.com/a.mp4");
	expect(new URLSearchParams(ctx.calls.at(-1)?.body).get("creation_id")).toBe("cont1");
});

test("publishReel gives up on ERROR and after a bounded number of polls without publishing", async () => {
	const failed = fakeCtx(env, { routes: reelRoutes(["ERROR"]) });
	await expect(publishReel(failed, "https://x/a.mp4", "c")).rejects.toThrow(/container ERROR/);
	const stuck = fakeCtx(env, { routes: reelRoutes(["IN_PROGRESS"]) });
	await expect(publishReel(stuck, "https://x/a.mp4", "c")).rejects.toBeInstanceOf(InstagramError);
	expect(stuck.sleeps).toHaveLength(29);
	expect(stuck.calls.some(c => c.url.includes("media_publish"))).toBe(false);
});

test("error mapping: 190 and 401 are AuthError, 5xx and rate limits transient, the rest InstagramError", async () => {
	const key = `GET ${IG}/me/media`;
	const go = (res: Response | (() => never)) => mediaWithCounts(fakeCtx(env, { routes: { [key]: () => (typeof res === "function" ? res() : res) } })).catch(e => e);
	expect(await go(Response.json({ error: { code: 190 } }, { status: 400 }))).toBeInstanceOf(AuthError);
	expect(await go(new Response("{}", { status: 401 }))).toBeInstanceOf(AuthError);
	expect(await go(new Response("{}", { status: 503 }))).toBeInstanceOf(TransientError);
	expect(await go(Response.json({ error: { code: 4 } }, { status: 400 }))).toBeInstanceOf(TransientError);
	expect(await go(Response.json({ error: { code: 100, type: "GraphMethodException" } }, { status: 400 }))).toBeInstanceOf(InstagramError);
	expect(
		await go(() => {
			throw new TypeError("offline");
		}),
	).toBeInstanceOf(TransientError);
});

test("refreshIfNeeded leaves a fresh token alone", async () => {
	const ctx = fakeCtx(env);
	expect(await refreshIfNeeded(ctx)).toEqual({ refreshed: false });
	expect(ctx.calls).toHaveLength(0);
});
