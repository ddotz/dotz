import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runWatch } from "../../features/comments/bin/watch.ts";
import { type CommentAdapter, type RawComment, type ReplyOutcome, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";

const NOW = Date.parse("2026-11-19T00:00:00.000Z");
const draftOf = (body: string) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [] })}\n\`\`\``;
const skipped = `\`\`\`json\n${JSON.stringify({ action: "skip", reason: "no answer needed", to: "", body: "", questions: [] })}\n\`\`\``;
const raw = (native: string, o: Partial<RawComment> = {}): RawComment => ({ native, thread: "p1", author: "팬", text: `질문 ${native}이에요?`, postTitle: "영상", at: NOW - 1000, ...o });
const RULE: Partial<SourceConfig> = { autoDraft: true, autoSince: 0, autoSend: { on: true, match: ["질문"], max_per_day: 5 } };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comments-news-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function world(source: Partial<SourceConfig>, model: (user: string) => string = () => draftOf("고마워요")) {
	const src: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, ...source };
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: src } }));
	const state = { pages: [] as RawComment[][], outcome: { ok: true, ref: "r1" } as ReplyOutcome, posted: 0, now: NOW };
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: state.pages.shift() ?? [] }),
		reply: async () => (state.posted++, state.outcome),
	};
	const engine = createEngine({ dir, now: () => state.now, collector: "t", adapters: { youtube: adapter }, model: async (_s, user) => ({ text: model(user) }) });
	return { engine, state };
}

describe("a reply an auto-send rule posted that did not go out", () => {
	test.each([
		["failed", { ok: false, reason: "플랫폼이 거절했어요", code: "rejected", sent: "no" }, "올리지 못했어요"],
		["unsure", { ok: false, reason: "올라갔는지 모르겠어요", code: "unknown", sent: "maybe" }, "확인되지 않았어요"],
	] as const)("%s: it is not in the sent list, its draft keeps the card, and an alert line says why", async (_name, outcome, wording) => {
		const w = world(RULE);
		w.state.outcome = outcome;
		w.state.pages = [[raw("c1")]];
		const lines = await runWatch(dir, w.engine, async () => {}, Date.now() + 240_000);
		expect(w.state.posted).toBe(1);
		expect(w.engine.store.drafts().map(d => d.status)).toEqual(["pending"]);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toStartWith("[fail] ");
		expect(lines[0]).toContain(wording);
		expect(lines[0]).toContain(outcome.reason);
		expect(lines[1]).toStartWith("[ask]");
		expect(lines[1]).toContain(w.engine.store.drafts()[0]!.code);
	});

	test("collect keeps it out of `sent` and reports an alert for it", async () => {
		const w = world(RULE);
		w.state.outcome = { ok: false, reason: "플랫폼이 거절했어요", code: "rejected", sent: "no" };
		w.state.pages = [[raw("c1")]];
		const r = await w.engine.collect({ force: true });
		expect(r.sent).toEqual([]);
		expect(r.notices.map(n => n.kind)).toEqual(["alert"]);
	});

	test("one that went out leaves the card and tells nothing", async () => {
		const w = world(RULE);
		w.state.pages = [[raw("c1")]];
		const lines = await runWatch(dir, w.engine, async () => {}, Date.now() + 240_000);
		expect(lines).toEqual([]);
		expect(w.engine.store.drafts().map(d => d.status)).toEqual(["sent"]);
	});
});

describe("comments the owner must know about reach the notice path", () => {
	test("a new comment that waits for an answer is one news line with the source's label, not on the first read", async () => {
		const w = world({});
		w.state.pages = [[raw("c1")], [raw("c1"), raw("c2", { author: "새 팬" })]];
		expect((await w.engine.collect({ force: true })).notices).toEqual([]);
		w.state.now += 6 * 60_000;
		const lines = await runWatch(dir, w.engine, async () => {}, Date.now() + 240_000);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith("유튜브 댓글: ");
		expect(lines[0]).toContain("새 팬");
		expect(lines[0]).not.toStartWith("[");
	});

	test("a draft card is the notice of its own comment: only a comment with no card makes a news line", async () => {
		const w = world({ autoDraft: true, autoSince: 0 }, user => (user.includes("c2") ? skipped : draftOf("고마워요")));
		w.state.pages = [[raw("c0")], [raw("c1"), raw("c2")]];
		await w.engine.collect({ force: true });
		const r = await w.engine.collect({ force: true });
		expect(r.drafted.map(d => d.commentId)).toEqual(["cm:youtube:c1"]);
		expect(r.notices).toHaveLength(1);
		expect(r.notices[0]).toMatchObject({ kind: "news" });
		expect(r.notices[0]!.text).not.toContain("c1");
		expect(r.notices[0]!.text).toContain("질문 c2이에요?");
	});

	test("a comment that already has a draft card makes no news line at all", async () => {
		const w = world({ autoDraft: true, autoSince: 0 });
		w.state.pages = [[raw("c0")], [raw("c1")]];
		await w.engine.collect({ force: true });
		const r = await w.engine.collect({ force: true });
		expect(r.drafted).toHaveLength(1);
		expect(r.notices).toEqual([]);
	});
});
