import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommentAdapter, commentId, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine, type Engine, type MailLink, type MailSpec, type MailView } from "./engine.ts";

const T0 = Date.parse("2026-11-02T00:00:00.000Z");
const DAY = 24 * 3600_000;
const ASKS = "문서 부탁드립니다. Fan@Example.com 입니다";
const raw = (native: string, o: Partial<RawComment> = {}): RawComment => ({ native, thread: "p1", author: "팬", text: ASKS, postTitle: "숲과 나나미 요약", at: T0 - 1000, ...o });
const draftJson = (body: string) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [] })}\n\`\`\``;
const base: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, autoMail: true, mailApp: "mail" };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mail-link-rules-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeMail(reviseGate?: Promise<void>) {
	const specs: MailSpec[] = [];
	const status = new Map<string, string>();
	const views = new Map<string, MailView>();
	const link: MailLink = {
		compose: async spec => {
			const id = `M${specs.push(spec)}`;
			status.set(id, "pending");
			views.set(id, { id, to: spec.to, subject: spec.subject, body: spec.body, attachments: [{ name: "brief.pdf", size: 2048 }] });
			return { ok: true, id, notes: [] };
		},
		state: id => status.get(id),
		record: id => views.get(id),
		send: async id => (status.get(id) !== "pending" ? { ok: false, text: `메일 ${id}은 ${status.get(id)} 상태예요` } : (status.set(id, "sent"), { ok: true, text: "메일을 보냈어요" })),
		drop: id => void status.set(id, "dropped"),
		revise: async id => {
			if (!reviseGate) return { ok: true, id };
			await reviseGate;
			const next = `M${specs.push(specs[0]!)}`;
			status.set(id, "stale");
			status.set(next, "pending");
			views.set(next, { ...views.get(id)!, id: next, body: "고친 메일" });
			return { ok: true, id: next };
		},
		view: id => (status.get(id) === "pending" ? views.get(id) : undefined),
	};
	return { link, status };
}

function setup(o: { source?: Partial<SourceConfig>; model?: (user: string) => Promise<string>; replyGate?: Promise<void>; mailReviseGate?: Promise<void> } = {}) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: { ...base, ...o.source } } }));
	const st = { now: T0, rows: [raw("c1")], posted: [] as string[], owed: [] as string[] };
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: st.rows }),
		reply: async (_s, _c, text) => {
			await o.replyGate;
			st.posted.push(text);
			return { ok: true, ref: "r1" };
		},
	};
	const mail = fakeMail(o.mailReviseGate);
	const model = async (_system: string, user: string) => ({ text: o.model ? await o.model(user) : draftJson("메일로 보내드릴게요") });
	const engine = createEngine({ dir, now: () => st.now, collector: "m", adapters: { youtube: adapter }, model, mail: mail.link, mailOwed: id => st.owed.push(id) });
	return { engine, mail, st, id: commentId("youtube", "c1") };
}
const draftOf = async (engine: Engine, id: string) => {
	const step = await engine.makeDraft(id);
	if (!step.ok) throw new Error(step.reason);
	return step.draft;
};

describe("the same address in two comments (CM-9)", () => {
	test("the second card names the mail already made for that address; the first has no such line", async () => {
		const t = setup();
		t.st.rows = [raw("c1"), raw("c2", { text: `자료 주세요 ${ASKS}` })];
		await t.engine.collect({ force: true });
		const first = await draftOf(t.engine, commentId("youtube", "c1"));
		const second = await draftOf(t.engine, commentId("youtube", "c2"));
		expect(first.mail).toBe("M1");
		expect(first.notes).toEqual([]);
		expect(second.mail).toBe("M2");
		expect(second.notes).toContain("확인: 같은 주소로 이미 메일이 있어요 (M1)");
		expect(second.clean).toBe(false);
	});

	test("a mail that is dropped, a mail older than 14 days and another address raise no line", async () => {
		const t = setup();
		t.st.rows = [raw("c1"), raw("c2"), raw("c3", { text: "파일 부탁드려요 other@example.com" }), raw("c4")];
		await t.engine.collect({ force: true });
		const first = await draftOf(t.engine, commentId("youtube", "c1"));
		t.engine.drop(first.code);
		expect((await draftOf(t.engine, commentId("youtube", "c2"))).notes).toEqual([]);
		expect((await draftOf(t.engine, commentId("youtube", "c3"))).notes).toEqual([]);
		t.st.now += 15 * DAY;
		expect((await draftOf(t.engine, commentId("youtube", "c4"))).notes).toEqual([]);
	});

	test("a revise of the reply keeps the line while the mail stays; a revise that drops the mail drops it", async () => {
		const t = setup();
		t.st.rows = [raw("c1"), raw("c2", { text: `자료 주세요 ${ASKS}` })];
		await t.engine.collect({ force: true });
		await draftOf(t.engine, commentId("youtube", "c1"));
		const second = await draftOf(t.engine, commentId("youtube", "c2"));
		const revised = await t.engine.revise(second.code, "더 짧게");
		if (!revised.ok) throw new Error(revised.reason);
		expect(revised.draft.mail).toBe("M2");
		expect(revised.draft.notes).toContain("확인: 같은 주소로 이미 메일이 있어요 (M1)");
		const alone = await t.engine.revise(revised.draft.code, "메일 없이", "reply", true);
		if (!alone.ok) throw new Error(alone.reason);
		expect(alone.draft.mail).toBeUndefined();
		expect(alone.draft.notes).not.toContain("확인: 같은 주소로 이미 메일이 있어요 (M1)");
	});
});

describe("a comment that closes with a mail waiting (CM-12)", () => {
	test("deleted: the mail draft is dropped with it and no card is raised for it", async () => {
		const t = setup();
		await t.engine.collect({ force: true });
		const d = await draftOf(t.engine, t.id);
		t.engine.store.patchComments({ [t.id]: { gone: T0 } });
		await t.engine.reconcile();
		expect(t.engine.store.drafts().find(x => x.code === d.code)).toMatchObject({ status: "answered", closedReason: "deleted" });
		expect(t.mail.status.get("M1")).toBe("dropped");
		expect(t.engine.mailMarkOf(t.id)).toBeUndefined();
		expect(t.st.owed).toEqual([]);
	});

	test("answered on the platform: the mail draft stays pending and a card is raised for it alone", async () => {
		const t = setup();
		await t.engine.collect({ force: true });
		await draftOf(t.engine, t.id);
		t.st.rows = [raw("c1"), raw("c1.r", { parent: "c1", author: "나", text: "보내 드렸어요", mine: true, at: T0 + 1000 })];
		await t.engine.collect({ force: true });
		expect(t.engine.store.drafts()[0]).toMatchObject({ status: "answered", closedReason: "answered-on-platform", mailKept: "M1" });
		expect(t.mail.status.get("M1")).toBe("pending");
		expect(t.st.owed).toEqual(["M1"]);
	});

	test("답장 안 함 keeps the mail without a card of its own", async () => {
		const t = setup();
		await t.engine.collect({ force: true });
		await draftOf(t.engine, t.id);
		t.engine.noReply(t.id);
		await t.engine.reconcile();
		expect(t.mail.status.get("M1")).toBe("pending");
		expect(t.st.owed).toEqual([]);
	});
});

describe("the mail thread of the commenter is kept on the draft (CM-13)", () => {
	const lines = (answered: string) => ["메일 대조: 있음 - 팬 <fan@example.com> · 자료 요청 · 스레드 t1 (답장: " + answered + ")", "근거: 보낸 사람 이름이 댓글 작성자(팬)와 같음"];
	const notFound = ["메일 대조: 못 찾음", "근거: none"];

	function matching(results: (string[] | Error)[]) {
		const calls: number[] = [];
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: { ...base, autoMail: false, mailMatch: true } } }));
		const engine = createEngine({ dir, now: () => T0, collector: "m", adapters: { youtube: { kind: "youtube", list: async () => ({ comments: [raw("c1")] }), reply: async () => ({ ok: true }) } }, model: async () => ({ text: draftJson("곧 보내드릴게요") }), mailMatch: async () => {
			const r = results[Math.min(calls.push(1) - 1, results.length - 1)]!;
			if (r instanceof Error) throw r;
			return r;
		} });
		return { engine, calls };
	}

	test("a mail that arrives after the first check is matched when the reply is revised, and the draft carries the link", async () => {
		const { engine, calls } = matching([notFound, lines("안 보냄")]);
		await engine.collect({ force: true });
		const first = await engine.makeDraft(commentId("youtube", "c1"));
		if (!first.ok) throw new Error(first.reason);
		expect(first.draft.mailThread).toBeUndefined();
		const revised = await engine.revise(first.draft.code, "더 짧게");
		if (!revised.ok) throw new Error(revised.reason);
		expect(calls).toHaveLength(2);
		expect(revised.draft.mailThread).toEqual({ id: "t1", answered: false });
		expect(revised.draft.notes).toContain(lines("안 보냄")[0]!);
	});

	test("a thread the owner answered is not searched again on the next revise, and the link stays", async () => {
		const { engine, calls } = matching([lines("보냄")]);
		await engine.collect({ force: true });
		const first = await engine.makeDraft(commentId("youtube", "c1"));
		if (!first.ok) throw new Error(first.reason);
		expect(first.draft.mailThread).toEqual({ id: "t1", answered: true });
		const revised = await engine.revise(first.draft.code, "더 짧게");
		if (!revised.ok) throw new Error(revised.reason);
		expect(calls).toHaveLength(1);
		expect(revised.draft.mailThread).toEqual({ id: "t1", answered: true });
		expect(revised.draft.notes).toContain(lines("보냄")[0]!);
	});

	test("a thread still waiting for his answer is looked at again, so a later answer shows", async () => {
		const { engine, calls } = matching([lines("안 보냄"), lines("보냄")]);
		await engine.collect({ force: true });
		const first = await engine.makeDraft(commentId("youtube", "c1"));
		if (!first.ok) throw new Error(first.reason);
		const revised = await engine.revise(first.draft.code, "더 짧게");
		if (!revised.ok) throw new Error(revised.reason);
		expect(calls).toHaveLength(2);
		expect(revised.draft.mailThread).toEqual({ id: "t1", answered: true });
	});

	test("a re-search that fails keeps the thread found before and says the check failed", async () => {
		const { engine, calls } = matching([lines("안 보냄"), new Error("zele 응답 없음")]);
		await engine.collect({ force: true });
		const first = await engine.makeDraft(commentId("youtube", "c1"));
		if (!first.ok) throw new Error(first.reason);
		const revised = await engine.revise(first.draft.code, "더 짧게");
		if (!revised.ok) throw new Error(revised.reason);
		expect(calls).toHaveLength(2);
		expect(revised.draft.mailThread).toEqual({ id: "t1", answered: false });
		expect(revised.draft.notes).toEqual([...lines("안 보냄"), "메일 대조: 확인 실패 - zele 응답 없음"]);
	});
});

describe("edit, revise and drop while the reply is being posted (CM-14)", () => {
	const gate = () => Promise.withResolvers<void>();

	test("refused while the post runs; once it ends the reply and its mail went out as picked", async () => {
		const g = gate();
		const t = setup({ replyGate: g.promise });
		await t.engine.collect({ force: true });
		const d = await draftOf(t.engine, t.id);
		const r = t.engine.send(d.code, { by: "owner" });
		if (!r.ok) throw new Error(r.reason);
		const stop = "답글을 올리는 중이라 지금은 고치거나 버릴 수 없어요. 끝난 뒤에 다시 해 주세요";
		expect(t.engine.drop(d.code)).toEqual({ ok: false, reason: stop });
		expect(t.engine.edit(d.code, "바꾼 글")).toMatchObject({ ok: false, reason: stop, code: "already_sending" });
		expect(t.engine.edit(d.code, "바꾼 메일", "mail")).toMatchObject({ ok: false, reason: stop });
		expect(await t.engine.revise(d.code, "더 짧게")).toEqual({ ok: false, reason: stop });
		g.resolve();
		expect((await r.done).mail?.state).toBe("sent");
		expect(t.st.posted).toEqual(["메일로 보내드릴게요"]);
		expect(t.mail.status.get("M1")).toBe("sent");
		expect(t.engine.store.drafts().map(x => [x.code, x.status, x.text])).toEqual([[d.code, "sent", "메일로 보내드릴게요"]]);
	});

	test("a revise whose model answers while the post still runs is not stored", async () => {
		const model = gate();
		const post = gate();
		let slow = false;
		const t = setup({ replyGate: post.promise, model: async () => (slow ? (await model.promise, draftJson("고친 글")) : draftJson("메일로 보내드릴게요")) });
		await t.engine.collect({ force: true });
		const d = await draftOf(t.engine, t.id);
		slow = true;
		const revising = t.engine.revise(d.code, "더 짧게");
		const r = t.engine.send(d.code, { by: "owner" });
		if (!r.ok) throw new Error(r.reason);
		model.resolve();
		expect(await revising).toEqual({ ok: false, reason: "답글을 올리는 중이라 지금은 고치거나 버릴 수 없어요. 끝난 뒤에 다시 해 주세요" });
		post.resolve();
		await r.done;
		expect(t.engine.store.drafts().map(x => [x.code, x.status])).toEqual([[d.code, "sent"]]);
	});

	test("a revise whose model answers after the reply went up leaves no second pending draft", async () => {
		const model = gate();
		let slow = false;
		const t = setup({ model: async () => (slow ? (await model.promise, draftJson("고친 글")) : draftJson("메일로 보내드릴게요")) });
		await t.engine.collect({ force: true });
		const d = await draftOf(t.engine, t.id);
		slow = true;
		const revising = t.engine.revise(d.code, "더 짧게");
		const r = t.engine.send(d.code, { by: "owner" });
		if (!r.ok) throw new Error(r.reason);
		await r.done;
		model.resolve();
		expect(await revising).toEqual({ ok: false, reason: "이 초안은 이미 처리됐어요" });
		expect(t.engine.store.drafts().map(x => [x.code, x.status])).toEqual([[d.code, "sent"]]);
		expect(t.st.posted).toEqual(["메일로 보내드릴게요"]);
	});

	test("a send while a mail revise runs is refused; once the revise ends the reply and the revised mail go out", async () => {
		const g = gate();
		const t = setup({ mailReviseGate: g.promise });
		await t.engine.collect({ force: true });
		const d = await draftOf(t.engine, t.id);
		const revising = t.engine.revise(d.code, "더 정중하게", "mail");
		expect(t.engine.send(d.code, { by: "owner" })).toMatchObject({ ok: false, code: "already_sending" });
		expect(await t.engine.sendMailOnly(d.code)).toMatchObject({ ok: false });
		g.resolve();
		const revised = await revising;
		if (!revised.ok) throw new Error(revised.reason);
		const r = t.engine.send(revised.draft.code, { by: "owner" });
		if (!r.ok) throw new Error(r.reason);
		expect((await r.done).mail?.state).toBe("sent");
		expect(t.st.posted).toEqual(["메일로 보내드릴게요"]);
		expect([t.mail.status.get("M1"), t.mail.status.get("M2")]).toEqual(["stale", "sent"]);
	});

	test("of two mail revises at once the second, made from a mail the card no longer holds, is refused and dropped", async () => {
		const g = gate();
		const t = setup({ mailReviseGate: g.promise });
		await t.engine.collect({ force: true });
		const d = await draftOf(t.engine, t.id);
		const first = t.engine.revise(d.code, "더 정중하게", "mail");
		const second = t.engine.revise(d.code, "더 짧게", "mail");
		g.resolve();
		expect((await first).ok).toBe(true);
		expect(await second).toMatchObject({ ok: false });
		expect(t.engine.store.drafts().map(x => [x.code, x.status, x.mail])).toEqual([[d.code, "pending", "M2"]]);
		expect([t.mail.status.get("M2"), t.mail.status.get("M3")]).toEqual(["pending", "dropped"]);
	});
});
