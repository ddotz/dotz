// 고치기 on a comment card that carries a mail: the mail and its files follow a plain revise that talks about them, and the mail stays on the
// card when its own revise runs at the same time as the reply's. Everything is injected (adapter, model, mail link): nothing is posted or sent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommentAdapter, commentId, type SourceConfig } from "./contract.ts";
import { createEngine, type MailLink, type MailView } from "./engine.ts";
import { addRecord } from "../../features/reply-drafts/lib/ledger.ts";

const NOW = Date.parse("2026-11-25T00:00:00.000Z");
const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const MAIL = { app: "mail", to: "fan@example.com", subject: "자료 보내드립니다", body: "안녕하세요.\n요청하신 자료입니다.", attach: ["/files/파일A.mp3", "/files/파일C.pdf"] };
const reply = (body: string) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [] })}\n\`\`\``;
const FILES = ["파일A.mp3", "파일B.mp3", "파일C.pdf", "곡B.mp3"];

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "riding-mail-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Like the real mail link: a revise makes a new draft and the old one is no longer pending (its view is gone). The files become the ones the
// change names ("<name> 빼" removes it), and `asked` keeps what each revise was told. `hold` parks a revise until released. Like the model told
// to keep what the owner's words do not touch, the body changes only when his words (the ask's first paragraph) name a file or the mail.
function fakeMail(rule?: MailView["rule"]) {
	const drafts = new Map<string, MailView>();
	const asked: string[] = [];
	let n = 0;
	let hold: Promise<void> | undefined;
	const link: MailLink = {
		compose: async spec => {
			const id = `M${++n}`;
			drafts.set(id, { id, to: spec.to, subject: spec.subject, body: spec.body, attachments: (spec.attach ?? []).map(p => ({ name: p.split("/").pop()! })), ...(rule ? { rule } : {}) });
			return { ok: true, id };
		},
		send: async () => ({ ok: true, text: "메일을 보냈어요" }),
		drop: id => void drafts.delete(id),
		revise: async (id, change) => {
			asked.push(change);
			await hold;
			const v = drafts.get(id);
			if (!v) return { ok: false, reason: "gone" };
			const named = FILES.filter(f => change.includes(f.split(".")[0]!));
			const removed = named.filter(f => new RegExp(`${f.split(".")[0]}\\S*\\s*(빼|없애)`).test(change));
			const kept = v.attachments.filter(f => !removed.includes(f.name));
			const attachments = [...kept, ...named.filter(f => !removed.includes(f) && !kept.some(k => k.name === f)).map(name => ({ name }))];
			const next = `M${++n}`;
			drafts.delete(id);
			const words = change.split("\n\n")[0]!;
			drafts.set(next, { ...v, id: next, body: named.length || words.includes("메일") ? `${v.body}\n(${words})` : v.body, attachments });
			return { ok: true, id: next };
		},
		view: id => drafts.get(id),
	};
	return { link, asked, park: () => { let go!: () => void; hold = new Promise(r => (go = r)); return () => { hold = undefined; go(); }; } };
}

async function setup(rule?: MailView["rule"]) {
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [{ native: "c1", thread: "p1", author: "팬", text: "자료 받을 수 있나요? fan@example.com", postTitle: "Post one", at: NOW - 1000 }], cursor: "1" }),
		reply: async () => ({ ok: true, ref: "r1" }),
		posts: async () => [],
	};
	const mail = fakeMail(rule);
	const prompts: string[] = [];
	let modelHold: Promise<void> | undefined;
	const engine = createEngine({
		dir,
		now: () => NOW,
		collector: "mac-a",
		adapters: { youtube: adapter },
		model: async (_system, user) => (prompts.push(user), await modelHold, { text: reply("전체 버전을 먼저 보내드려요.") }),
		broadcast: () => {},
		sent: () => {},
		mail: mail.link,
	});
	await engine.collect({ force: true });
	const s = await engine.addDraft(commentId("youtube", "c1"), "자료는 메일로 보내 드릴게요", undefined, MAIL);
	if (!s.ok) throw new Error(s.reason);
	const parkModel = () => { let go!: () => void; modelHold = new Promise(r => (go = r)); return () => { modelHold = undefined; go(); }; };
	return { engine, mail, draft: s.draft, parkModel, prompts };
}
const names = (v: MailView | undefined) => v?.attachments.map(f => f.name);

describe("a plain 고치기 on a card with a riding mail", () => {
	test("words about the files or the mail change the mail too: its files are swapped and the new reply is mirrored when asked", async () => {
		const t = await setup();
		const r = await t.engine.revise(t.draft.code, "첨부 두 개 다 이상함. 파일C 빼고 파일B를 첨부해야지. 방금 고친 답글 내용을 메일에도 반영해", "reply");
		if (!r.ok) throw new Error(r.reason);
		expect(r.draft.text).toBe("전체 버전을 먼저 보내드려요.");
		expect(r.draft.mail).toBe("M2");
		expect(names(t.engine.mailView(r.draft))).toEqual(["파일A.mp3", "파일B.mp3"]);
		expect(t.mail.asked).toHaveLength(1);
		expect(t.mail.asked[0]).toContain("전체 버전을 먼저 보내드려요.");
		expect(r.draft.changes.at(-1)).toContain("파일B");
	});

	test("words with no mail word still reach the mail: a wrong track is swapped and the card says what changed", async () => {
		const t = await setup();
		const r = await t.engine.revise(t.draft.code, "음원이 잘못 붙었어. 곡B로 다시 골라 줘", "reply");
		if (!r.ok) throw new Error(r.reason);
		expect(t.mail.asked).toHaveLength(1);
		expect(names(t.engine.mailView(r.draft))).toContain("곡B.mp3");
		expect(r.draft.notes).toContain("고친 곳: 답글 바뀜 · 메일 본문 바뀜 · 첨부 바뀜");
	});

	test("a change about the reply alone is still shown to the mail, which stays as it is, and the card says so", async () => {
		const t = await setup();
		const r = await t.engine.revise(t.draft.code, "더 짧게", "reply");
		if (!r.ok) throw new Error(r.reason);
		expect(t.mail.asked).toHaveLength(1);
		const v = t.engine.mailView(r.draft);
		expect(names(v)).toEqual(["파일A.mp3", "파일C.pdf"]);
		expect(v?.body).toBe(MAIL.body);
		expect(r.draft.notes).toContain("고친 곳: 답글 바뀜 · 메일 본문 그대로 · 첨부 그대로");
	});
});

describe("a reply revise and a mail revise of the same card at once", () => {
	test("the mail revised while the reply is rewritten stays on the new card", async () => {
		const t = await setup();
		const go = t.parkModel();
		const replying = t.engine.revise(t.draft.code, "더 짧게", "reply");
		const m = await t.engine.revise(t.draft.code, "파일B를 첨부해", "mail");
		if (!m.ok) throw new Error(m.reason);
		go();
		const r = await replying;
		if (!r.ok) throw new Error(r.reason);
		expect(names(t.engine.mailView(r.draft))).toEqual(["파일A.mp3", "파일C.pdf", "파일B.mp3"]);
		expect(r.draft.notes).toContain("고친 곳: 답글 바뀜 · 메일 본문 그대로 · 첨부 그대로");
	});

	test("the reply rewritten while the mail is revised: the revised mail moves to the new card", async () => {
		const t = await setup();
		const go = t.mail.park();
		const mailing = t.engine.revise(t.draft.code, "파일B를 첨부해", "mail");
		const r = await t.engine.revise(t.draft.code, "더 짧게", "reply");
		if (!r.ok) throw new Error(r.reason);
		expect(t.mail.asked).toHaveLength(1);
		go();
		const m = await mailing;
		if (!m.ok) throw new Error(m.reason);
		const now = t.engine.store.drafts().find(x => x.status === "pending")!;
		expect(now.code).toBe(r.draft.code);
		expect(now.mail).toBe("M2");
		expect(names(t.engine.mailView(now))).toEqual(["파일A.mp3", "파일C.pdf", "파일B.mp3"]);
	});
});

describe("a comment card whose mail met an 자동 초안 규칙 (request kind)", () => {
	test("the reply is written with that rule's lines, and a lesson taught on it can hold for the request kind", async () => {
		const rule = { app: "mail", id: "r1", name: "자료 요청" };
		addRecord({ text: "용도는 묻지 않기", kind: "request", scope: { app: "mail", request: "r1" }, by: "learn" });
		const t = await setup(rule);
		const r = await t.engine.revise(t.draft.code, "앞으로 용도는 묻지 마", "reply");
		if (!r.ok) throw new Error(r.reason);
		expect(t.prompts.at(-1)).toContain("이 요청 종류(자료 요청)에 정한 것: 용도는 묻지 않기");
		expect(r.lesson?.keys.request).toEqual(rule);
	});
});
