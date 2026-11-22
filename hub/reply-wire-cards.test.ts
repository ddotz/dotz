import { beforeEach, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { createDraft } from "./kakao/send.ts";
import { kakaoPaths } from "./kakao/types.ts";
import { listNotices, markDraftSend, resetNoticesForTest, setDraftHandled, settleHandledDrafts, settleOpenDecision } from "./notices.ts";
import { mailAdapter } from "./reply-mail.ts";
import { reportCliFailure, sendTargetOf } from "./reply-wire.ts";
import { addDraft, newId } from "../features/reply-drafts/lib/store.ts";

const ask = (ref: string) => `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "a@example.com", toLabel: "받는이", subject: "Re: 샘플", body: "샘플 답장입니다", ref, question: "이 답장 보낼까요?" })}`;
const post = (to: string, ref: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: to, text: ask(ref) });
const marked = (ref: string) => listNotices(100).items.filter(i => i.decision?.draft?.ref === ref && i.decision.send).map(i => `${i.decision!.to}:${i.decision!.send!.state}`);

beforeEach(() => resetNoticesForTest());

test("the send state is written on the card of that conversation, else on the newest card of that draft", () => {
	post("ch:1", "d1");
	post("ch:2", "d1");
	post("ch:3", "d2");
	markDraftSend("ch:1", "d1", "failed", "보내지 못했어요");
	expect(marked("d1")).toEqual(["ch:1:failed"]);
	markDraftSend("ch:9", "d1", "unsure", "확인하지 못했어요");
	expect(marked("d1").sort()).toEqual(["ch:1:failed", "ch:2:unsure"]);
	markDraftSend("ch:9", "d-none", "failed", "x");
	expect(marked("d-none")).toEqual([]);
});

test("a send failure reported with no conversation of its own lands on the newest card of the draft, even when an older card is still open", () => {
	post("ch:1", "d1");
	post("ch:2", "d1");
	settleOpenDecision(listNotices(100).items.find(i => i.decision?.to === "ch:2")!.id, "");
	reportCliFailure("d1", "main", "보내지 못했어요");
	expect(marked("d1")).toEqual(["ch:2:failed"]);
});

test("a mail draft queues in the lane its adapter names, with or without an account and on a webmail site", () => {
	const lanes = (id: string, source: string, account?: string) => {
		addDraft({ id, kind: "mail", app: "mail", source, mailId: `m-${id}`, ref: `lane-${id}`, to: "a@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], ...(account ? { account } : {}), item: { kind: "mail", from: "a@example.com", text: "안녕" } } as never);
		return [sendTargetOf(id)?.lane, mailAdapter().target(id)?.lane];
	};
	const [none, adapterNone] = lanes(newId(), "zele");
	expect(none).toBe(adapterNone);
	const [acct, adapterAcct] = lanes(newId(), "zele", "me@example.com");
	expect(acct).toBe(adapterAcct);
	const [site, adapterSite] = lanes(newId(), "webmail:acme");
	expect(site).toBe(adapterSite);
});

test("the settle pass keeps the failed-send mark of a KakaoTalk draft that is only pressed-but-unconfirmed, and clears one that plainly went out", async () => {
	const kpaths = kakaoPaths(DATA_DIR);
	const make = async (text: string) => (await createDraft({ chatId: "r-settle", roomName: "친구", text, basisLogId: "1" }, { paths: kpaths })).code;
	const unconfirmed = await make("확인 안 됨"), plain = await make("나갔어요");
	const list = JSON.parse(readFileSync(kpaths.drafts, "utf8")) as { code: string }[];
	writeFileSync(kpaths.drafts, JSON.stringify(list.map(d => (d.code === unconfirmed ? { ...d, status: "sent", unconfirmed: true } : d.code === plain ? { ...d, status: "sent" } : d))));
	setDraftHandled(() => true);
	for (const ref of [unconfirmed, plain]) {
		post(`kakao:settle-${ref}`, ref);
		settleOpenDecision(listNotices(100).items.find(i => i.decision?.state === "open" && i.decision.draft?.ref === ref)!.id, "1) 보내기");
		markDraftSend(`kakao:settle-${ref}`, ref, "unsure", "확인하지 못했어요");
	}
	await settleHandledDrafts();
	const handled = (ref: string) => typeof listNotices(100).items.find(i => i.decision?.draft?.ref === ref)?.handled === "string";
	expect([handled(unconfirmed), handled(plain)]).toEqual([false, true]);
});
