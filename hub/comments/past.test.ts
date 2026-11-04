// The owner's past replies: the closest pairs always reach the prompt as examples; with `pastSeed` an empty or skipped model reply takes the closest
// past answer with a 확인 필요 note, and without it a skip still makes no draft. A bot draft sent unchanged is not one of his past replies.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentId, type CommentAdapter, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";
import { pastPairs, SEEDED_NOTE, similarPairs } from "./past.ts";
import type { Draft } from "./store.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const json = (o: object) => `\`\`\`json\n${JSON.stringify({ reason: "r", to: "", questions: [], ...o })}\n\`\`\``;
const history: RawComment[] = [
	{ native: "h1", thread: "p1", author: "A", text: "Where can I download the backing track?", postTitle: "P", at: NOW - 9e6 },
	{ native: "h1r", thread: "p1", parent: "h1", author: "me", text: "It is linked in the description.", postTitle: "P", at: NOW - 8e6, mine: true },
	{ native: "h2", thread: "p1", author: "B", text: "Lovely performance!", postTitle: "P", at: NOW - 7e6 },
	{ native: "h2r", thread: "p1", parent: "h2", author: "me", text: "Thank you so much!", postTitle: "P", at: NOW - 6e6, mine: true },
	{ native: "n1", thread: "p1", author: "C", text: "where to download the backing track please", postTitle: "P", at: NOW - 1000 },
];

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "past-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function setup(model: string, pastSeed: boolean) {
	const adapter: CommentAdapter = { kind: "youtube", list: async () => ({ comments: history }), reply: async () => ({ ok: true }) };
	const prompts: string[] = [];
	const engine = createEngine({ dir, now: () => NOW, collector: "m", adapters: { youtube: adapter }, model: async (_s, user) => (prompts.push(user), { text: model }) });
	const src: SourceConfig = { key: "youtube", kind: "youtube", label: "y", watch: ["*"], autoDraft: false, ...(pastSeed ? { pastSeed: true } : {}) };
	engine.store.saveConfig({ enabled: true, sources: { youtube: src } });
	await engine.collect({ force: true });
	return { engine, prompts };
}

test("the pairs are the owner's answers under other people's comments, closest first", () => {
	const comments = history.map(r => ({ ...r, id: commentId("youtube", r.native), source: "youtube", mine: r.mine === true, collector: "m" }));
	const pairs = pastPairs(comments, [], "youtube");
	expect(pairs.map(p => p.reply)).toEqual(["It is linked in the description.", "Thank you so much!"]);
	expect(similarPairs("download backing track?", pairs, 1)[0]!.reply).toBe("It is linked in the description.");
});

test("pastSeed: a skip becomes the closest past answer marked 확인 필요", async () => {
	const t = await setup(json({ action: "skip", body: "" }), true);
	const step = await t.engine.makeDraft(commentId("youtube", "n1"));
	expect(step.ok).toBe(true);
	if (!step.ok) return;
	expect(step.draft.text).toBe("It is linked in the description.");
	expect(step.draft.notes).toContain(SEEDED_NOTE);
	expect(step.draft.clean).toBe(false);
});

test("the prompt always carries the similar past answers verbatim; without pastSeed a skip still makes no draft", async () => {
	const t = await setup(json({ action: "skip", body: "" }), false);
	const step = await t.engine.makeDraft(commentId("youtube", "n1"));
	expect(step.ok).toBe(false);
	expect(t.prompts[0]).toContain("<<<REPLY\nIt is linked in the description.\nREPLY>>>");
	expect(t.prompts[0]).toContain("<<<RECEIVED\nWhere can I download the backing track?\nRECEIVED>>>");
	expect(t.prompts[0]).not.toContain("비슷한 지난 댓글");
});

test("a bot draft the owner sent unchanged is not a past reply of his; an edited one is", () => {
	const comments = history.map(r => ({ ...r, id: commentId("youtube", r.native), source: "youtube", mine: r.mine === true, collector: "m" }));
	const draft = (text: string, changes: string[]): Draft => ({ code: "D1", commentId: "x", source: "youtube", thread: "p1", text, status: "sent", created: NOW, changes, clean: true, notes: [] });
	expect(pastPairs(comments, [], "youtube", [draft("Thank  you so much!", [])]).map(p => p.reply)).toEqual(["It is linked in the description."]);
	expect(pastPairs(comments, [], "youtube", [draft("Thank you so much!", ["shorter"])]).map(p => p.reply)).toEqual(["It is linked in the description.", "Thank you so much!"]);
});
