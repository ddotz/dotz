import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as outlang from "../../../hub/outlang.ts";
import type { ReplyItem } from "../../../hub/reply-draft.ts";
import { buildDraft, callOf, editDraft, restoreDraft, reviseDraft } from "../lib/flow.ts";
import { paths } from "../lib/settings.ts";
import { addDraft, getDraft, setStatus, type DraftRec } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.drafts(), paths.inbox(), join(env.dir, "custom"), join(env.dir, "sending")]) rmSync(p, { force: true, recursive: true });
	enable(env);
});

const item: ReplyItem = { kind: "mail", text: "문의드립니다", from: "Kim <kim@example.com>", subject: "문의" };
const rec = (o: Partial<DraftRec> = {}): DraftRec =>
	({ id: "RHYG01", kind: "mail", app: "mail", source: "zele", mailId: "m1", ref: "k1", to: "kim@example.com", subject: "Re: 문의", body: "확인해 보고 말씀드릴게요.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item, ...o }) as DraftRec;
const seed = (rel: string, v: unknown) => {
	mkdirSync(dirname(join(env.dir, rel)), { recursive: true });
	writeFileSync(join(env.dir, rel), JSON.stringify(v));
};

test("a mail app instance's reply model drafts that instance's mails, in the first draft call and in the traced one", async () => {
	seed("custom/apps.json", { "mail-2": { app: "mail", label: "개인", filter: { conv: ["mail:naver-"] } } });
	enable(env, { models: { "mail-2": "anthropic/claude-sonnet-5-5:low" } });
	const seen: (string | undefined)[] = [];
	const spy = spyOn(outlang, "callModel").mockImplementation(async (_s, _u, o) => {
		seen.push(o?.model);
		return { text: "답", inputTokens: 1, outputTokens: 1, ms: 1 };
	});
	try {
		await callOf({}, item, "naver-9")("s", "u");
		await callOf({ trace: { deadline: Date.now() + 60_000, calls: [] } }, item, "naver-9")("s", "u");
	} finally {
		spy.mockRestore();
	}
	expect(seen).toEqual(["anthropic/claude-sonnet-5-5:low", "anthropic/claude-sonnet-5-5:low"]);
});

test("the owner's own text clears the card's open questions; a subject-only edit leaves them", () => {
	addDraft(rec({ questions: ["회의 날짜"] }));
	expect(editDraft("RHYG01", "확인해 보고 말씀드릴게요.", "Re: 문의 드린 일정").ok).toBe(true);
	expect(getDraft("RHYG01")?.questions).toEqual(["회의 날짜"]);
	expect(editDraft("RHYG01", "목요일로 정해서 보내드릴게요.").ok).toBe(true);
	expect(getDraft("RHYG01")?.questions).toEqual([]);
});

test("a revision keeps the subject the owner changed and takes the model's subject only when he never touched it", async () => {
	addDraft(rec());
	editDraft("RHYG01", "확인해 보고 말씀드릴게요.", "Re: 내가 정한 제목");
	const kept = await reviseDraft("RHYG01", "더 짧게", { call: fakeModel([j({ ...goodReply, subject: "Re: 모델 제목", body: "짧게 답할게요." })]).call });
	expect(kept.ok).toBe(true);
	expect(getDraft(kept.id!)?.subject).toBe("Re: 내가 정한 제목");
	const next = await reviseDraft(kept.id!, "더 짧게", { call: fakeModel([j({ ...goodReply, subject: "Re: 또 다른 제목", body: "네." })]).call });
	expect(getDraft(next.id!)?.subject).toBe("Re: 내가 정한 제목");

	addDraft(rec({ id: "RHYG02", ref: "k2" }));
	const untouched = await reviseDraft("RHYG02", "더 짧게", { call: fakeModel([j({ ...goodReply, subject: "Re: 모델 제목", body: "짧게 답할게요." })]).call });
	expect(getDraft(untouched.id!)?.subject).toBe("Re: 모델 제목");
});

test("only a question that asks for an email address is dropped from a mail draft", async () => {
	const model = fakeModel([j({ ...goodReply, questions: ["배송 주소를 알려 드려도 될까요", "김 팀장님의 이메일 주소", "What is Kim's e-mail address?", "회의 날짜"] })]);
	const built = await buildDraft({ ...item, text: mailFixture.body }, { source: "zele", mailId: "m1", ref: "k1" }, { call: model.call });
	if (built.action !== "draft") throw new Error("no draft");
	expect(built.rec.questions).toEqual(["배송 주소를 알려 드려도 될까요", "회의 날짜"]);
});

const DIRTY = "\u0000\u0007\u000B\u001F\u007F\u200B\u200C\u200D\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2060\u2066\u2067\u2068\u2069\uFEFF";

test("control, bidi and zero-width characters never reach a saved draft; tab, newline and Korean text stay", async () => {
	addDraft(rec());
	expect(editDraft("RHYG01", `안${DIRTY}녕\t하세요\r\n감사합니다`, `Re:${DIRTY} 문의`).ok).toBe(true);
	expect([getDraft("RHYG01")?.body, getDraft("RHYG01")?.subject]).toEqual(["안녕\t하세요\n감사합니다", "Re: 문의"]);

	const model = fakeModel([j({ ...goodReply, to: `kim${DIRTY}@example.com`, subject: `Re:${DIRTY} 문의`, body: `확인${DIRTY}해 보고 말씀드릴게요.` })]);
	const built = await buildDraft(item, { source: "zele", mailId: "m1", ref: "k1" }, { call: model.call });
	if (built.action !== "draft") throw new Error("no draft");
	expect([built.rec.to, built.rec.subject, built.rec.body]).toEqual(["kim@example.com", "Re: 문의", "확인해 보고 말씀드릴게요."]);
});

test("a dropped draft of a mail that was already answered is not brought back", () => {
	addDraft(rec({ id: "RHYG01", created: "2026-11-01T00:00:00.000Z" }));
	setStatus("RHYG01", "dropped");
	addDraft(rec({ id: "RHYG02", created: "2026-11-02T00:00:00.000Z", status: "pending" }));
	setStatus("RHYG02", "sent");
	const r = restoreDraft("RHYG01");
	expect(r.ok).toBe(false);
	expect(r.text).toContain("이미 답한");
	expect(getDraft("RHYG01")?.status).toBe("dropped");
});

test("a second revise of the same draft is refused while the first one runs, and only the first asks the model", async () => {
	addDraft(rec());
	let open!: () => void;
	const gate = new Promise<void>(r => (open = r));
	let asked = 0;
	const slow = async () => {
		asked++;
		await gate;
		return j(goodReply);
	};
	const first = reviseDraft("RHYG01", "더 짧게", { call: slow });
	const second = await reviseDraft("RHYG01", "더 길게", { call: fakeModel([j(goodReply)]).call });
	expect(second.ok).toBe(false);
	expect(second.text).toContain("고치는 중");
	open();
	expect((await first).ok).toBe(true);
	expect(asked).toBe(1);
	expect((await reviseDraft((await first).id!, "한 번 더", { call: fakeModel([j(goodReply)]).call })).ok).toBe(true);
});
