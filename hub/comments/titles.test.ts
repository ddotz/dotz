// Post titles of the comments: the YouTube adapter names every video from one batched lookup, a stored comment without a title is
// backfilled on the next poll, and Instagram posts show the caption start and a thumbnail. No network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentAsk } from "./ask.ts";
import { FALLBACK_TITLE, type SourceConfig } from "./contract.ts";
import { createEngine, type DraftModel } from "./engine.ts";
import { instagramAdapter, youtubeAdapter, type YoutubeApi } from "./adapters/google-meta.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const YT: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const IG: SourceConfig = { key: "instagram", kind: "instagram", label: "인스타 댓글", watch: ["*"], autoDraft: false };
const model: DraftModel = async () => ({ text: "" });
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comment-titles-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const thread = (id: string, videoId: string) => ({ id, videoId, author: "가나", authorChannelId: "UCfan", text: `질문 ${id}`, publishedAt: "2026-10-22T12:00:00.000Z" });

function youtube(titles: Record<string, { title: string; thumb?: string }>, comments = [thread("c1", "v1"), thread("c2", "v2"), thread("c3", "v1")]) {
	const seen: string[][] = [];
	const api: YoutubeApi = {
		channelId: () => "UCme",
		threadsSince: async () => ({ comments, newest: "2026-10-22T12:00:00.000Z" }),
		uploads: async () => [],
		videos: async ids => (seen.push(ids), Object.fromEntries(ids.filter(id => titles[id]).map(id => [id, titles[id]!]))),
		reply: async () => "r",
		ownReplies: async () => [],
	};
	return { adapter: youtubeAdapter(() => api), seen };
}

function engineWith(adapter: ReturnType<typeof youtubeAdapter>, key = "youtube", src: SourceConfig = YT) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { [key]: src } }));
	return createEngine({ dir, now: () => NOW, collector: "mac-a", adapters: { youtube: adapter, website: adapter }, model });
}

test("every comment carries its video's title and thumbnail, looked up once for all videos", async () => {
	const { adapter, seen } = youtube({ v1: { title: "첫 영상", thumb: "https://img.example/v1.jpg" }, v2: { title: "둘째 영상" } });
	const { comments } = await adapter.list(YT, undefined);
	expect(seen).toEqual([["v1", "v2"]]);
	expect(comments.map(c => [c.thread, c.postTitle, c.postLink, c.thumb])).toEqual([
		["v1", "첫 영상", "https://www.youtube.com/watch?v=v1", "https://img.example/v1.jpg"],
		["v2", "둘째 영상", "https://www.youtube.com/watch?v=v2", undefined],
		["v1", "첫 영상", "https://www.youtube.com/watch?v=v1", "https://img.example/v1.jpg"],
	]);
});

test("a video with no readable title is collected under the fallback and renamed on the next poll", async () => {
	const titles: Record<string, { title: string; thumb?: string }> = {};
	const { adapter } = youtube(titles);
	const engine = engineWith(adapter);
	await engine.collect({ force: true });
	expect(engine.store.comments().map(c => c.postTitle)).toEqual([FALLBACK_TITLE.youtube, FALLBACK_TITLE.youtube, FALLBACK_TITLE.youtube]);

	titles.v1 = { title: "첫 영상", thumb: "https://img.example/v1.jpg" };
	await engine.collect({ force: true });
	const by = Object.fromEntries(engine.store.comments().map(c => [c.native, c]));
	expect([by.c1!.postTitle, by.c3!.postTitle, by.c1!.thumb]).toEqual(["첫 영상", "첫 영상", "https://img.example/v1.jpg"]);
	expect(by.c2!.postTitle).toBe(FALLBACK_TITLE.youtube);
	expect(engine.threads("youtube").map(t => [t.thread, t.title, t.thumb, t.kind])).toContainEqual(["v1", "첫 영상", "https://img.example/v1.jpg", "youtube"]);
	const view = engine.threadView("youtube", "v1")!;
	expect([view.thread.title, view.thread.thumb, view.thread.link]).toEqual(["첫 영상", "https://img.example/v1.jpg", "https://www.youtube.com/watch?v=v1"]);
});

test("an Instagram post shows the caption start and its picture, and a post without a caption gets the fallback", async () => {
	const api = {
		username: () => "owner_ig",
		media: async () => [
			{ id: "m1", caption: "가을 신상\n  지금 만나요 ".repeat(10), comments_count: 1, timestamp: "2026-10-01T00:00:00Z", permalink: "https://www.instagram.com/p/abc/", thumb: "https://img.example/m1.jpg" },
			{ id: "m2", comments_count: 1, timestamp: "2026-10-02T00:00:00Z" },
		],
		comments: async () => [{ id: "k1", text: "예뻐요", username: "fan", timestamp: "2026-10-22T12:00:00+0000", replies: [] }],
		reply: async () => "r",
	};
	const adapter = instagramAdapter(() => api as never);
	const { comments } = await adapter.list(IG, undefined);
	const m1 = comments.find(c => c.thread === "m1")!, m2 = comments.find(c => c.thread === "m2")!;
	expect(m1.postTitle.startsWith("가을 신상 지금 만나요")).toBe(true);
	expect(m1.postTitle.length).toBeLessThanOrEqual(80);
	expect([m1.postLink, m1.thumb]).toEqual(["https://www.instagram.com/p/abc/", "https://img.example/m1.jpg"]);
	expect(m2.postTitle).toBe(FALLBACK_TITLE.instagram);
	expect(await adapter.retitle!(IG, ["m1", "m2"])).toEqual({ m1: { title: m1.postTitle, link: "https://www.instagram.com/p/abc/", thumb: "https://img.example/m1.jpg" } });
});

test("what only the owner can decide is asked once inside the card's question, not as a line above it (owner 2026-10-26)", () => {
	const c = { id: "c1", source: "website", thread: "t", author: "가나", text: "언제 만나요?", postTitle: "모임 안내", at: NOW } as any;
	const d = { code: "R1", commentId: "c1", text: "다음 주에 봬요", notes: ["확인: 날짜를 적지 않았어요", "정해 주세요: 모임 날짜 (요일)"] } as any;
	const ask = commentAsk({ ...YT, kind: "website", key: "website" }, c, d);
	expect(ask).not.toContain("정해 주세요");
	expect(ask).toContain("-# 확인: 날짜를 적지 않았어요");
	expect(ask).toContain("이 답글 올릴까요? 정할 것: 모임 날짜 요일");
});

