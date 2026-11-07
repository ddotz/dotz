import { afterAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { mailDraftBrief, postMail, type MailDeps } from "../../../hub/mail.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { paths } from "../lib/settings.ts";
import { listDrafts } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

// A mail's reply draft is added to its card: sender, summary, 할 일 and 직접 답할 것 stay on the card, on the web and in the messenger text. Made-up data.
const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox()]) rmSync(p, { force: true, recursive: true });
});

const deps: MailDeps = { createThread: async () => ({ id: "1" }), send: async () => {}, mailChannel: async () => undefined, discordOn: false, threadOn: () => true, emit: () => {}, wake: () => {} };
let seq = 0;
const posted = async (extra: object) => (await postMail({ source: "lines", id: `m${Date.now().toString(36)}${++seq}`, subject: mailFixture.subject, from: mailFixture.from, ...extra }, deps)).key!;

test("a draft-bearing mail keeps sender, summary, to-do and direct-answer lines on its card", async () => {
	enable(env);
	const key = await posted({ summary: "다음 주 회의 일정을 물어요.", todo: ["회의 시간 확인"], questions: ["참석 인원은요?", "장소는요?"] });
	const sent: string[] = [];
	const result = await offerMailDraft({ ...mailFixture, key }, { send: (_, text) => void sent.push(text), call: fakeModel([j(goodReply)]).call, brief: mailDraftBrief });
	expect(result).toBe("offered");
	const card = sent.at(-1)!;
	expect(parseDraftApproval(card)).toMatchObject({ brief: { from: mailFixture.from, summary: "다음 주 회의 일정을 물어요.", todo: ["회의 시간 확인"], questions: ["참석 인원은요?", "장소는요?"] }, body: goodReply.body });
	for (const line of [`보낸이: ${mailFixture.from}`, "요약: 다음 주 회의 일정을 물어요.", "할 일: 회의 시간 확인", "직접 답할 것: 참석 인원은요? / 장소는요?"]) expect(card.split("\n")).toContain(line);
	expect(listDrafts()[0]!.brief?.todo).toEqual(["회의 시간 확인"]);
});

test("without the mail's record the card still has the sender and summary the offer came with", async () => {
	enable(env);
	const sent: string[] = [];
	await offerMailDraft({ ...mailFixture, key: "lines-none", summary: "일정 문의예요." }, { send: (_, text) => void sent.push(text), call: fakeModel([j(goodReply)]).call });
	expect(parseDraftApproval(sent.at(-1)!)?.brief).toEqual({ from: mailFixture.from, summary: "일정 문의예요." });
});

test("a mail waiting on a reply is drafted when the model first says skip; another mail may still be skipped", async () => {
	enable(env);
	const model = fakeModel([j({ action: "skip", reason: "nothing to answer" }), j(goodReply)]);
	expect(await offerMailDraft({ ...mailFixture, key: "lines-needs", needs: true }, { send: () => {}, call: model.call })).toBe("offered");
	expect(model.calls).toHaveLength(2);
	expect(await offerMailDraft({ ...mailFixture, key: "lines-maybe" }, { send: () => {}, call: fakeModel([j({ action: "skip", reason: "nothing to answer" })]).call })).toBe("skipped");
});
