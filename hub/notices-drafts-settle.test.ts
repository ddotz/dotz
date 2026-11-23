import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { paths } from "../features/reply-drafts/lib/settings.ts";
import { addDraft, DRAFT_ID, draftHeads, draftStoreIntact, newId, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { draftHandled } from "./draft-handled.ts";
import { emit } from "./events.ts";
import { COMMENT_CODE } from "./comments/engine.ts";
import { KAKAO_CODE } from "./kakao/send.ts";
import { listNotices, markDraftSend, resetNoticesForTest, setDraftHandled, settleHandledDrafts, settleOpenDecision } from "./notices.ts";
import { setSendOwed } from "./notices-drafts.ts";

const records = new Map<string, { reply?: string }>();
const facts = () => ({
	mail: { drafts: draftHeads, record: (key: string) => records.get(key), idShape: DRAFT_ID, intact: draftStoreIntact },
	comment: { drafts: () => [], waiting: () => undefined, idShape: COMMENT_CODE, intact: () => true },
	kakao: { drafts: async () => [], waiting: async () => undefined, idShape: KAKAO_CODE, intact: () => true },
});
const wiredSendOwed = setSendOwed(async () => false);
const wiredHandled = setDraftHandled(() => false);
afterAll(() => {
	setSendOwed(wiredSendOwed);
	setDraftHandled(wiredHandled);
});
beforeEach(() => {
	resetNoticesForTest();
	records.clear();
	rmSync(paths.drafts(), { force: true });
	setDraftHandled((d, _n, ref) => draftHandled(ref, facts(), d.to));
});
afterEach(() => {
	chmodSync(paths.drafts(), 0o600);
	rmSync(paths.drafts(), { force: true });
});

const mailDraft = (id: string, mailRef: string, status: string, created = "2026-11-01T00:00:00.000Z") =>
	addDraft({ id, kind: "mail", app: "mail", source: "zele", mailId: `m-${id}`, ref: mailRef, to: "a@example.com", body: "답", status, created, changes: [], questions: [], item: { kind: "mail", from: "a@example.com", text: "안녕" } } as DraftRec);
const ask = (ref: string) => `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "a@example.com", toLabel: "받는이", subject: "Re: 샘플", body: "답", ref, question: "이 답장 보낼까요?" })}`;
const failedCard = (ref: string, state: "failed" | "unsure" = "failed") => {
	const conv = `mail:settle-${ref}`;
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: conv, text: ask(ref) });
	settleOpenDecision(listNotices(500).items.find(n => n.decision?.state === "open" && n.decision.draft?.ref === ref)!.id, "1) 보내기");
	markDraftSend(conv, ref, state, "보내지 못했어요");
};
const card = (ref: string) => listNotices(500).items.find(n => n.decision?.draft?.ref === ref)!;
const waiting = () => listNotices(500).items.filter(n => n.decision?.send && typeof n.handled !== "string").map(n => n.decision!.draft!.ref);

test("one settle clears the failed-send marks of every closed card whose draft has ended, and only the pending one remains", async () => {
	const sent = newId(), replaced = newId(), newer = newId(), dropped = newId(), absent = newId(), pending = newId(), answered = newId();
	mailDraft(sent, "mail-sent", "sent");
	mailDraft(replaced, "mail-replaced", "pending", "2026-11-01T00:00:00.000Z");
	mailDraft(newer, "mail-replaced", "pending", "2026-11-02T00:00:00.000Z");
	mailDraft(dropped, "mail-dropped", "dropped");
	mailDraft(pending, "mail-pending", "pending");
	mailDraft(answered, "mail-answered", "pending");
	records.set("mail-pending", { reply: "needs" });
	records.set("mail-replaced", { reply: "needs" });
	records.set("mail-answered", { reply: "replied" });
	for (const ref of [sent, replaced, dropped, absent, pending, answered]) failedCard(ref);
	expect(waiting().sort()).toEqual([sent, replaced, dropped, absent, pending, answered].sort());

	await settleHandledDrafts();

	expect(waiting()).toEqual([pending]);
	expect(card(sent)).toMatchObject({ read: true, handled: expect.any(String) });
	expect(card(pending).decision!.send!.state).toBe("failed");
	await settleHandledDrafts();
	expect(waiting()).toEqual([pending]);
});

test("a store that cannot be read closes no failed-send mark, and it closes them once it can", async () => {
	const gone = newId();
	failedCard(gone);
	mailDraft(newId(), "mail-other", "pending");
	chmodSync(paths.drafts(), 0o000);
	await settleHandledDrafts();
	expect(waiting()).toEqual([gone]);
	chmodSync(paths.drafts(), 0o600);
	await settleHandledDrafts();
	expect(waiting()).toEqual([]);
});
