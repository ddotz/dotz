// The owner's past replies: the closest pairs always reach the prompt as examples; with `pastSeed` an empty or skipped model reply takes the closest
// past answer with a 확인 필요 note, and without it a skip still makes no draft. A bot draft sent unchanged is not one of his past replies.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentId, type CommentAdapter, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";
import { closeness, habitsOf, mergePast, type PastPair, pastPairs, SEEDED_NOTE, similarPairs, withExamples } from "./past.ts";
import type { Draft, Reply } from "./store.ts";

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

const DAY = 86_400_000;
const QUERY = "where is the backing track";
const pair = (comment: string, reply: string, ageDays: number, o: Partial<PastPair> = {}): PastPair => ({ comment, reply, at: NOW - ageDays * DAY, thread: "", ...o });
const best = (pairs: PastPair[]) => similarPairs(QUERY, pairs, 1, undefined, NOW)[0]?.reply;

test("a newer pair beats an older pair of equal text; a much closer old pair still beats a newer weak one", () => {
	expect(best([pair(QUERY, "old", 400), pair(QUERY, "new", 1)])).toBe("new");
	expect(best([pair(QUERY, "new", 1), pair(QUERY, "old", 400)])).toBe("new");
	expect(best([pair(QUERY, "close-old", 400), pair("backing music later maybe", "weak-new", 0)])).toBe("close-old");
});

test("an edited pair beats an equal plain pair; a far weaker edited pair does not beat a close plain one; no shared words stays out", () => {
	expect(best([pair(QUERY, "plain", 1), pair(QUERY, "edited", 1, { edited: true })])).toBe("edited");
	expect(best([pair("backing music later maybe", "edited-weak", 1, { edited: true }), pair(QUERY, "plain-close", 1)])).toBe("plain-close");
	expect(best([pair("zzzz qqqq", "edited-unrelated", 0, { edited: true })])).toBeUndefined();
});

test("habits are measured over the newest 300 replies only", () => {
	const newest = Array.from({ length: 300 }, () => "Thanks! ^^");
	const older = Array.from({ length: 100 }, () => "Dear sir, kind regards.");
	expect(habitsOf([...newest, ...older])).toEqual(habitsOf(newest));
	expect(habitsOf([...newest, ...older])).not.toEqual(habitsOf([...older, ...newest]));
});

test("a sent reply whose draft was changed by hand is marked edited, also when it is stored as his own comment too; a trimmed draft leaves it plain", () => {
	const comments = [...history, { native: "n1r", thread: "p1", parent: "n1", author: "me", text: "Here it is.", postTitle: "P", at: NOW - 500, mine: true }].map(r => ({ ...r, id: commentId("youtube", r.native), source: "youtube", mine: r.mine === true, collector: "m" }));
	const sent: Reply = { id: "send:n1", commentId: commentId("youtube", "n1"), source: "youtube", thread: "p1", text: "Here it is.", state: "sent", at: NOW - 400, draft: "D7", via: "owner", collector: "m" };
	const draft = (changes: string[]): Draft => ({ code: "D7", commentId: sent.commentId, source: "youtube", thread: "p1", text: "Here it is.", status: "sent", created: NOW, changes, clean: true, notes: [] });
	const mark = (drafts: Draft[]) => pastPairs(comments, [sent], "youtube", drafts).find(p => p.reply === "Here it is.")?.edited;
	expect(mark([draft(["shorter"])])).toBe(true);
	expect(mark([])).toBeUndefined();
});

test("merging keeps one copy of a repeat and the mark or sender any copy had", () => {
	const merged = mergePast([pair("Q?", "A.", 1, { edited: true, from: "x" })], [pair("q?", "a. ", 0)]);
	expect(merged).toMatchObject([{ edited: true, from: "x", at: NOW }]);
});

test("the prompt's closeness is the plain similarity of the shown pairs: recency and hand edits only rank them", () => {
	const twin = pair("문서 파일을 받을 수 있을까요", "네", 0, { edited: true });
	const other = pair("공연 잘 봤습니다 감사합니다", "감사해요", 400);
	expect(closeness(twin.comment, [other, twin])).toBeCloseTo(1, 5);
	expect(closeness("완전히 다른 이야기", [other])).toBe(0);
	expect(closeness("문서", [])).toBe(0);
	const style = { samples: [], rules: [], corrections: [], forbidden: [] };
	expect(withExamples(style, [other, twin], [], twin.comment).closest).toBeCloseTo(1, 5);
	expect(withExamples(style, [], [], twin.comment).closest).toBeUndefined();
});
