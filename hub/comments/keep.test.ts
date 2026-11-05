import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommentAdapter, commentId, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";
import { createStore, type Draft, type Reply } from "./store.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comments-keep-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const draft = (i: number, status: Draft["status"] = "pending"): Draft => ({ code: `D${i}`, commentId: `c${i}`, source: "youtube", thread: "p1", text: "t", status, created: i, changes: [], clean: true, notes: [] });
const reply = (i: number, state: Reply["state"]): Reply => ({ id: `send:c${i}`, commentId: `c${i}`, source: "youtube", thread: "p1", text: "t", state, at: i, draft: `D${i}`, via: "owner", collector: "a" });

test("a backlog of pending comment drafts is never trimmed; closed ones go oldest first", () => {
	const s = createStore(dir);
	for (let i = 0; i < 350; i++) s.putDraft(draft(i));
	expect(s.drafts()).toHaveLength(350);
	for (let i = 0; i < 350; i++) if (i !== 0) s.setDraftStatus(`D${i}`, "sent");
	s.putDraft(draft(1000));
	const left = s.drafts();
	expect(left.some(d => d.code === "D0")).toBe(true);
	expect(left.some(d => d.code === "D1")).toBe(false);
	expect(left.filter(d => d.status === "sent")).toHaveLength(300);
});

test("a reply that is still sending or failed is never trimmed", () => {
	const s = createStore(dir);
	s.putReply(reply(0, "sending"));
	s.putReply(reply(1, "failed"));
	for (let i = 2; i < 340; i++) s.putReply(reply(i, "sent"));
	const ids = s.replies().map(r => r.id);
	expect(ids).toContain("send:c0");
	expect(ids).toContain("send:c1");
	expect(s.replies().filter(r => r.state === "sent")).toHaveLength(300);
});

test("comments waiting for an auto-draft all stay queued, however many arrive", async () => {
	const src: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: true, autoSince: 0 };
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: src } }));
	const comments: RawComment[] = Array.from({ length: 260 }, (_, i) => ({ native: `c${i}`, thread: "p1", author: "A", text: `q${i}?`, postTitle: "Post", at: NOW - 1000 }));
	const adapter: CommentAdapter = { kind: "youtube", list: async () => ({ comments, cursor: "1" }), reply: async () => ({ ok: true }) };
	const model = async () => ({ text: `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "r", to: "", body: "ok", questions: [] })}\n\`\`\``, inputTokens: 1, outputTokens: 1 });
	const engine = createEngine({ dir, now: () => NOW, collector: "a", adapters: { youtube: adapter }, model });
	const r = await engine.collect({ force: true });
	expect(r.drafted).toHaveLength(5);
	const queue = engine.store.cursors().youtube!.queue!;
	expect(queue).toHaveLength(255);
	expect(queue[0]).toBe(commentId("youtube", "c5"));
});
