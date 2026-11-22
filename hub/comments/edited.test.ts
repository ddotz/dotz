import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommentAdapter, commentId, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine, type MailLink, type MailView } from "./engine.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const MAIL = { app: "mail", to: "old@example.com", subject: "문서 보내드립니다", body: "안녕하세요.\n요청하신 문서를 보내드립니다.", attach: ["/files/brief.pdf"] };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "edited-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function world() {
	let text = "문서 받을 수 있나요? old@example.com";
	const raw = (): RawComment => ({ native: "c1", thread: "p1", author: "팬", text, postTitle: "Post one", at: NOW - 1000 });
	const adapter: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [raw()], cursor: "1" }), reply: async () => ({ ok: true, ref: "r1" }), posts: async () => [] };
	const drafts = new Map<string, MailView>();
	const mail: MailLink = {
		compose: async spec => (drafts.set("M1", { id: "M1", to: spec.to, subject: spec.subject, body: spec.body, attachments: [] }), { ok: true, id: "M1" }),
		send: async () => ({ ok: true, text: "메일을 보냈어요" }),
		drop: id => void drafts.delete(id),
		revise: async () => ({ ok: false, reason: "unused" }),
		retarget: (id, to) => void (drafts.has(id) && drafts.set(id, { ...drafts.get(id)!, to })),
		view: id => drafts.get(id),
	};
	const engine = createEngine({ dir, now: () => NOW, collector: "mac-a", adapters: { youtube: adapter }, mail });
	return { engine, mail, edit: (next: string) => void (text = next), id: commentId("youtube", "c1") };
}

test("the author's edit updates the stored text, notes the waiting draft and re-aims its mail at the new address (CM-11)", async () => {
	const w = world();
	await w.engine.collect({ force: true });
	const s = await w.engine.addDraft(w.id, "문서는 메일로 보내 드릴게요", undefined, MAIL);
	if (!s.ok) throw new Error(s.reason);
	expect(w.mail.view("M1")?.to).toBe("old@example.com");

	w.edit("문서 받을 수 있나요? new@example.com");
	await w.engine.collect({ force: true });

	expect(w.engine.store.comments().find(c => c.id === w.id)?.text).toBe("문서 받을 수 있나요? new@example.com");
	const d = w.engine.store.drafts().find(x => x.code === s.draft.code)!;
	expect(d.notes.some(n => n.includes("원댓글이 수정됐어요"))).toBe(true);
	expect(d.clean).toBe(false);
	expect(w.mail.view("M1")?.to).toBe("new@example.com");
	expect(d.notes.filter(n => n.includes("원문에 적힌 주소"))).toEqual([]);
});

test("an edit that leaves the address alone still notes the draft once, and reading it again changes nothing", async () => {
	const w = world();
	await w.engine.collect({ force: true });
	const s = await w.engine.addDraft(w.id, "문서는 메일로 보내 드릴게요", undefined, MAIL);
	if (!s.ok) throw new Error(s.reason);

	w.edit("문서 받을 수 있을까요? old@example.com");
	await w.engine.collect({ force: true });
	await w.engine.collect({ force: true });

	const d = w.engine.store.drafts().find(x => x.code === s.draft.code)!;
	expect(d.notes.filter(n => n.includes("원댓글이 수정됐어요"))).toHaveLength(1);
	expect(w.mail.view("M1")?.to).toBe("old@example.com");
	expect(w.engine.store.comments().find(c => c.id === w.id)?.text).toBe("문서 받을 수 있을까요? old@example.com");
});
