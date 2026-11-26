// Linked mail for a comment that asks for a file (engine.ts linkMail, per-source `autoMail`): off by default, one card with the reply and the mail,
// the comment item's mail mark, and the link-mail backfill. Everything is injected: nothing is posted or sent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentAsk } from "./ask.ts";
import { ATTACH_REFUSED } from "../draft-approval.ts";
import { type CommentAdapter, commentId, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine, type MailLink, type MailSpec, type MailView } from "./engine.ts";
import { MAIL_NO_APP_NOTE, NO_TITLE_NOTE } from "./no-mail.ts";
import { createCommentsWeb } from "./web.ts";

const NOW = Date.parse("2026-11-02T00:00:00.000Z");
const ASKS = "문서 부탁드립니다. Fan@Example.com 입니다";
const raw = (native: string, text: string, postTitle = "숲과 나나미 요약"): RawComment => ({ native, thread: "p1", author: "팬", text, postTitle, at: NOW - 1000 });
const reply = `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body: "메일로 보내드릴게요", questions: [] })}\n\`\`\``;
const replyOf = (body: string) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [] })}\n\`\`\``;
const base: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: true };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "auto-mail-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeMail(o: { miss?: boolean; failSend?: string; failCompose?: string; write?: MailLink["write"] } = {}) {
	const specs: MailSpec[] = [];
	const status = new Map<string, string>();
	const views = new Map<string, MailView>();
	const link: MailLink = {
		...(o.write ? { write: o.write } : {}),
		compose: async spec => {
			if (o.failCompose) return { ok: false, reason: o.failCompose };
			const id = `M${specs.push(spec)}`;
			status.set(id, "pending");
			views.set(id, { id, to: spec.to, subject: spec.subject, body: spec.body, attachments: o.miss ? [] : [{ name: "brief.pdf", size: 2048 }] });
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

function setup(o: { source?: Partial<SourceConfig>; text?: string; title?: string; mail?: Parameters<typeof fakeMail>[0]; noMail?: boolean; body?: string } = {}) {
	const source: SourceConfig = { ...base, ...o.source };
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const posted: string[] = [];
	const prompts: string[] = [];
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [raw("c1", o.text ?? ASKS, o.title)], cursor: "1" }),
		reply: async (_s, _c, text) => (posted.push(text), { ok: true, ref: "r1" }),
		posts: async () => [],
	};
	const mail = fakeMail(o.mail);
	const model = async (_system: string, user: string) => (prompts.push(user), { text: o.body === undefined ? reply : replyOf(o.body) });
	const engine = createEngine({ dir, now: () => NOW, collector: "mac-a", adapters: { youtube: adapter }, model, ...(o.noMail ? {} : { mail: mail.link }) });
	return { engine, mail, source, posted, prompts, id: commentId("youtube", "c1") };
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
		expect(t.engine.threads(t.engine.ownerOf(t.source))[0]!.mails).toEqual({ drafted: 1, sent: 0, failed: 0 });
		expect(t.mail.specs).toHaveLength(1);
		expect(t.mail.specs[0]).toMatchObject({ app: "mail", to: "Fan@Example.com" });
		// the post is what is asked for: the library is searched with its title alone
		expect(t.mail.specs[0]!.fromLibrary).toBe("숲과 나나미 요약");
		const text = commentAsk(t.source, t.engine.store.comments()[0]!, d, undefined, t.engine.mailView(d));
		expect(text).toContain("메일 초안 작성됨");
		expect(text).toContain("> 첨부: brief.pdf");
	});

	test("write: its text is the mail body; undefined, empty or a throw keep the fixed text", async () => {
		const bodyWith = async (write: MailLink["write"]) => {
			rmSync(dir, { recursive: true, force: true });
			const t = setup({ source: { autoMail: true, mailApp: "mail" }, mail: { write } });
			await t.engine.collect({ force: true });
			return t.mail.specs[0]!.body;
		};
		const seen: unknown[] = [];
		expect(await bodyWith(async spec => (seen.push(spec), "팩 님, 문서 보냈어요"))).toBe("팩 님, 문서 보냈어요");
		expect(seen).toEqual([{ app: "mail", to: "Fan@Example.com", author: "팬", text: ASKS, postTitle: "숲과 나나미 요약" }]);
		const fixed = await bodyWith(undefined);
		expect(fixed).toContain("팬님");
		expect(await bodyWith(async () => undefined)).toBe(fixed);
		expect(await bodyWith(async () => "  ")).toBe(fixed);
		expect(await bodyWith(async () => { throw new Error("model down"); })).toBe(fixed);
	});

	test("the comment's own words go with the spec, for the install's narrowing rule", async () => {
		const text = "자료 받고 싶어요 보내주세요 Fan@Example.com";
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, text });
		await t.engine.collect({ force: true });
		expect(t.mail.specs[0]).toMatchObject({ request: text });
	});

	test("another work named in the comment never picks the files: only the post title does", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, text: "곡B 문서 부탁드립니다. Fan@Example.com 입니다" });
		await t.engine.collect({ force: true });
		expect(t.mail.specs[0]!.fromLibrary).toBe("숲과 나나미 요약");
	});

	test("a post without a title: the mail has no files and the card says to check", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, title: "" });
		await t.engine.collect({ force: true });
		expect(t.mail.specs[0]!.fromLibrary).toBeUndefined();
		expect(pendingOf(t)[0]!.notes).toEqual([NO_TITLE_NOTE]);
	});

	test("library miss: the card gets a 확인 line", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, mail: { miss: true } });
		await t.engine.collect({ force: true });
		const d = pendingOf(t)[0]!;
		expect(d.mail).toBe("M1");
		expect(d.notes).toEqual(["확인: 첨부 파일 폴더에서 맞는 파일을 찾지 못했어요"]);
	});

	test("no address, no file ask, or no mail link: no mail, and the reply that promises one says why on the card", async () => {
		for (const [o, why] of [[{ text: "문서 부탁드립니다" }, "주소가 없어요"], [{ text: "영상 잘 봤어요. a@b.com" }, "파일 요청이 아니에요"], [{ noMail: true }, "메일을 쓸 수 없어요"]] as const) {
			rmSync(dir, { recursive: true, force: true });
			const t = setup({ source: { autoMail: true, mailApp: "mail" }, ...o });
			await t.engine.collect({ force: true });
			expect(pendingOf(t)).toHaveLength(1);
			expect(pendingOf(t)[0]!.mail).toBeUndefined();
			expect(pendingOf(t)[0]!.notes).toEqual([`확인: 메일 초안이 없어요 (${why})`]);
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

describe("a reply that promises a mail that nobody sends (D1)", () => {
	const NO_ADDRESS = "문서 부탁드립니다 (주소는 사진으로)";
	const auto: Partial<SourceConfig> = { autoMail: true, mailApp: "mail", autoSend: { on: true, match: ["부탁"], max_per_day: 5 } };

	test("C9: no address, so no mail: the draft says so, is not clean, and the auto-send rule does not post it", async () => {
		const t = setup({ source: auto, text: NO_ADDRESS });
		const out = await t.engine.collect({ force: true });
		expect(out.drafted).toHaveLength(1);
		expect(out.drafted[0]!.mail).toBeUndefined();
		expect(out.drafted[0]!.clean).toBe(false);
		expect(out.drafted[0]!.notes).toContain("확인: 메일 초안이 없어요 (주소가 없어요)");
		expect(out.sent).toEqual([]);
		expect(t.posted).toEqual([]);
		expect(t.engine.send(out.drafted[0]!.code, { by: "rule" })).toMatchObject({ ok: false });
		expect(t.posted).toEqual([]);
	});

	test("the note names why the reply has no mail: not a file request", async () => {
		rmSync(dir, { recursive: true, force: true });
		const notFile = setup({ source: { autoMail: true, mailApp: "mail" }, text: "영상 잘 봤어요. a@b.com" });
		await notFile.engine.collect({ force: true });
		expect(pendingOf(notFile)[0]!.notes).toContain("확인: 메일 초안이 없어요 (파일 요청이 아니에요)");
	});

	test("the owner's plain 보내기 is refused as a file mismatch and posts nothing; 이대로 보내기 posts it", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, text: NO_ADDRESS });
		await t.engine.collect({ force: true });
		const code = pendingOf(t)[0]!.code;
		const refused = t.engine.send(code, { by: "owner" });
		expect(refused).toMatchObject({ ok: false, code: "attach_mismatch" });
		if (!refused.ok) expect(refused.reason.startsWith(ATTACH_REFUSED)).toBe(true);
		expect(t.posted).toEqual([]);
		expect(t.engine.store.drafts().find(d => d.code === code)!.status).toBe("pending");
		const forced = t.engine.send(code, { by: "owner", asIs: true });
		expect(forced.ok && (await forced.done).state).toBe("sent");
		expect(t.posted).toEqual(["메일로 보내드릴게요"]);
	});

	test("a rule never posts it, even when the same call says asIs", async () => {
		const t = setup({ source: auto, text: NO_ADDRESS });
		await t.engine.collect({ force: true });
		const code = pendingOf(t)[0]!.code;
		expect(t.engine.send(code, { by: "rule", asIs: true })).toMatchObject({ ok: false });
		expect(t.posted).toEqual([]);
	});

	test("a reply that does not promise anything is sent plainly, with no note", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, text: NO_ADDRESS, body: "확인하고 알려 드릴게요" });
		await t.engine.collect({ force: true });
		const d = pendingOf(t)[0]!;
		expect(d.notes).toEqual([]);
		const r = t.engine.send(d.code, { by: "owner" });
		expect(r.ok && (await r.done).state).toBe("sent");
	});

	test("rewriting the promise away by hand clears the note, and writing one in adds it", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" }, text: NO_ADDRESS });
		await t.engine.collect({ force: true });
		const code = pendingOf(t)[0]!.code;
		expect(t.engine.edit(code, "주소를 댓글에 적어 주세요")).toEqual({ ok: true });
		expect(pendingOf(t)[0]!.notes.some(n => n.startsWith("확인: 메일 초안이 없어요"))).toBe(false);
		const plain = t.engine.send(code, { by: "owner" });
		expect(plain.ok && (await plain.done).state).toBe("sent");
		rmSync(dir, { recursive: true, force: true });
		const u = setup({ source: { autoMail: true, mailApp: "mail" }, text: NO_ADDRESS, body: "주소를 댓글에 적어 주세요" });
		await u.engine.collect({ force: true });
		const ucode = pendingOf(u)[0]!.code;
		expect(u.engine.edit(ucode, "메일로 보내드릴게요")).toEqual({ ok: true });
		expect(pendingOf(u)[0]!.notes).toContain("확인: 메일 초안이 없어요 (주소가 없어요)");
		expect(u.engine.send(ucode, { by: "owner" })).toMatchObject({ ok: false, code: "attach_mismatch" });
	});

	test("a reply with its mail on the card is not held, and the model is told whether a mail rides with the reply", async () => {
		const withMail = setup({ source: { autoMail: true, mailApp: "mail" } });
		await withMail.engine.collect({ force: true });
		expect(pendingOf(withMail)[0]!.mail).toBe("M1");
		expect(pendingOf(withMail)[0]!.notes).toEqual([]);
		const plain = withMail.engine.send(pendingOf(withMail)[0]!.code, { by: "owner" });
		expect(plain.ok && (await plain.done).state).toBe("sent");
		expect(withMail.prompts.join("\n")).toContain("함께 보내는 메일: 있어요");
		rmSync(dir, { recursive: true, force: true });
		const without = setup({ source: { autoMail: true, mailApp: "mail" }, text: NO_ADDRESS });
		await without.engine.collect({ force: true });
		expect(without.prompts.join("\n")).toContain("함께 보내는 메일: 없어요");
		expect(without.prompts.join("\n")).not.toContain("함께 보내는 메일: 있어요");
	});

	test("L9: a comment found deleted before the send: refused, no reply posted and no mail sent", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" } });
		await t.engine.collect({ force: true });
		const d = pendingOf(t)[0]!;
		expect(d.mail).toBe("M1");
		t.engine.store.patchComments({ [t.id]: { gone: NOW } });
		const r = t.engine.send(d.code, { by: "owner" });
		expect(r).toMatchObject({ ok: false, code: "original_gone" });
		expect(t.posted).toEqual([]);
		expect(t.mail.link.state?.("M1")).toBe("pending");
	});
});

describe("which replies promise a mail (CM-3)", () => {
	const rule: Partial<SourceConfig> = { autoSend: { on: true, match: ["궁금"], max_per_day: 5 } };
	const QUESTION = "궁금해요, 알려 주세요";
	const NOT_PROMISES = [
		"메일 주소를 알려주시면 자료 보내드리겠습니다.",
		"이메일 주소 남겨 주시면 보내드릴게요.",
		"궁금한 점은 메일 주시면 답변 드릴게요",
		"메일로는 보내드리기 어려워요.",
		"메일 보내주세요.",
		"자세한 문의는 메일로 보내주세요",
		"메일로 보내주신 자료 잘 받았어요. 감사합니다.",
		"메일로 보내드린 내용 참고해 주세요.",
		"지난번에 보내드린 자료 확인 부탁드려요",
	];
	const PROMISES = ["메일로 보내드릴게요", "요청하신 자료는 메일로 보내드렸습니다", "Will email it to you.", "I have emailed you the file.", "I'll email you the PDF"];

	test.each(NOT_PROMISES)("a reply that only asks, declines, thanks or points back stays clean and the rule posts it: %s", async body => {
		const t = setup({ source: rule, text: QUESTION, body });
		const out = await t.engine.collect({ force: true });
		expect(out.drafted[0]!.clean).toBe(true);
		expect(out.drafted[0]!.notes).toEqual([]);
		expect(out.sent).toHaveLength(1);
		expect(t.posted).toEqual([body]);
	});

	test.each(NOT_PROMISES)("and the owner's plain 보내기 posts it: %s", async body => {
		const t = setup({ text: QUESTION, body });
		await t.engine.collect({ force: true });
		const r = t.engine.send(pendingOf(t)[0]!.code, { by: "owner" });
		expect(r.ok && (await r.done).state).toBe("sent");
		expect(t.posted).toEqual([body]);
	});

	test.each(PROMISES)("a reply that says it sends a mail with no mail on the card is held: %s", async body => {
		const t = setup({ source: rule, text: QUESTION, body });
		const out = await t.engine.collect({ force: true });
		const d = out.drafted[0]!;
		expect(d.clean).toBe(false);
		expect(d.notes.some(n => n.startsWith("확인: 메일 초안이 없어요"))).toBe(true);
		expect(out.sent).toEqual([]);
		expect(t.engine.send(d.code, { by: "rule", asIs: true })).toMatchObject({ ok: false });
		expect(t.engine.send(d.code, { by: "owner" })).toMatchObject({ ok: false, code: "attach_mismatch" });
		expect(t.posted).toEqual([]);
		const forced = t.engine.send(d.code, { by: "owner", asIs: true });
		expect(forced.ok && (await forced.done).state).toBe("sent");
		expect(t.posted).toEqual([body]);
	});

	test("revise --no-mail on a reply that still promises one: the card says it once, with the reason that the mail is gone", async () => {
		const t = setup({ source: { autoMail: true, mailApp: "mail" } });
		await t.engine.collect({ force: true });
		const d = pendingOf(t)[0]!;
		expect(d.mail).toBe("M1");
		const r = await t.engine.revise(d.code, "메일은 빼 주세요", "reply", true);
		expect(r.ok).toBe(true);
		expect(t.mail.link.state?.("M1")).toBe("dropped");
		const after = pendingOf(t)[0]!;
		expect(after.mail).toBeUndefined();
		expect(after.notes).toEqual(["확인: 답글과 메일이 달라요 - 답글은 메일을 보낸다고 하는데 함께 보낼 메일이 없으니 답글을 고쳐 주세요"]);
	});
});
