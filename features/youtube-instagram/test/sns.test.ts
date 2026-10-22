// sns.ts action CLI: job new / status / approve / reject / publish gates, tone-sample, restore and mark-done. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hooks, run as due } from "../bin/due.ts";
import { mergeExamples, run } from "../bin/sns.ts";
import { paths, writeJson } from "../lib/config.ts";
import { getJob } from "../lib/jobs.ts";
import { CHANNEL, dropVideo, type FakeCtx, fakeCtx, IG, setupEnv, type TestEnv, ytThread, YT } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
	hooks.reader = () => ({ size: 5, body: () => "VIDEO" });
	hooks.tunnel = { spawn: () => ({ lines: (async function* () { yield "https://abc-def.trycloudflare.com"; })(), kill: () => {} }) };
});
afterEach(() => {
	hooks.reader = undefined;
	hooks.tunnel = undefined;
	env.cleanup();
});

function serveUploads(ctx: FakeCtx) {
	ctx.routes["POST https://www.googleapis.com/upload/youtube/v3/videos"] = () => new Response("{}", { headers: { location: "https://upload.example/s1" } });
	ctx.routes["PUT https://upload.example/s1"] = () => ({ id: "vid1" });
	ctx.routes[`POST ${IG}/me/media`] = () => ({ id: "cont1" });
	ctx.routes[`GET ${IG}/cont1`] = () => ({ status_code: "FINISHED" });
	ctx.routes[`POST ${IG}/me/media_publish`] = () => ({ id: "media9" });
}

async function newUpload(ctx: FakeCtx, name = "clip.mp4"): Promise<string> {
	const body = join(env.dir, "job.json");
	writeFileSync(body, JSON.stringify({ upload: { file: dropVideo(env, name), title: "Title", description: "Desc", ig_caption: "cap" } }));
	const res = await run(ctx, ["job", "new", "--kind", "upload", "--json", body]);
	expect(res.lines[0]).toMatch(/^created j-\d{12}-[0-9a-f]{4} upload draft$/);
	return res.lines[0].split(" ")[1];
}

test("job new, status, approve and reject walk the status flow", async () => {
	const ctx = fakeCtx(env);
	const id = await newUpload(ctx);
	expect((await run(ctx, ["status"])).lines).toEqual([`${id} upload draft Title`]);
	expect((await run(ctx, ["approve", id])).lines).toEqual([`approved ${id} scheduled at=2030-06-16T09:00:00.000Z`]);
	expect((await run(ctx, ["status"])).lines).toEqual([`${id} upload scheduled at=2030-06-16T09:00:00.000Z Title`]);
	expect((await run(ctx, ["reject", id])).lines).toEqual([`rejected ${id}`]);
	expect((await run(ctx, ["status"])).lines).toEqual(["열려 있는 작업이 없어요"]);
	const again = await run(ctx, ["approve", id]);
	expect(again.code).toBe(1);
	expect(again.lines[0]).toMatch(/^error: .*rejected/);
});

test("approve --at takes an ISO time or now", async () => {
	const ctx = fakeCtx(env);
	const a = await newUpload(ctx, "a.mp4");
	const b = await newUpload(ctx, "b.mp4");
	expect((await run(ctx, ["approve", a, "--at", "2030-07-01T00:00:00Z"])).lines).toEqual([`approved ${a} scheduled at=2030-07-01T00:00:00.000Z`]);
	expect((await run(ctx, ["approve", b, "--at", "now"])).lines).toEqual([`approved ${b} approved at=${ctx.now().toISOString()}`]);
});

test("job new rejects a body without a title and an unknown kind", async () => {
	const ctx = fakeCtx(env);
	const body = join(env.dir, "bad.json");
	writeFileSync(body, JSON.stringify({ upload: { file: "/tmp/x.mp4" } }));
	const bad = await run(ctx, ["job", "new", "--kind", "upload", "--json", body]);
	expect(bad.code).toBe(1);
	expect(bad.lines[0]).toBe("error: upload.title is required");
	expect((await run(ctx, ["job", "new", "--kind", "video", "--json", body])).code).toBe(2);
	expect((await run(ctx, ["nope"])).code).toBe(2);
});

test("publish refuses a draft, and publishes an approved job through the same path as due", async () => {
	const ctx = fakeCtx(env);
	serveUploads(ctx);
	const id = await newUpload(ctx);
	const refused = await run(ctx, ["publish", id]);
	expect(refused.code).toBe(1);
	expect(refused.lines[0]).toMatch(/only an approved or scheduled/);
	expect(ctx.calls).toHaveLength(0);
	await run(ctx, ["approve", id, "--at", "now"]);
	expect(await run(ctx, ["publish", id])).toEqual({ lines: [`posted ${id} youtube=vid1`, `posted ${id} instagram=media9`], code: 0 });
	expect(getJob(id)?.status).toBe("done");
});

test("tone-sample writes the owner's own replies under ## 예시 without commenter names, keeping the rest of tone.md", async () => {
	writeFileSync(paths.tone(), "# 톤\n\n친근하게 답해요\n");
	const ctx = fakeCtx(env);
	ctx.routes[`GET ${YT}/commentThreads`] = () => ({
		items: [
			{ ...ytThread("c1", "Fan", "UCfan", "great", "2030-06-15T10:00:00Z"), replies: { comments: [{ snippet: { authorChannelId: { value: CHANNEL }, textDisplay: "@Fan 고마워요!" } }, { snippet: { authorChannelId: { value: "UCother" }, textDisplay: "someone else" } }] } },
		],
	});
	ctx.routes[`GET ${IG}/me/media`] = () => ({ data: [{ id: "m1", comments_count: 2, timestamp: "2030-06-01T00:00:00+0000" }] });
	ctx.routes[`GET ${IG}/m1/comments`] = () => ({
		data: [{ id: "k1", text: "wow", username: "fan1", timestamp: "2030-06-02T00:00:00+0000", replies: { data: [{ username: "owner_ig", text: "@fan1 감사해요" }, { username: "fan2", text: "not mine" }] } }],
	});
	expect(await run(ctx, ["tone-sample", "--limit", "30"])).toEqual({ lines: ["tone-sample 2"], code: 0 });
	const expected = "# 톤\n\n친근하게 답해요\n\n## 예시\n\n- 고마워요!\n- 감사해요\n";
	expect(readFileSync(paths.tone(), "utf8")).toBe(expected);
	await run(ctx, ["tone-sample"]);
	expect(readFileSync(paths.tone(), "utf8")).toBe(expected);
});

test("mergeExamples replaces only the example section", () => {
	expect(mergeExamples("# 톤\n\n## 예시\n\n- old\n\n## 금지\n\n- no\n", ["a"])).toBe("# 톤\n\n## 예시\n\n- a\n\n## 금지\n\n- no\n");
	expect(mergeExamples("", ["a", "b"])).toBe("## 예시\n\n- a\n- b\n");
});

test("restore puts the backed-up snippet and localizations back", async () => {
	const ctx = fakeCtx(env);
	ctx.routes[`PUT ${YT}/videos`] = () => ({});
	writeJson(join(paths.backup(), "v9.json"), { snippet: { title: "T", description: "Orig", categoryId: "22", defaultLanguage: "ko" }, localizations: {} });
	expect(await run(ctx, ["restore", "v9"])).toEqual({ lines: ["restored v9"], code: 0 });
	const body = JSON.parse(ctx.calls[0].body);
	expect(body).toEqual({ id: "v9", snippet: { title: "T", description: "Orig", categoryId: "22", defaultLanguage: "ko" }, localizations: {} });
	const none = await run(ctx, ["restore", "v404"]);
	expect(none.code).toBe(1);
	expect(none.lines[0]).toBe("error: youtube 404 noBackup");
});

test("mark-done records an `aside` target and finishes the job when every target is done", async () => {
	env.cleanup();
	env = setupEnv(c => {
		if (c.youtube) c.youtube.upload_via = "aside";
	});
	const ctx = fakeCtx(env);
	serveUploads(ctx);
	const id = await newUpload(ctx);
	await run(ctx, ["approve", id, "--at", "now"]);
	expect((await due(ctx, [])).lines).toEqual([`aside-needed ${id} youtube`, `posted ${id} instagram=media9`]);
	expect(await run(ctx, ["mark-done", id, "youtube", "vid7"])).toEqual({ lines: [`marked ${id} youtube`, `done ${id}`], code: 0 });
	expect(getJob(id)?.result.youtube).toBe("vid7");
	expect(existsSync(join(paths.inbox(), "done", "clip.mp4"))).toBe(true);
	expect((await run(ctx, ["mark-done", id, "youtube"])).code).toBe(1);
});

test("setup problems surface as DOTZ_FAIL setup", async () => {
	writeJson(paths.config(), { version: 2 });
	const res = await run(fakeCtx(env), ["publish", "j-203006151200-abcd"]);
	expect(res.lines[0]).toMatch(/^error: job .* not found$/);
	const status = await run(fakeCtx(env), ["restore", "v1"]);
	expect(status.lines[0]).toBe("DOTZ_FAIL setup");
	expect(status.code).toBe(1);
});
