// The mail and webmail adapter on a temp data dir (design 1.8): the store's statuses as the one view, and every action over the real flow.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDraft, getDraft, setStatus, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { commentsDir, createStore } from "./comments/store.ts";
import { mailAdapter } from "./reply-mail.ts";

const dir = mkdtempSync(join(tmpdir(), "reply-mail-"));
const before = process.env.DOTZ_DIR;
process.env.DOTZ_DIR = dir;
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});
beforeEach(() => {
	rmSync(join(dir, "custom"), { recursive: true, force: true });
	mkdirSync(join(dir, "custom", "reply-drafts"), { recursive: true });
	writeFileSync(join(dir, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true }));
});

const rec = (o: Partial<DraftRec> = {}): DraftRec =>
	({ id: "RMAILAA", kind: "mail", app: "mail", source: "zele", account: "me@example.net", mailId: "m1", ref: "k1", to: "kim@example.com", subject: "Re: 문의", body: "확인해 보고 말씀드릴게요.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", text: "문의드립니다", from: "Kim <kim@example.com>", subject: "문의" }, ...o }) as unknown as DraftRec;
const reply = (body: string, lesson = "") => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 문의", body, questions: [], lesson })}\n\`\`\``;

test("get and list read the store's statuses as the one view; a ref of another kind is not this adapter's", async () => {
	const a = mailAdapter();
	addDraft(rec());
	addDraft(rec({ id: "RMAILBB", ref: "k2", source: "webmail:corp", status: "answered" }));
	expect(await a.get("RMAILAA")).toMatchObject({ item: "mail:k1", kind: "mail", conv: "mail:k1", draft: { state: "pending", text: "확인해 보고 말씀드릴게요." }, can: { send: true, restore: false } });
	expect(await a.get("RMAILBB")).toMatchObject({ kind: "webmail", draft: { state: "closed" } });
	expect((await a.list()).map(v => v.ref)).toEqual(["RMAILAA"]);
	expect(await a.get("Dabcdef")).toBeUndefined();
	expect(a.target("RMAILAA")).toEqual({ kind: "mail", lane: "mail:zele:me@example.net" });
	expect(a.target("RMAILBB")).toEqual({ kind: "mail", lane: "mail:corp" });
});

test("a mail draft carried by a pending comment reply is left to that reply's card and is not listed on its own", async () => {
	const a = mailAdapter();
	addDraft(rec());
	addDraft(rec({ id: "RMAILBB", ref: "k2" }));
	const comments = createStore(commentsDir(dir));
	comments.putDraft({ code: "Dlinked", commentId: "c1", source: "youtube", thread: "t1", text: "메일로 보내드렸어요", status: "pending", created: Date.now(), changes: [], clean: true, notes: [], mail: "RMAILBB" });
	expect((await a.list()).map(v => v.ref)).toEqual(["RMAILAA"]);
	// The reply's card still reads the mail draft by its id.
	expect((await a.get("RMAILBB"))?.draft.state).toBe("pending");
	// Once the reply is no longer pending, the mail is a card of its own again.
	comments.putDraft({ ...comments.drafts().find(d => d.code === "Dlinked")!, status: "dropped" });
	expect((await a.list()).map(v => v.ref).sort()).toEqual(["RMAILAA", "RMAILBB"]);
});

test("revise stores a new draft that names the one it replaced and returns the lesson without recording it", async () => {
	addDraft(rec());
	const a = mailAdapter(() => ({ call: async () => reply("목요일까지 보내드릴게요.", "마감은 넉넉히 잡아서 쓴다") }));
	const r = await a.revise("RMAILAA", "마감을 목요일로");
	expect(r).toMatchObject({ ok: true, replaces: "RMAILAA", lesson: { line: "마감은 넉넉히 잡아서 쓴다" } });
	const next = r.ok ? await a.get(r.ref) : undefined;
	expect(next?.draft).toMatchObject({ state: "pending", text: "목요일까지 보내드릴게요.", replaces: { ref: "RMAILAA", text: "확인해 보고 말씀드릴게요." } });
	expect(getDraft("RMAILAA")?.status).toBe("stale");
	expect(await Bun.file(join(dir, "custom", "reply-drafts", "tone", "mail.md")).exists()).toBe(false);
});

test("edit stores the owner's text as written; drop then restore; markSent; prove says sent only for a sent or answered draft", async () => {
	const a = mailAdapter();
	addDraft(rec());
	expect(await a.edit("RMAILAA", "제가 쓴 그대로예요 :)")).toEqual({ ok: true });
	expect((await a.get("RMAILAA"))!.draft).toMatchObject({ text: "제가 쓴 그대로예요 :)", edited: true });
	expect(await a.prove!("RMAILAA")).toBe("unknown");
	expect(await a.drop("RMAILAA")).toEqual({ ok: true });
	expect((await a.get("RMAILAA"))!.draft.state).toBe("dropped");
	expect(await a.restore("RMAILAA")).toEqual({ ok: true });
	expect(await a.markSent("RMAILAA")).toEqual({ ok: true });
	expect(await a.prove!("RMAILAA")).toBe("sent");
	addDraft(rec({ id: "RMAILCC" }));
	setStatus("RMAILCC", "answered");
	expect(await a.prove!("RMAILCC")).toBe("sent");
});

test("repair adds Re: to a subject without it and leaves a login to the owner; the card question names the ref", async () => {
	const a = mailAdapter();
	addDraft(rec({ subject: "문의" }));
	expect(await a.repair!("RMAILAA", "subject_re")).toBe("fixed");
	expect(getDraft("RMAILAA")?.subject).toBe("Re: 문의");
	expect(await a.repair!("RMAILAA", "login_expired")).toBe("needs_owner");
	expect(a.question("RMAILAA")).toBe("이 답장 보낼까요? (RMAILAA)");
	expect(await a.ask("RMAILAA")).toContain("(RMAILAA)");
});

test("a reply that kept no text of the mail it answers quotes that mail from the mail record, as a comment quotes its comment", async () => {
	// The reply the owner writes under an open mail (hub/mail-manual.ts) stores the sender and no text of the mail.
	const mails: Record<string, { from: string; subject: string; summary?: string; preview?: string }> = { k1: { from: "Kim <kim@example.com>", subject: "문의", summary: "자료 요청", preview: "자료 금요일까지 되나요?" } };
	const a = mailAdapter(undefined, key => mails[key]);
	addDraft(rec({ item: { kind: "mail", from: "Kim <kim@example.com>", text: "" } as DraftRec["item"] }));
	expect((await a.get("RMAILAA"))!.original).toEqual({ who: "Kim <kim@example.com>", text: "자료 금요일까지 되나요?", subject: "문의" });
	// A draft that carries the mail's text keeps it; a mail without a preview falls back to its summary, then its subject.
	addDraft(rec({ id: "RMAILBB", ref: "k2" }));
	expect((await a.get("RMAILBB"))!.original).toEqual({ who: "Kim <kim@example.com>", text: "문의드립니다", subject: "문의" });
	mails.k3 = { from: "Lee <lee@example.com>", subject: "일정" };
	addDraft(rec({ id: "RMAILCC", ref: "k3", item: { kind: "mail", from: "", text: "" } as DraftRec["item"] }));
	expect((await a.get("RMAILCC"))!.original).toEqual({ who: "Lee <lee@example.com>", text: "일정", subject: "일정" });
});
