// Linked mail for a comment that asks for a file (engine.ts linkMail, per-source `autoMail`): off by default, one card with the reply and the mail,
// the comment item's mail mark, and the link-mail backfill. Everything is injected: nothing is posted or sent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentAsk } from "./ask.ts";
import { type CommentAdapter, commentId, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine, MAIL_NO_APP_NOTE, type MailLink, type MailSpec, type MailView } from "./engine.ts";
import { createCommentsWeb } from "./web.ts";

const NOW = Date.parse("2026-11-02T00:00:00.000Z");
const ASKS = "문서 부탁드립니다. Fan@Example.com 입니다";
const raw = (native: string, text: string): RawComment => ({ native, thread: "p1", author: "팬", text, postTitle: "숲과 나나미 요약", at: NOW - 1000 });
const reply = `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body: "메일로 보내드릴게요", questions: [] })}\n\`\`\``;
const base: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: true };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "auto-mail-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeMail(o: { miss?: boolean; failSend?: string; failCompose?: string } = {}) {
	const specs: MailSpec[] = [];
	const status = new Map<string, string>();
	const views = new Map<string, MailView>();
	const link: MailLink = {
		compose: async spec => {
			if (o.failCompose) return { ok: false, reason: o.failCompose };
			const id = `M${specs.push(spec)}`;
			status.set(id, "pending");
			views.set(id, { id, to: spec.to, subject: spec.subject, body: spec.body, attachments: o.miss ? [] : [{ name: "score.pdf", size: 2048 }] });
			return { ok: true, id, notes: [], ...(o.miss ? { libraryMiss: true } : {}) };
		},
		state: id => status.get(id),
		send: async id => {
			if (o.failSend) return { ok: false, text: o.failSend };
			status.set(id, "sent");
			return { ok: true, text: "메일을 보냈어요" };
		},
		drop: id => void status.set(id, "dropped"),
		revise: async id => ({ ok: true, id }),
		view: id => (status.get(id) === "pending" ? views.get(id) : undefined),
	};
	return { link, specs };
}

function setup(o: { source?: Partial<SourceConfig>; text?: string; mail?: Parameters<typeof fakeMail>[0]; noMail?: boolean } = {}) {
	const source: SourceConfig = { ...base, ...o.source };
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [raw("c1", o.text ?? ASKS)], cursor: "1" }),
		reply: async () => ({ ok: true, ref: "r1" }),
		posts: async () => [],
	};
	const mail = fakeMail(o.mail);
	const engine = createEngine({ dir, now: () => NOW, collector: "mac-a", adapters: { youtube: adapter }, model: async () => ({ text: reply }), ...(o.noMail ? {} : { mail: mail.link }) });
	return { engine, mail, source, id: commentId("youtube", "c1") };
}
const pendingOf = (t: ReturnType<typeof setup>) => t.engine.store.drafts().filter(d => d.status === "pending");

describe("autoMail", () => {
	test("off (default): the reply draft has no mail, even for a file ask with an address", async () => {
		const t = setup({ source: { mailApp: "mail" } });
		const out = await t.engine.collect({ force: true });
		expect(out.drafted).toHaveLength(1);
		expect(out.drafted[0]!.mail).toBeUndefined();
		expect(t.mail.specs).toHaveLength(0);
	});

	test("on + file ask + address: one card with the reply and the mail, written to the address as typed", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" } });
		const out = await t.engine.collect({ force: true });
		expect(out.drafted).toHaveLength(1);
		const d = pendingOf(t)[0]!;
		expect(d).toMatchObject({ mail: "M1", clean: false, notes: [] });
		expect(t.mail.specs).toHaveLength(1);
		expect(t.mail.specs[0]).toMatchObject({ app: "mail", to: "Fan@Example.com" });
		// the library is searched with the post title and the comment words
		expect(t.mail.specs[0]!.fromLibrary).toContain("숲과 나나미 요약");
		expect(t.mail.specs[0]!.fromLibrary).toContain("문서");
		const text = commentAsk(t.source, t.engine.store.comments()[0]!, d, undefined, t.engine.mailView(d));
		expect(text).toContain("메일 초안 작성됨");
		expect(text).toContain("> 첨부: score.pdf");
		expect(t.mail.specs[0]!.library).toBeUndefined();
	});

	test("a writer who says he asked it gets the MR only (library: mr)", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, text: "문서 요청했는데 MR도 보내주세요 Fan@Example.com" });
		await t.engine.collect({ force: true });
		expect(t.mail.specs[0]).toMatchObject({ library: "mr" });
	});

	test("library miss: the card gets a 확인 line", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, mail: { miss: true } });
		await t.engine.collect({ force: true });
		const d = pendingOf(t)[0]!;
		expect(d.mail).toBe("M1");
		expect(d.notes).toEqual(["확인: 첨부 파일 폴더에서 맞는 파일을 찾지 못했어요"]);
	});

	test("no address, no file ask, or no mail link: no mail", async () => {
		for (const o of [{ text: "문서 부탁드립니다" }, { text: "영상 잘 봤어요. a@b.com" }, { noMail: true }]) {
			rmSync(dir, { recursive: true, force: true });
			const t = setup({ source: { autoMail: true, mailApp: "mail" }, ...o });
			await t.engine.collect({ force: true });
			expect(pendingOf(t)).toHaveLength(1);
			expect(pendingOf(t)[0]!.mail).toBeUndefined();
			expect(pendingOf(t)[0]!.notes).toEqual([]);
			expect(t.mail.specs).toHaveLength(0);
		}
	});

	test("no mail app configured: no mail, and the card says so", async () => {
		const t = setup({ source: { autoMail: true } });
		await t.engine.collect({ force: true });
		const d = pendingOf(t)[0]!;
		expect(d.mail).toBeUndefined();
		expect(d.notes).toEqual([MAIL_NO_APP_NOTE]);
		expect(t.mail.specs).toHaveLength(0);
	});

	test("a mail that cannot be composed leaves the reply draft with a 확인 line", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, mail: { failCompose: "그런 메일 앱이 없어요" } });
		await t.engine.collect({ force: true });
		const d = pendingOf(t)[0]!;
		expect(d.mail).toBeUndefined();
		expect(d.notes).toEqual(["확인: 메일 초안을 만들지 못했어요 - 그런 메일 앱이 없어요"]);
	});
});

describe("mail mark on the comment item", () => {
	const markOf = (t: ReturnType<typeof setup>) => t.engine.threadView("youtube", "p1")!.comments.find(c => c.id === t.id) as { mail?: { state: string; label: string } };

	test("pending: 메일 초안 작성됨; sent: 메일 보냄; failed: 메일 실패 with the reason", async () => {
		for (const [failSend, state, label] of [[undefined, "sent", "메일 보냄"], ["받는이가 거절했어요", "failed", "메일 실패: 받는이가 거절했어요"]] as const) {
			rmSync(dir, { recursive: true, force: true });
			const t = setup({ source: { autoMail: true, mailApp: "mail" }, mail: { failSend } });
			await t.engine.collect({ force: true });
			expect(markOf(t).mail).toEqual({ state: "drafted", label: "메일 초안 작성됨" });
			expect(t.engine.pendingDrafts()[0]).toMatchObject({ mailMark: { state: "drafted" } });
			const r = t.engine.send(pendingOf(t)[0]!.code, { by: "owner" });
			if (!r.ok) throw new Error(r.reason);
			await r.done;
			expect(markOf(t).mail).toEqual({ state, label });
		}
	});

	test("answered outside the app: the detached mail draft keeps showing 메일 초안 작성됨", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" } });
		await t.engine.collect({ force: true });
		t.engine.noReply(t.id);
		await t.engine.reconcile();
		expect(t.engine.store.drafts()[0]).toMatchObject({ status: "answered", mailKept: "M1" });
		expect(markOf(t).mail).toEqual({ state: "drafted", label: "메일 초안 작성됨" });
	});

	test("a comment without a linked mail has no mark", async () => {
		const t = setup({ source: { mailApp: "mail" } });
		await t.engine.collect({ force: true });
		expect(markOf(t).mail).toBeUndefined();
	});
});

describe("POST /api/comments/link-mail", () => {
	const call = async (web: ReturnType<typeof createCommentsWeb>, body: unknown) => {
		const url = new URL("http://hub/api/comments/link-mail");
		const res = await web.route(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, ["api", "comments", "link-mail"]);
		return { status: res!.status, json: (await res!.json()) as Record<string, unknown> };
	};

	test("backfills an existing draft with one mail, and a second call keeps that one", async () => {
		const t = setup({ source: { autoDraft: false, mailApp: "mail" } });
		await t.engine.collect({ force: true });
		const made = await t.engine.makeDraft(t.id);
		if (!made.ok) throw new Error(made.reason);
		expect(made.draft.mail).toBeUndefined();
		const web = createCommentsWeb({ engine: t.engine, broadcast: () => {} });
		expect(await call(web, { code: made.draft.code })).toEqual({ status: 200, json: { ok: true, mail: "M1" } });
		expect(await call(web, { code: made.draft.code })).toEqual({ status: 200, json: { ok: true, mail: "M1", existing: true } });
		expect(t.mail.specs).toHaveLength(1);
		expect(pendingOf(t)[0]).toMatchObject({ mail: "M1", clean: false });
	});

	test("answers the reason when nothing was linked, and 404 for an unknown draft", async () => {
		const t = setup({ source: { autoDraft: false, mailApp: "mail" }, text: "문서 부탁드립니다" });
		await t.engine.collect({ force: true });
		const made = await t.engine.makeDraft(t.id);
		if (!made.ok) throw new Error(made.reason);
		const web = createCommentsWeb({ engine: t.engine, broadcast: () => {} });
		expect((await call(web, { code: made.draft.code })).json).toEqual({ ok: false, skipped: "댓글에 메일 주소가 없어요" });
		expect((await call(web, { code: "Dnone" })).status).toBe(404);
		expect((await call(web, {})).status).toBe(400);
	});
});
