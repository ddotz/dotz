import { afterAll, beforeEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { addDraft, getDraft, setStatus, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { answerDecision, listNotices, NOTICE_CAP, reopenNotices, resetNoticesForTest, setDraftHandled } from "./notices.ts";

// 보내지 않기 on a mail reply draft drops it in the real reply-drafts store (temp DOTZ_DIR); 되돌리기 (the reopen route's two steps) puts it back
// to pending, and the 보내기 answered after that is the one the send gate accepts.
const env = setupEnv();
afterAll(env.cleanup);
const { dropAnsweredMailDraft } = await import("./draft-drop.ts");
const { droppedDraftRefs, restoreReopenedDrafts } = await import("./draft-restore.ts");
const { restoreDraft, sendDraft } = await import("../features/reply-drafts/lib/flow.ts");

const rec = (id: string, ref = `kdb-${id}`): DraftRec => ({ id, kind: "mail", app: "mail", source: "kdb", mailId: "1", ref, to: "kim@example.com", subject: "Re: 견적", body: "확인해 보고 말씀드릴게요.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", from: "Kim <kim@example.com>", text: "견적 부탁드려요" } });
let clock = Date.now();
// The web send of a decision answer as it lands in inbox.jsonl (hub/notices.ts answerDecision -> sendWeb), each a little later than the last.
const webSend = async (a: { text: string; picks?: unknown }) => {
	clock += 1000;
	appendFileSync(join(env.dir, "inbox.jsonl"), `${JSON.stringify({ ts: new Date(clock).toISOString(), kind: "message", source: "web", text: a.text, picks: a.picks })}\n`);
};
const post = (ref: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "mail:kdb-1", text: `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "kim@example.com", toLabel: "받는이", subject: "Re: 견적", body: "확인해 보고 말씀드릴게요.", ref, question: "이 답장 보낼까요?" })}` });
const cardOf = (ref: string) => listNotices(NOTICE_CAP).items.find(i => i.decision?.draft?.ref === ref)!;
const reopen = async (ids: string[]) => {
	const refs = droppedDraftRefs(listNotices(NOTICE_CAP).items, ids);
	const r = reopenNotices(ids);
	await restoreReopenedDrafts(refs, r.reopened);
	return r;
};
const answer = async (id: string, n: number) => {
	const r = await answerDecision(id, { n }, webSend);
	if (r.status === 200 && !r.body.already) await dropAnsweredMailDraft(r.body.item as never, n);
	return r;
};

beforeEach(() => {
	resetNoticesForTest();
	setDraftHandled(() => false);
});

test("되돌리기 after 보내지 않기 puts the dropped draft back to pending, and a 보내기 answered then is accepted by the send gate", async () => {
	addDraft(rec("RAAAAA2"));
	post("RAAAAA2");
	const id = cardOf("RAAAAA2").id;
	expect((await answer(id, 3)).status).toBe(200);
	expect(getDraft("RAAAAA2")!.status).toBe("dropped");
	expect((await reopen([id])).reopened).toEqual([id]);
	expect(getDraft("RAAAAA2")!.status).toBe("pending");
	expect(cardOf("RAAAAA2").decision!.state).toBe("open");
	expect((await answer(id, 1)).status).toBe(200);
	const sent: string[] = [];
	const r = await sendDraft("RAAAAA2", { send: async d => (sent.push(d.id), { ok: true, message: "보냈어요" }) });
	expect(r).toMatchObject({ ok: true });
	expect([sent, getDraft("RAAAAA2")!.status]).toEqual([["RAAAAA2"], "sent"]);
});

test("a reopen of a card answered 보내기 leaves the sent draft alone", async () => {
	addDraft(rec("RBBBBB2"));
	post("RBBBBB2");
	const id = cardOf("RBBBBB2").id;
	await answer(id, 1);
	setStatus("RBBBBB2", "sent");
	await reopen([id]);
	expect(getDraft("RBBBBB2")!.status).toBe("sent");
});

test("restoreDraft refuses a sent or replaced draft and one whose mail has a newer draft waiting", () => {
	addDraft(rec("RCCCCC2", "kdb-c"));
	setStatus("RCCCCC2", "sent");
	expect(restoreDraft("RCCCCC2")).toMatchObject({ ok: false });
	addDraft(rec("RDDDDD2", "kdb-d"));
	addDraft(rec("REEEEE2", "kdb-d"));   // the newer draft of the same mail makes the older one stale
	expect(getDraft("RDDDDD2")!.status).toBe("stale");
	expect(restoreDraft("RDDDDD2")).toMatchObject({ ok: false });
	setStatus("REEEEE2", "dropped");
	addDraft(rec("RFFFFF2", "kdb-d"));
	expect(restoreDraft("REEEEE2")).toMatchObject({ ok: false });
	expect([getDraft("REEEEE2")!.status, getDraft("RFFFFF2")!.status]).toEqual(["dropped", "pending"]);
	expect(restoreDraft("RZZZZZ2")).toMatchObject({ ok: false });
});
