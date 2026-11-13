// The mail and webmail adapter on a temp data dir (design 1.8): the store's statuses as the one view, and every action over the real flow.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDraft, getDraft, setStatus, type DraftRec } from "../features/reply-drafts/lib/store.ts";
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
