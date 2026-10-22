// jobs lib: validation at creation, the status flow, next posting time in the owner's zone, the publish gate and due selection.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadConfig } from "../lib/config.ts";
import { approve, dueJobs, getJob, listJobs, markDone, markFailed, markPosting, newJob, nextPostingTime, reject } from "../lib/jobs.ts";
import { fakeCtx, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const upload = (ctx = fakeCtx(env)) => newJob(ctx, { kind: "upload", upload: { file: "/abs/clip.mp4", title: "T" } });

test("newJob fills the owner's defaults and starts as a draft", () => {
	const j = upload();
	expect(j.id).toMatch(/^j-203006151200-[0-9a-f]{4}$/);
	expect(j).toMatchObject({ kind: "upload", status: "draft", targets: ["youtube", "instagram"], result: {} });
	expect(j.upload).toMatchObject({ file: "/abs/clip.mp4", title: "T", description: "", tags: [], localizations: {}, privacy: "private" });
	expect(getJob(j.id)).toEqual(j);
	expect(listJobs().map(x => x.id)).toEqual([j.id]);
});

test("newJob refuses malformed bodies and platforms that are not connected", () => {
	const ctx = fakeCtx(env);
	expect(() => newJob(ctx, { kind: "upload", upload: { file: "rel.mp4", title: "T" } })).toThrow(/absolute/);
	expect(() => newJob(ctx, { kind: "upload", upload: { file: "/a.mp4" } })).toThrow(/title/);
	expect(() => newJob(ctx, { kind: "reply", reply: { platform: "tiktok" as never, comment_id: "c", text: "t" } })).toThrow(/reply needs/);
	expect(() => newJob(ctx, { kind: "metadata", metadata: {} })).toThrow(/video_id/);
	expect(() => newJob(ctx, { kind: "video" as never })).toThrow(/kind/);
	env.cleanup();
	env = setupEnv(c => {
		delete c.instagram;
	});
	expect(() => newJob(fakeCtx(env), { kind: "upload", targets: ["instagram"], upload: { file: "/a.mp4", title: "T" } })).toThrow(/not connected/);
	expect(upload(fakeCtx(env)).targets).toEqual(["youtube"]);
});

test("approve without publish_at schedules the next posting time in the config zone", () => {
	const evening = fakeCtx(env);
	expect(approve(evening, upload(evening).id)).toMatchObject({ status: "scheduled", publish_at: "2030-06-16T09:00:00.000Z" });
	const noon = fakeCtx(env, { now: "2030-06-15T03:00:00Z" });
	expect(approve(noon, upload(noon).id).publish_at).toBe("2030-06-15T09:00:00.000Z");
});

test("approve takes now, a past time (due at once) or a future ISO time, and only works on drafts", () => {
	const ctx = fakeCtx(env);
	const a = approve(ctx, upload(ctx).id, { publish_at: "now" });
	expect(a).toMatchObject({ status: "approved", publish_at: "2030-06-15T12:00:00.000Z", approved_at: "2030-06-15T12:00:00.000Z" });
	expect(approve(ctx, upload(ctx).id, { publish_at: "2030-06-01T00:00:00Z" }).status).toBe("approved");
	expect(approve(ctx, upload(ctx).id, { publish_at: "2030-07-01T00:00:00Z" }).status).toBe("scheduled");
	expect(() => approve(ctx, a.id)).toThrow(/only a draft/);
	expect(() => approve(ctx, upload(ctx).id, { publish_at: "tomorrow-ish" })).toThrow(/ISO/);
	expect(() => approve(ctx, "j-203006151200-ffff")).toThrow(/not found/);
});

test("markPosting is the gate: only approved/scheduled jobs pass", () => {
	const ctx = fakeCtx(env);
	const draft = upload(ctx);
	expect(() => markPosting(draft.id)).toThrow(/only an approved or scheduled/);
	const rejected = reject(upload(ctx).id);
	expect(() => markPosting(rejected.id)).toThrow();
	const done = markDone(ctx, approve(ctx, upload(ctx).id, { publish_at: "now" }).id);
	expect(() => markPosting(done.id)).toThrow();
	const failed = markFailed(ctx, approve(ctx, upload(ctx).id, { publish_at: "now" }).id, "boom");
	expect(failed).toMatchObject({ status: "failed", error: "boom" });
	expect(() => markPosting(failed.id)).toThrow();
	const ok = approve(ctx, upload(ctx).id, { publish_at: "now" });
	expect(markPosting(ok.id).status).toBe("posting");
});

test("dueJobs returns only approved/scheduled jobs whose time came, oldest first", () => {
	const ctx = fakeCtx(env);
	const draft = upload(ctx);
	const later = approve(ctx, upload(ctx).id, { publish_at: "2030-07-01T00:00:00Z" });
	const b = approve(ctx, upload(ctx).id, { publish_at: "2030-06-15T11:00:00Z" });
	const a = approve(ctx, upload(ctx).id, { publish_at: "2030-06-15T10:00:00Z" });
	expect(dueJobs(ctx.now()).map(j => j.id)).toEqual([a.id, b.id]);
	expect(dueJobs(ctx.now()).map(j => j.id)).not.toContain(draft.id);
	expect(dueJobs(new Date("2030-07-02T00:00:00Z")).map(j => j.id)).toContain(later.id);
});

test("ids that are not job ids never touch the disk", () => {
	expect(getJob("../config")).toBeUndefined();
	expect(getJob("j-203006151200-zzzz")).toBeUndefined();
});

test("nextPostingTime handles several times a day and a DST change", () => {
	const cfg = { ...loadConfig(), posting_times: ["09:00", "18:00"] };
	expect(nextPostingTime(cfg, new Date("2030-06-15T12:00:00Z")).toISOString()).toBe("2030-06-16T00:00:00.000Z");
	expect(nextPostingTime(cfg, new Date("2030-06-15T00:00:00Z")).toISOString()).toBe("2030-06-15T09:00:00.000Z");
	const ny = { ...cfg, timezone: "America/New_York", posting_times: ["09:00"] };
	expect(nextPostingTime(ny, new Date("2030-03-09T23:00:00Z")).toISOString()).toBe("2030-03-10T13:00:00.000Z");
});
