// Comment replies for youtube and instagram: per-source switch, one shared adapter, the approval gate of sns.ts and the 고치기 round trip.
// Fake model, temp data dir, fake SNS fetch; nothing leaves the machine.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { run as sns } from "../../youtube-instagram/bin/sns.ts";
import { run as ytComments } from "../../youtube-instagram/bin/yt-comments.ts";
import { paths as snsPaths } from "../../youtube-instagram/lib/config.ts";
import { getJob, listJobs } from "../../youtube-instagram/lib/jobs.ts";
import { snsAdapter } from "../../youtube-instagram/lib/reply-adapter.ts";
import { fakeCtx, setupEnv, type TestEnv, YT, ytThread } from "../../youtube-instagram/test/helpers.ts";
import { runOnboard, type SnsAccess } from "../bin/onboard.ts";
import { draftComments } from "../lib/comments.ts";
import { appOn, loadSettings } from "../lib/settings.ts";
import { fakeModel, j } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const REPLY = "영상 봐 주셔서 고마워요!";
const draft = (body = REPLY) => j({ action: "draft", reason: "a greeting", to: "Bob", body, questions: [] });
const skip = j({ action: "skip", reason: "advertisement", to: "", body: "", questions: [] });
const config = (c: object) => {
	mkdirSync(join(env.dir, "custom", "reply-drafts"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "reply-drafts", "config.json"), JSON.stringify(c));
};
const youtubeOn = () => config({ enabled: true, apps: { youtube: { auto: true }, instagram: { auto: false } } });
const YT_LINE = "yt-comment c2 video=v1 by=Bob: 영상 잘 봤어요";
const IG_LINE = "ig-comment k1 media=m1 by=Zed: 사진 좋아요";
const tone = (app: string) => join(env.dir, "custom", "reply-drafts", "tone", `${app}.md`);

// What the web send writes to inbox.jsonl for a pick on one job, a minute after the fake clock.
function pick(id: string, n: 1 | 2 | 3, note?: string) {
	const label = ["보내기", "고치기", "보내지 않기"][n - 1]!;
	const text = `${n}) ${label}${note ? ` - ${note}` : ""}`;
	appendFileSync(join(env.dir, "inbox.jsonl"), `${JSON.stringify({ ts: "2030-06-15T12:01:00.000Z", kind: "message", source: "web", text, picks: [{ q: `이 답글 올릴까요? (${id})`, n, label }] })}\n`);
}

async function oneAsk(): Promise<{ id: string; text: string }> {
	const model = fakeModel([draft()]);
	const out = await draftComments(snsAdapter(fakeCtx(env), "youtube"), [YT_LINE], { call: model.call });
	expect(out).toHaveLength(1);
	return { id: parseDraftApproval(out[0]!)!.ref!, text: out[0]! };
}

test("youtube on: the watch prints one ready [ask] and one pending reply job; instagram, switched off, passes through untouched", async () => {
	youtubeOn();
	const model = fakeModel([draft()]);
	const ctx = fakeCtx(env, { routes: { [`GET ${YT}/commentThreads`]: () => ({ items: [ytThread("c1", "Ann", "UCann", "old", "2030-06-15T10:00:00Z")] }) } });
	await ytComments(ctx, [], { call: model.call });
	ctx.routes[`GET ${YT}/commentThreads`] = () => ({ items: [ytThread("c2", "Bob", "UCbob", "영상 잘 봤어요", "2030-06-15T11:00:00Z"), ytThread("c1", "Ann", "UCann", "old", "2030-06-15T10:00:00Z")] });
	const res = await ytComments(ctx, [], { call: model.call });
	expect(res.code).toBe(0);
	expect(res.lines).toHaveLength(1);
	const jobs = listJobs();
	expect(jobs).toHaveLength(1);
	expect(jobs[0]).toMatchObject({ kind: "reply", status: "draft", targets: ["youtube"], reply: { platform: "youtube", comment_id: "c2", text: REPLY } });
	expect(res.lines[0]).toContain("[ask]");
	expect(parseDraftApproval(res.lines[0]!)).toEqual({ toLabel: "대상", to: "Bob 댓글", body: REPLY, ref: jobs[0]!.id });

	const igOut = await draftComments(snsAdapter(ctx, "instagram"), [IG_LINE, "ig-comment-note something"], { call: model.call });
	expect(igOut).toEqual([IG_LINE, "ig-comment-note something"]);
	expect(model.calls).toHaveLength(1);
	expect(listJobs()).toHaveLength(1);
});

test("switched off by the user: no model call, no job and the lines come back unchanged", async () => {
	config({ enabled: false });
	const model = fakeModel([draft()]);
	expect(await draftComments(snsAdapter(fakeCtx(env), "youtube"), [YT_LINE], { call: model.call })).toEqual([YT_LINE]);
	expect(model.calls).toHaveLength(0);
	expect(listJobs()).toHaveLength(0);
});

test("a skipped comment produces no ask, and a comment id is drafted once", async () => {
	youtubeOn();
	const ad = fakeModel([skip]);
	expect(await draftComments(snsAdapter(fakeCtx(env), "youtube"), ["yt-comment c9 video=v1 by=Spam: buy now"], { call: ad.call })).toEqual([]);
	expect(listJobs()).toHaveLength(0);
	expect(await draftComments(snsAdapter(fakeCtx(env), "youtube"), ["yt-comment c9 video=v1 by=Spam: buy now"], { call: ad.call })).toEqual([]);
	expect(ad.calls).toHaveLength(1);

	const model = fakeModel([draft()]);
	const a = snsAdapter(fakeCtx(env), "youtube");
	expect(await draftComments(a, [YT_LINE], { call: model.call })).toHaveLength(1);
	expect(await draftComments(a, [YT_LINE], { call: model.call })).toEqual([]);
	expect(model.calls).toHaveLength(1);
	expect(listJobs()).toHaveLength(1);
});

test("a model failure leaves the line for the orchestrator and drafts nothing", async () => {
	youtubeOn();
	const errors = console.error;
	console.error = () => {};
	try {
		const out = await draftComments(snsAdapter(fakeCtx(env), "youtube"), [YT_LINE], { call: async () => { throw new Error("model down"); } });
		expect(out).toEqual([YT_LINE]);
	} finally {
		console.error = errors;
	}
	expect(listJobs()).toHaveLength(0);
});

test("approve of a reply job is refused without a pick and with a pick for another job, allowed with 보내기 for that job", async () => {
	youtubeOn();
	const { id } = await oneAsk();
	const ctx = fakeCtx(env);
	const none = await sns(ctx, ["approve", id]);
	expect(none.code).toBe(1);
	expect(getJob(id)?.status).toBe("draft");
	pick("j-203006151200-ffff", 1);
	expect((await sns(ctx, ["approve", id])).code).toBe(1);
	pick(id, 3);
	expect((await sns(ctx, ["approve", id])).lines[0]).toContain("보내지 않기");
	pick(id, 2, "더 짧게");
	expect((await sns(ctx, ["approve", id])).lines[0]).toContain("고치기");
	expect(getJob(id)?.status).toBe("draft");
	pick(id, 1);
	const ok = await sns(ctx, ["approve", id, "--at", "now"]);
	expect(ok.code).toBe(0);
	expect(getJob(id)?.status).toBe("approved");
});

test("고치기 makes a new job and a new ask, rejects the old job and records the change in the youtube tone only", async () => {
	youtubeOn();
	const { id } = await oneAsk();
	const revised = fakeModel([draft("보러 와 주셔서 감사해요!")]);
	const res = await sns(fakeCtx(env), ["revise", id, "--change", "더 짧고 담백하게"], { call: revised.call });
	expect(res.code).toBe(0);
	const next = parseDraftApproval(res.lines[0]!)!;
	expect(next.ref).not.toBe(id);
	expect(next).toMatchObject({ toLabel: "대상", to: "Bob 댓글", body: "보러 와 주셔서 감사해요!" });
	expect(getJob(id)?.status).toBe("rejected");
	expect(getJob(next.ref!)).toMatchObject({ status: "draft", reply: { comment_id: "c2", text: "보러 와 주셔서 감사해요!" } });
	expect(revised.calls[0]!.user).toContain("더 짧고 담백하게");
	expect(readFileSync(tone("youtube"), "utf8")).toContain("더 짧고 담백하게");
	expect(existsSync(tone("instagram"))).toBe(false);
	expect(existsSync(tone("mail"))).toBe(false);
	expect((await sns(fakeCtx(env), ["approve", id])).code).toBe(1);
	expect(await sns(fakeCtx(env), ["reject", next.ref!])).toMatchObject({ code: 0 });
});

const connected: SnsAccess = {
	connected: () => true,
	ownTexts: async p => (p === "youtube" ? ["영상 봐 주셔서 고마워요.", "구독 감사합니다."] : ["사진 좋아해 주셔서 감사해요.", "또 올릴게요."]),
};
const noRun = async () => ({ code: 1, stdout: "", stderr: "" });

test("on --app turns on only that source and learns each platform's tone separately", async () => {
	const yt = await runOnboard(["on", "--app", "youtube"], noRun, false, connected);
	expect(yt.code).toBe(0);
	let s = loadSettings();
	expect([appOn(s, "youtube"), appOn(s, "instagram"), appOn(s, "mail")]).toEqual([true, true, false]);
	const ig = await runOnboard(["on", "--app", "instagram"], noRun, false, connected);
	expect(ig.code).toBe(0);
	s = loadSettings();
	expect([appOn(s, "youtube"), appOn(s, "instagram"), appOn(s, "mail")]).toEqual([true, true, false]);
	const y = readFileSync(tone("youtube"), "utf8");
	const i = readFileSync(tone("instagram"), "utf8");
	expect(y).toContain("영상 봐 주셔서 고마워요.");
	expect(y).not.toContain("사진");
	expect(i).toContain("사진 좋아해 주셔서 감사해요.");
	expect(i).not.toContain("영상");
	await runOnboard(["off", "--app", "youtube"], noRun, false, connected);
	s = loadSettings();
	expect([appOn(s, "youtube"), appOn(s, "instagram")]).toEqual([false, true]);
});

test("on --app youtube without the SNS connection exits 3, names the connect step and turns nothing on", async () => {
	rmSync(snsPaths.config());
	const out = await runOnboard(["on", "--app", "youtube", "--to", "ch:1"], noRun, false);
	expect(out.code).toBe(3);
	expect(out.lines.join("\n")).toContain("youtube-instagram/bin/onboard.ts run --youtube --target ch:1");
	expect(loadSettings().enabled).toBe(false);
	expect(existsSync(tone("youtube"))).toBe(false);
});

test("an old config keeps working: top-level enabled/auto drive mail; connected platforms follow their monitoring", () => {
	config({ enabled: true });
	let s = loadSettings();
	expect([appOn(s, "mail"), appOn(s, "youtube"), appOn(s, "instagram")]).toEqual([true, true, true]);
	config({ enabled: true, auto: false });
	s = loadSettings();
	expect(appOn(s, "mail")).toBe(false);
	config({ enabled: false, apps: { youtube: { auto: true } } });
	expect(appOn(loadSettings(), "youtube")).toBe(false);
});
