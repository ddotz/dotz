// youtube lib: token refresh and cache, error mapping, comment paging, upload, metadata update with a one-time backup,
// restore and reply, all booked in the quota ledger. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths, readJson, SetupError, writeJson } from "../lib/config.ts";
import { AuthError, TransientError } from "../lib/watchkit.ts";
import { accessToken, channelStats, commentThreadsSince, insertVideo, myChannel, replyToComment, restoreVideo, updateVideo, YoutubeError, type YtVideo } from "../lib/youtube.ts";
import { CHANNEL, calls, fakeCtx, setupEnv, type TestEnv, TOKEN_URL, YT, ytThread } from "./helpers.ts";

const TOKEN = `POST ${TOKEN_URL}`;
let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const units = () => readJson<{ units: number }>(paths.quota())?.units;

test("accessToken refreshes with a form body, caches until 60 s before expiry and reuses the cache", async () => {
	rmSync(paths.ytAccess());
	const ctx = fakeCtx(env, { routes: { [TOKEN]: () => ({ access_token: "fresh", expires_in: 3600 }) } });
	expect(await accessToken(ctx)).toBe("fresh");
	expect(await accessToken(ctx)).toBe("fresh");
	expect(ctx.calls).toHaveLength(1);
	expect(ctx.calls[0].url).toBe(TOKEN_URL);
	expect(ctx.calls[0].headers.authorization).toBeUndefined();
	expect(readJson<{ expires_at: string }>(paths.ytAccess())?.expires_at).toBe("2030-06-15T13:00:00.000Z");
	writeJson(paths.ytAccess(), { access_token: "soon", expires_at: "2030-06-15T12:00:30.000Z" }, true);
	expect(await accessToken(ctx)).toBe("fresh");
	expect(ctx.calls).toHaveLength(2);
	writeJson(paths.ytAccess(), { access_token: "valid", expires_at: "2030-06-15T12:02:00.000Z" }, true);
	expect(await accessToken(ctx)).toBe("valid");
	expect(ctx.calls).toHaveLength(2);
});

test("token errors map to AuthError, TransientError and SetupError", async () => {
	rmSync(paths.ytAccess());
	const bad = fakeCtx(env, { routes: { [TOKEN]: () => Response.json({ error: "invalid_grant" }, { status: 400 }) } });
	await expect(accessToken(bad)).rejects.toBeInstanceOf(AuthError);
	const down = fakeCtx(env, { routes: { [TOKEN]: () => new Response("x", { status: 500 }) } });
	await expect(accessToken(down)).rejects.toBeInstanceOf(TransientError);
	const offline = fakeCtx(env, {
		routes: {
			[TOKEN]: () => {
				throw new TypeError("offline");
			},
		},
	});
	await expect(accessToken(offline)).rejects.toBeInstanceOf(TransientError);
	rmSync(paths.ytOauth());
	await expect(accessToken(fakeCtx(env))).rejects.toBeInstanceOf(SetupError);
});

test("a 401 from the API is AuthError and the error message holds no secret", async () => {
	const ctx = fakeCtx(env, { routes: { [`GET ${YT}/channels`]: () => new Response("{}", { status: 401 }) } });
	const e = await myChannel(ctx).catch(x => x);
	expect(e).toBeInstanceOf(AuthError);
	expect(String(e.message)).not.toContain("yt-access");
	const forbidden = fakeCtx(env, { routes: { [`GET ${YT}/channels`]: () => Response.json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }) } });
	await expect(myChannel(forbidden)).rejects.toThrow(new YoutubeError(403, "quotaExceeded").message);
});

test("myChannel uses the given token and channelStats parses the counters; both book 1 unit", async () => {
	const ctx = fakeCtx(env, {
		routes: {
			[`GET ${YT}/channels`]: c => {
				const q = new URL(c.url).searchParams;
				return q.get("mine") ? { items: [{ id: CHANNEL, snippet: { title: "Mine" } }] } : { items: [{ snippet: { title: "Mine" }, statistics: { subscriberCount: "1234", viewCount: "99", videoCount: "7" } }] };
			},
		},
	});
	expect(await myChannel(ctx, "explicit")).toEqual({ id: CHANNEL, title: "Mine" });
	expect(ctx.calls[0].headers.authorization).toBe("Bearer explicit");
	expect(await channelStats(ctx, CHANNEL)).toEqual({ title: "Mine", subscribers: 1234, views: 99, videos: 7 });
	expect(units()).toBe(2);
});

test("commentThreadsSince stops at the baseline, passes the page token and caps the pages", async () => {
	const at = (s: number) => new Date(Date.parse("2030-06-15T11:00:00Z") - s * 1000).toISOString();
	const since = "2030-06-15T10:00:00Z";
	const paged = fakeCtx(env, {
		routes: { [`GET ${YT}/commentThreads`]: (_c, n) => (n === 0 ? { items: [ytThread("a", "A", "UCa", "t", at(1))], nextPageToken: "p2" } : { items: [ytThread("b", "B", "UCb", "t", at(2)), ytThread("old", "O", "UCo", "t", since)], nextPageToken: "p3" }) },
	});
	const r = await commentThreadsSince(paged, CHANNEL, since);
	expect(r.comments.map(c => c.id)).toEqual(["a", "b"]);
	expect(r.newest).toBe(at(1));
	expect(calls(paged, "/commentThreads")).toHaveLength(2);
	expect(new URL(paged.calls[1].url).searchParams.get("pageToken")).toBe("p2");

	const endless = fakeCtx(env, { routes: { [`GET ${YT}/commentThreads`]: () => ({ items: [ytThread("a", "A", "UCa", "t", at(1))], nextPageToken: "more" }) } });
	expect((await commentThreadsSince(endless, CHANNEL, since)).comments).toHaveLength(3);
	expect(calls(endless, "/commentThreads")).toHaveLength(3);
});

test("insertVideo starts a resumable session, uploads the bytes from the injected reader and books the insert cost", async () => {
	const ctx = fakeCtx(env, {
		routes: {
			"POST https://www.googleapis.com/upload/youtube/v3/videos": () => new Response("{}", { headers: { location: "https://upload.example/s" } }),
			"PUT https://upload.example/s": () => ({ id: "vid1" }),
		},
	});
	const id = await insertVideo(ctx, { file: "/x/clip.mp4", title: "T", description: "D", tags: ["a"], privacy: "unlisted", defaultLanguage: "ko", localizations: { en: { title: "E", description: "e" } } }, () => ({ size: 7, body: () => "CONTENT" }));
	expect(id).toBe("vid1");
	expect(new URL(ctx.calls[0].url).searchParams.get("part")).toBe("snippet,status,localizations");
	expect(ctx.calls[0].headers["x-upload-content-length"]).toBe("7");
	const meta = JSON.parse(ctx.calls[0].body);
	expect(meta.status.privacyStatus).toBe("unlisted");
	expect(meta.localizations.en.title).toBe("E");
	expect(ctx.calls[1].body).toBe("CONTENT");
	expect(units()).toBe(1600);
});

test("insertVideo without localizations leaves the part out, and a missing session URL fails", async () => {
	const ctx = fakeCtx(env, { routes: { "POST https://www.googleapis.com/upload/youtube/v3/videos": () => new Response("{}") } });
	await expect(insertVideo(ctx, { file: "/x.mp4", title: "T", description: "", privacy: "private" }, () => ({ size: 1, body: () => "x" }))).rejects.toThrow(/noUploadSession/);
	expect(new URL(ctx.calls[0].url).searchParams.get("part")).toBe("snippet,status");
});

const video: YtVideo = { id: "v9", title: "T", description: "Orig", categoryId: "22", tags: ["x"], localizations: { en: { title: "E", description: "e" } } };

test("updateVideo merges localizations, backs up once and restoreVideo puts the backup back", async () => {
	const ctx = fakeCtx(env, { routes: { [`PUT ${YT}/videos`]: () => ({}) } });
	await updateVideo(ctx, video, { description: "Orig\n\nnew", localizations: { ja: { title: "J", description: "j" } } }, "ko");
	const put = JSON.parse(ctx.calls[0].body);
	expect(put.snippet).toMatchObject({ title: "T", description: "Orig\n\nnew", categoryId: "22", defaultLanguage: "ko", tags: ["x"] });
	expect(Object.keys(put.localizations)).toEqual(["en", "ja"]);
	await updateVideo(ctx, { ...video, description: "Orig\n\nnew" }, { description: "later" }, "ko");
	const backup = JSON.parse(readFileSync(join(paths.backup(), "v9.json"), "utf8"));
	expect(backup.snippet.description).toBe("Orig");
	expect(Object.keys(backup.localizations)).toEqual(["en"]);
	await restoreVideo(ctx, "v9");
	const restored = JSON.parse(ctx.calls[2].body);
	expect(restored.snippet.description).toBe("Orig");
	expect(Object.keys(restored.localizations)).toEqual(["en"]);
	expect(units()).toBe(150);
	await expect(restoreVideo(ctx, "nope")).rejects.toThrow(/noBackup/);
});

test("replyToComment posts a reply with the parent id and books 50 units", async () => {
	const ctx = fakeCtx(env, { routes: { [`POST ${YT}/comments`]: () => ({ id: "r1" }) } });
	expect(await replyToComment(ctx, "c1", "thanks")).toBe("r1");
	expect(JSON.parse(ctx.calls[0].body)).toEqual({ snippet: { parentId: "c1", textOriginal: "thanks" } });
	expect(units()).toBe(50);
});
