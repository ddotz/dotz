import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run as due } from "../bin/due.ts";
import { run as sns } from "../bin/sns.ts";
import { PUBLISH_MISSING_KO, publishState, setPublishMissing } from "../lib/ig-publish.ts";
import { PublishPermissionError, publishReel } from "../lib/instagram.ts";
import { approve, getJob, newJob } from "../lib/jobs.ts";
import { dropVideo, fakeCtx, IG, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const denied = { [`POST ${IG}/me/media`]: () => ({ id: "c1" }), [`GET ${IG}/c1`]: () => ({ status_code: "FINISHED" }), [`POST ${IG}/me/media_publish`]: () => Response.json({ error: { code: 10, type: "OAuthException" } }, { status: 400 }) };

test("API code 10 on publish becomes a Korean permission error and is remembered; a working publish clears it", async () => {
	const ctx = fakeCtx(env, { routes: denied });
	const err = await publishReel(ctx, "https://x/a.mp4", "cap").catch(e => e);
	expect(err).toBeInstanceOf(PublishPermissionError);
	expect(err.message).toBe(PUBLISH_MISSING_KO);
	expect(err.message).toContain("instagram_business_content_publish");
	expect(err.message).toContain("액세스 토큰 생성");
	expect(publishState().missing).toBe(true);

	const works = fakeCtx(env, { routes: { ...denied, [`POST ${IG}/me/media_publish`]: () => ({ id: "media9" }) } });
	expect(await publishReel(works, "https://x/a.mp4", "cap")).toBe("media9");
	expect(publishState().missing).toBe(false);
});

test("a Reels job is not sent to Meta while the permission is known to be missing: one Korean line, the job stays waiting", async () => {
	const ctx = fakeCtx(env, { routes: denied });
	const file = dropVideo(env, "a.mp4");
	const job = newJob(ctx, { kind: "upload", targets: ["instagram"], upload: { file, title: "t" } });
	approve(ctx, job.id, { publish_at: "now" });
	setPublishMissing(ctx);

	const first = await due(ctx, []);
	expect(first.lines).toEqual([`ig-publish-blocked ${job.id}: ${PUBLISH_MISSING_KO}`]);
	expect(getJob(job.id)?.status).toBe("approved");
	expect(ctx.calls).toHaveLength(0);

	const before = ctx.calls.length;
	expect(await due(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls.length).toBe(before);
});

test("the approval card of a new Reels upload says it cannot publish yet, only while the permission is missing", async () => {
	const ctx = fakeCtx(env, { routes: denied });
	const file = dropVideo(env, "b.mp4");
	const body = join(env.dir, "job.json");
	writeFileSync(body, JSON.stringify({ targets: ["instagram"], upload: { file, title: "t" } }));
	const clear = await sns(ctx, ["job", "new", "--kind", "upload", "--json", body]);
	expect(clear.lines).toHaveLength(1);

	await publishReel(ctx, "https://x/a.mp4", "cap").catch(() => {});
	const blocked = await sns(ctx, ["job", "new", "--kind", "upload", "--json", body]);
	expect(blocked.lines).toHaveLength(2);
	expect(blocked.lines[1]).toMatch(/^ig-publish-blocked j-\S+: 아직 릴스를 올릴 수 없어요\. .*instagram_business_content_publish/);
});
