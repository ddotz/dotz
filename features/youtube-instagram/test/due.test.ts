// due watch: a draft is never published, approve schedules at the next posting time, a due job publishes through the fake
// YouTube upload / Instagram tunnel path and is marked done with its file filed away; aside targets, quota shortage,
// transient, auth and permanent failures are covered. Fake fetch, fake cloudflared, no timers.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hooks, publishJob, run } from "../bin/due.ts";
import { loadConfig, paths, readJson, writeJson } from "../lib/config.ts";
import { approve, getJob, type Job, newJob } from "../lib/jobs.ts";
import { calls, dropVideo, type FakeCtx, fakeCtx, IG, setupEnv, type TestEnv, YT } from "./helpers.ts";

const YT_UP = "POST https://www.googleapis.com/upload/youtube/v3/videos";
let env: TestEnv;
let killed = 0;
beforeEach(() => {
	env = setupEnv();
	killed = 0;
	hooks.reader = () => ({ size: 5, body: () => "VIDEO" });
	hooks.tunnel = {
		spawn: () => ({
			lines: (async function* () {
				yield "INF Requesting new quick Tunnel";
				yield "INF |  https://abc-def.trycloudflare.com  |";
			})(),
			kill: () => {
				killed++;
			},
		}),
	};
});
afterEach(() => {
	hooks.reader = undefined;
	hooks.tunnel = undefined;
	env.cleanup();
});

function serve(ctx: FakeCtx) {
	ctx.routes[YT_UP] = () => new Response("{}", { headers: { location: "https://upload.example/s1" } });
	ctx.routes["PUT https://upload.example/s1"] = () => ({ id: "vid1" });
	ctx.routes[`POST ${IG}/me/media`] = () => ({ id: "cont1" });
	ctx.routes[`GET ${IG}/cont1`] = () => ({ status_code: "FINISHED" });
	ctx.routes[`POST ${IG}/me/media_publish`] = () => ({ id: "media9" });
}

function upload(ctx: FakeCtx, name = "clip.mp4"): Job {
	const file = dropVideo(env, name);
	return newJob(ctx, { kind: "upload", upload: { file, title: "Title", description: "Desc", tags: ["a"], ig_caption: "cap" } });
}

test("a draft is never published", async () => {
	const ctx = fakeCtx(env);
	serve(ctx);
	const job = upload(ctx);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	await expect(publishJob(ctx, loadConfig(), job.id)).rejects.toThrow(/only an approved or scheduled/);
	expect(ctx.calls).toHaveLength(0);
	expect(getJob(job.id)?.status).toBe("draft");
});

test("approve schedules at the next posting time; when it comes, due publishes and marks the job done", async () => {
	const before = fakeCtx(env);
	serve(before);
	const job = upload(before);
	const scheduled = approve(before, job.id);
	expect(scheduled.status).toBe("scheduled");
	expect(scheduled.publish_at).toBe("2030-06-16T09:00:00.000Z");
	expect(await run(before, [])).toEqual({ lines: [], code: 0 });
	expect(before.calls).toHaveLength(0);

	const ctx = fakeCtx(env, { now: "2030-06-16T09:00:01.000Z" });
	serve(ctx);
	expect(await run(ctx, [])).toEqual({ lines: [`posted ${job.id} youtube=vid1`, `posted ${job.id} instagram=media9`], code: 0 });
	const done = getJob(job.id);
	expect(done?.status).toBe("done");
	expect(done?.result).toEqual({ youtube: "vid1", instagram: "media9" });
	expect(existsSync(join(paths.inbox(), "done", "clip.mp4"))).toBe(true);
	expect(existsSync(join(paths.inbox(), "clip.mp4"))).toBe(false);
	expect(killed).toBe(1);
	expect(readJson<{ units: number }>(paths.quota())?.units).toBe(1600);

	const start = ctx.calls.find(c => c.url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos"));
	expect(start?.headers.authorization).toBe("Bearer yt-access");
	expect(start?.headers["x-upload-content-length"]).toBe("5");
	expect(JSON.parse(start?.body ?? "{}").snippet.title).toBe("Title");
	expect(JSON.parse(start?.body ?? "{}").status.privacyStatus).toBe("private");
	expect(calls(ctx, "upload.example")[0].body).toBe("VIDEO");
	const container = new URLSearchParams(calls(ctx, "/me/media")[0].body);
	expect(container.get("media_type")).toBe("REELS");
	expect(container.get("caption")).toBe("cap");
	expect(container.get("video_url")).toMatch(/^https:\/\/abc-def\.trycloudflare\.com\/[0-9a-f]{32}\.mp4$/);
	expect(calls(ctx, "/me/media")[0].headers.authorization).toBe("Bearer ig-token");
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
});

test("an `aside` target is announced once and the job stays scheduled for the orchestrator", async () => {
	env.cleanup();
	env = setupEnv(c => {
		if (c.youtube) c.youtube.upload_via = "aside";
	});
	const ctx = fakeCtx(env);
	serve(ctx);
	const job = upload(ctx);
	approve(ctx, job.id, { publish_at: "now" });
	expect(await run(ctx, [])).toEqual({ lines: [`aside-needed ${job.id} youtube`, `posted ${job.id} instagram=media9`], code: 0 });
	expect(getJob(job.id)?.status).toBe("scheduled");
	expect(getJob(job.id)?.result).toEqual({ instagram: "media9" });
	expect(existsSync(join(paths.inbox(), "clip.mp4"))).toBe(true);
	expect(calls(ctx, "googleapis.com/upload")).toHaveLength(0);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
});

test("too little YouTube quota reports `failed <id> quota` once, still posts Instagram, and resumes later", async () => {
	writeJson(paths.quota(), { day: "2030-06-15", units: 8900 });
	const ctx = fakeCtx(env);
	serve(ctx);
	const job = upload(ctx);
	approve(ctx, job.id, { publish_at: "now" });
	expect(await run(ctx, [])).toEqual({ lines: [`failed ${job.id} quota`, `posted ${job.id} instagram=media9`], code: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(getJob(job.id)?.status).toBe("scheduled");
	expect(getJob(job.id)?.error).toBe("quota");
	writeJson(paths.quota(), { day: "2030-06-15", units: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [`posted ${job.id} youtube=vid1`], code: 0 });
	expect(getJob(job.id)?.status).toBe("done");
});

test("a transient failure is absorbed and the job stays scheduled, then publishes", async () => {
	const ctx = fakeCtx(env);
	serve(ctx);
	ctx.routes[YT_UP] = () => new Response("down", { status: 503 });
	const job = upload(ctx);
	approve(ctx, job.id, { publish_at: "now" });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(getJob(job.id)?.status).toBe("scheduled");
	expect(getJob(job.id)?.result).toEqual({});
	serve(ctx);
	expect((await run(ctx, [])).lines).toEqual([`posted ${job.id} youtube=vid1`, `posted ${job.id} instagram=media9`]);
});

test("a rejected login prints DOTZ_FAIL youtube-auth and keeps the job for after the login is redone", async () => {
	const ctx = fakeCtx(env);
	serve(ctx);
	ctx.routes[YT_UP] = () => new Response("{}", { status: 401 });
	const job = upload(ctx);
	approve(ctx, job.id, { publish_at: "now" });
	const res = await run(ctx, []);
	expect(res.code).toBe(1);
	expect(res.lines[0]).toBe("DOTZ_FAIL youtube-auth");
	expect(getJob(job.id)?.status).toBe("scheduled");
});

test("a permanent failure marks the job failed and is not retried", async () => {
	const ctx = fakeCtx(env);
	serve(ctx);
	ctx.routes[YT_UP] = () => Response.json({ error: { errors: [{ reason: "forbidden" }] } }, { status: 403 });
	const job = upload(ctx);
	approve(ctx, job.id, { publish_at: "now" });
	expect(await run(ctx, [])).toEqual({ lines: [`failed ${job.id} youtube 403 forbidden`], code: 0 });
	expect(getJob(job.id)?.status).toBe("failed");
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
});

test("reply jobs post through the platform reply calls and leave files alone", async () => {
	const ctx = fakeCtx(env);
	ctx.routes[`POST ${YT}/comments`] = () => ({ id: "r1" });
	ctx.routes[`POST ${IG}/k1/replies`] = () => ({ id: "ir1" });
	const a = newJob(ctx, { kind: "reply", reply: { platform: "youtube", comment_id: "c1", text: "thanks" } });
	const b = newJob(ctx, { kind: "reply", reply: { platform: "instagram", comment_id: "k1", text: "고마워요" } });
	approve(ctx, a.id, { publish_at: "now" });
	approve(ctx, b.id, { publish_at: "now" });
	const res = await run(ctx, []);
	expect(res.code).toBe(0);
	expect([...res.lines].sort()).toEqual([`posted ${a.id} youtube=r1`, `posted ${b.id} instagram=ir1`].sort());
	expect(JSON.parse(calls(ctx, "/comments?")[0].body).snippet).toEqual({ parentId: "c1", textOriginal: "thanks" });
	expect(new URLSearchParams(calls(ctx, "/k1/replies")[0].body).get("message")).toBe("고마워요");
	expect(getJob(a.id)?.status).toBe("done");
});

test("a metadata job appends the section under the original description, merges localizations and backs up once", async () => {
	const ctx = fakeCtx(env);
	ctx.routes[`GET ${YT}/videos`] = () => ({ items: [{ id: "v9", snippet: { title: "T", description: "Orig", categoryId: "22" } }] });
	ctx.routes[`PUT ${YT}/videos`] = () => ({});
	const job = newJob(ctx, { kind: "metadata", metadata: { video_id: "v9", append: { en: "Hello" }, localizations: { en: { title: "Hi", description: "Hello" } } } });
	approve(ctx, job.id, { publish_at: "now" });
	expect(await run(ctx, [])).toEqual({ lines: [`posted ${job.id} youtube=v9`], code: 0 });
	const put = JSON.parse(ctx.calls.find(c => c.method === "PUT" && c.url.includes("/videos?"))?.body ?? "{}");
	expect(put.snippet.description).toBe("Orig\n\n[en]\nHello");
	expect(put.snippet.defaultLanguage).toBe("ko");
	expect(put.localizations.en.title).toBe("Hi");
	expect(JSON.parse(readFileSync(join(paths.backup(), "v9.json"), "utf8")).snippet.description).toBe("Orig");
});

test("missing config prints DOTZ_FAIL setup", async () => {
	rmSync(paths.config());
	const res = await run(fakeCtx(env), []);
	expect(res.code).toBe(1);
	expect(res.lines[0]).toBe("DOTZ_FAIL setup");
});
