import { afterAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { dropDraft, reviseDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { paths } from "../lib/settings.ts";
import { answerDrafts, getDraft, isDrafted, listDrafts, type DraftRec } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), paths.toneDir(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
	enable(env);
});

const quiet = { send: () => undefined, log: () => undefined };
async function offered(extra: object = {}, body = goodReply.body): Promise<DraftRec> {
	await offerMailDraft({ ...mailFixture, ...extra }, { ...quiet, call: fakeModel([j({ ...goodReply, body })]).call });
	return listDrafts().at(-1)!;
}
const revisedWhile = (meanwhile: () => Promise<unknown> | unknown) => async () => {
	await meanwhile();
	return j({ ...goodReply, body: "수정된 답", lesson: "" });
};

test("a revise whose thread got a newer message's draft meanwhile stores nothing and leaves the newer draft waiting", async () => {
	const old = await offered();
	let newer: DraftRec | undefined;
	const r = await reviseDraft(old.id, "더 짧게", { call: revisedWhile(async () => (newer = await offered({ messageId: "NEW", body: "일정 변경됩니다. 목요일 괜찮으세요?" }, "목요일 가능해요"))) });
	expect(r.ok).toBe(false);
	expect(r.text).toContain("저장하지 않았어요");
	expect(getDraft(old.id)?.status).toBe("stale");
	expect(getDraft(newer!.id)?.status).toBe("pending");
	expect(listDrafts().filter(d => d.status === "pending").map(d => d.body)).toEqual(["목요일 가능해요"]);
});

test("a revise of a mail the owner answered by hand meanwhile stores nothing", async () => {
	const old = await offered();
	const r = await reviseDraft(old.id, "더 짧게", { call: revisedWhile(() => answerDrafts(old.ref)) });
	expect(r.ok).toBe(false);
	expect(r.text).toContain("answered");
	expect(listDrafts().map(d => [d.id, d.status])).toEqual([[old.id, "answered"]]);
});

test("a revise of a draft dropped meanwhile stores nothing", async () => {
	const old = await offered();
	const r = await reviseDraft(old.id, "더 짧게", { call: revisedWhile(() => dropDraft(old.id)) });
	expect(r.ok).toBe(false);
	expect(listDrafts().map(d => [d.id, d.status])).toEqual([[old.id, "dropped"]]);
});

test("a revise with nothing changing meanwhile still replaces the draft", async () => {
	const old = await offered();
	const r = await reviseDraft(old.id, "더 짧게", { call: revisedWhile(() => undefined) });
	expect(r.ok).toBe(true);
	expect(getDraft(old.id)?.status).toBe("stale");
	expect(getDraft(r.id!)).toMatchObject({ status: "pending", body: "수정된 답", replaces: old.id });
});

test("a card post that throws keeps the stored draft: the next offer of the mail makes no second card and no second model call", async () => {
	const cards: string[] = [];
	let posts = 0;
	const send = (_to: string, text: string) => {
		cards.push(text);
		if (posts++ === 0) throw new Error("posted, then the connection dropped");
	};
	const model = fakeModel([j(goodReply)]);
	await offerMailDraft(mailFixture, { send, log: () => undefined, call: model.call });
	expect(listDrafts().map(d => d.status)).toEqual(["pending"]);
	expect(isDrafted(mailFixture.key)).toBe(true);
	expect(await offerMailDraft(mailFixture, { send, log: () => undefined, call: model.call })).toBe("skipped");
	expect(listDrafts()).toHaveLength(1);
	expect(cards).toHaveLength(1);
	expect(model.calls).toHaveLength(1);
});
