// Comment <-> mail matching: the scoring (same person only by name, a post-only match is someone else), the card lines, and the engine putting
// them on a draft only for a source with `mailMatch` on. The mailbox is a fake: nothing is searched or read for real.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentId, type CommentAdapter, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";
import { findMail, handleBase, type MailItem, type MailSearch, matchLines, scoreMail } from "./mail-match.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const OWN = "owner@example.com";
const q = { author: "@alice-x1y", postTitle: "Moonlight Waltz | easy arrangement", text: "could I get the score?", at: NOW - 3600_000 };

function mailbox(items: MailItem[], threads: Record<string, string[]> = {}): MailSearch & { queries: string[] } {
	const queries: string[] = [];
	return {
		queries,
		search: async query => (queries.push(query), items),
		read: async id => (threads[id] ?? []).map(from => ({ from, date: "", body: "" })),
		own: async () => new Set([OWN]),
	};
}

test("the commenter's handle is the name to look for", () => {
	expect(handleBase("@alice-x1y")).toBe("alice");
	expect(handleBase("Bob")).toBe("bob");
});

test("a mail is the same person only by name; one that only names the post is someone else's", () => {
	const same = scoreMail({ id: "t1", from: "Alice <a@example.com>", subject: "score please", snippet: "" }, q);
	expect(same.accepted).toBe(true);
	const other = scoreMail({ id: "t2", from: "Carol <c@example.com>", subject: "Moonlight score", snippet: "" }, q);
	expect(other.accepted).toBe(false);
	expect(other.title).toBe("moonlight");
});

test("found and not answered: the card says so and asks for both replies", async () => {
	const box = mailbox([{ id: "t1", from: "Alice <a@example.com>", subject: "Moonlight score", snippet: "" }], { t1: ["Alice <a@example.com>"] });
	const lines = matchLines(await findMail(q, box, NOW));
	expect(lines[0]).toBe("메일 대조: 있음 - Alice <a@example.com> · Moonlight score · 스레드 t1 (답장: 안 보냄)");
	expect(lines[1]).toStartWith("근거: 보낸 사람 이름이 댓글 작성자(alice)와 같음");
	expect(lines[2]).toStartWith("초안 메모:");
	expect(box.queries.every(x => x.includes("-from:me"))).toBe(true);
});

test("found and answered by the owner; not found names the near miss; a search failure is a line, not a throw", async () => {
	const answered = await findMail(q, mailbox([{ id: "t1", from: "Alice <a@example.com>", subject: "hi", snippet: "" }], { t1: ["Alice <a@example.com>", `Owner <${OWN}>`] }), NOW);
	expect(matchLines(answered)).toHaveLength(2);
	expect(matchLines(answered)[0]).toContain("(답장: 보냄)");
	const near = matchLines(await findMail(q, mailbox([{ id: "t2", from: "Carol <c@example.com>", subject: "Moonlight score", snippet: "" }]), NOW));
	expect(near[0]).toBe("메일 대조: 못 찾음");
	expect(near[1]).toContain("같은 글을 말한 다른 사람 메일은 있음: Carol <c@example.com>");
	const broken: MailSearch = { ...mailbox([]), search: async () => Promise.reject(new Error("zele mail search: not authenticated")) };
	expect(matchLines(await findMail(q, broken, NOW))).toEqual(["메일 대조: 확인 실패 - zele mail search: not authenticated"]);
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mail-match-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the engine adds the lines to the draft only when the source turned mailMatch on", async () => {
	const draftJson = `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body: "Thanks, sending it soon.", questions: [] })}\n\`\`\``;
	const run = async (on: boolean) => {
		const sub = join(dir, String(on));
		const src: SourceConfig = { key: "youtube", kind: "youtube", label: "y", watch: ["*"], autoDraft: false, ...(on ? { mailMatch: true } : {}) };
		const adapter: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [{ native: "c1", thread: "p1", author: q.author, text: q.text, postTitle: q.postTitle, at: q.at }] }), reply: async () => ({ ok: true }) };
		const asked: string[] = [];
		const engine = createEngine({ dir: sub, now: () => NOW, collector: "m", adapters: { youtube: adapter }, model: async (_s, user) => (asked.push(user), { text: draftJson }), mailMatch: async () => ["메일 대조: 못 찾음", "근거: none"] });
		engine.store.saveConfig({ enabled: true, sources: { youtube: src } });
		await engine.collect({ force: true });
		const step = await engine.makeDraft(commentId("youtube", "c1"));
		if (!step.ok) throw new Error(step.reason);
		return { notes: step.draft.notes, prompt: asked[0]! };
	};
	const on = await run(true);
	expect(on.notes).toEqual(["메일 대조: 못 찾음", "근거: none"]);
	expect(on.prompt).toContain("메일 대조: 못 찾음");
	expect((await run(false)).notes).toEqual([]);
});
