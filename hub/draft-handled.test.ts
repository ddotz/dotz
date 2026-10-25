import { beforeEach, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { commentDraftHandled, draftHandled, kakaoDraftHandled, mailDraftHandled, type AllFacts } from "./draft-handled.ts";
import { emit } from "./events.ts";
import { confirmGroup, listNotices, resetNoticesForTest, setAppLabelResolver, setAppResolver, setDraftHandled, settleHandledDrafts, unreadCount } from "./notices.ts";
import { decisionPush } from "./push.ts";

const mail = (id: string, ref: string, status = "pending", created = "2026-10-01T00:00:00.000Z") => ({ id, ref, status, created });
const noMail = { drafts: () => [], record: () => undefined };
const noComment = { drafts: () => [], waiting: () => undefined };
const noKakao = { drafts: async () => [], waiting: async () => undefined };
const facts = (over: Partial<AllFacts>): AllFacts => ({ mail: noMail, comment: noComment, kakao: noKakao, ...over });

test("a mail draft is handled once it was sent, dropped, replaced, answered from his own client, marked 답장 안 함 or deleted at the source", () => {
	const rec = (r?: { noReply?: boolean; suggest?: { state?: string } } | undefined) => ({ drafts: () => [mail("d1", "m1")], record: () => r });
	expect(mailDraftHandled("d1", rec({}))).toBe(false);
	expect(mailDraftHandled("d1", rec({ suggest: { state: "draft" } }))).toBe(false);
	expect(mailDraftHandled("d1", rec({ suggest: { state: "sent" } }))).toBe(true);
	expect(mailDraftHandled("d1", rec({ noReply: true }))).toBe(true);
	expect(mailDraftHandled("d1", rec(undefined))).toBe(true);
	for (const status of ["sent", "dropped", "stale"]) expect(mailDraftHandled("d1", { drafts: () => [mail("d1", "m1", status)], record: () => ({}) })).toBe(true);
	const revised = { drafts: () => [mail("d1", "m1"), mail("d2", "m1", "pending", "2026-10-02T00:00:00.000Z")], record: () => ({}) };
	expect(mailDraftHandled("d1", revised)).toBe(true);
	expect(mailDraftHandled("d2", revised)).toBe(false);
	expect(mailDraftHandled("zz", rec({}))).toBeUndefined();
});

test("a comment draft is handled when the comment no longer waits or the draft was replaced; a gone comment closes it", () => {
	const make = (waiting: boolean | undefined, status = "pending") => ({ drafts: () => [{ code: "C1", commentId: "c1", status, created: 1 }], waiting: () => waiting });
	expect(commentDraftHandled("C1", make(true))).toBe(false);
	expect(commentDraftHandled("C1", make(false))).toBe(true);
	expect(commentDraftHandled("C1", make(undefined))).toBe(true);
	expect(commentDraftHandled("C1", make(true, "sent"))).toBe(true);
	const revised = { drafts: () => [{ code: "C1", commentId: "c1", status: "pending", created: 1 }, { code: "C2", commentId: "c1", status: "pending", created: 2 }], waiting: () => true };
	expect(commentDraftHandled("C1", revised)).toBe(true);
	expect(commentDraftHandled("C2", revised)).toBe(false);
});

test("a KakaoTalk draft is handled when his own message ended the wait; an unwatched room stays open", async () => {
	const make = (waiting: boolean | undefined, status = "pending") => ({ drafts: async () => [{ code: "K1", chatId: "r1", status, created: "2026-10-01T00:00:00.000Z" }], waiting: async () => waiting });
	expect(await kakaoDraftHandled("K1", make(true))).toBe(false);
	expect(await kakaoDraftHandled("K1", make(false))).toBe(true);
	expect(await kakaoDraftHandled("K1", make(undefined))).toBe(false);
	expect(await kakaoDraftHandled("K1", make(true, "dropped"))).toBe(true);
	expect(await draftHandled("K1", facts({ kakao: make(false) }))).toBe(true);
	expect(await draftHandled("unknown", facts({}))).toBe(false);
});

const ask = (to: string, ref: string, who: string) => `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: who, toLabel: "받는이", subject: "Re: 샘플", body: "샘플 답장입니다", ref, question: "이 답장 보낼까요?" })}`;
const post = (to: string, ref: string, who: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: to, text: ask(to, ref, who) });
const open = () => listNotices(100).items.filter(i => i.decision?.state === "open" && i.decision.draft);
const handled = new Set<string>();

beforeEach(() => {
	resetNoticesForTest();
	handled.clear();
	setDraftHandled(d => handled.has(d.draft!.ref!));
	setAppResolver(n => (n.decision?.draft ? "mail" : undefined));
	setAppLabelResolver(() => "메일");
});

test("the sweep closes each approval whose draft was handled elsewhere, keeps the rest, and is idempotent", async () => {
	post("mail:sample-1", "d1", "a@example.com");
	post("mail:sample-2", "d2", "b@example.com");
	post("mail:sample-3", "d3", "c@example.com");
	expect(open()).toHaveLength(3);
	const before = unreadCount();
	handled.add("d1");
	handled.add("d3");
	expect(await settleHandledDrafts()).toBe(2);
	expect(open().map(i => i.decision!.draft!.ref)).toEqual(["d2"]);
	const closed = listNotices(100).items.filter(i => i.decision?.draft && i.decision.state === "answered");
	expect(closed).toHaveLength(2);
	for (const i of closed) expect(i).toMatchObject({ read: true, decision: { resolved: true } });
	expect(unreadCount()).toBe(before - 2);
	expect(await settleHandledDrafts()).toBe(0);
});

test("a startup sweep cleans approvals that went stale while the hub was down, and a failing check keeps the notice", async () => {
	post("mail:sample-1", "d1", "a@example.com");
	post("mail:sample-2", "d2", "b@example.com");
	setDraftHandled(d => {
		if (d.draft!.ref === "d1") throw new Error("store unreadable");
		return true;
	});
	expect(await settleHandledDrafts()).toBe(1);
	expect(open().map(i => i.decision!.draft!.ref)).toEqual(["d1"]);
});

test("send approvals of one app push as one evolving notification with the item count", () => {
	post("mail:sample-1", "d1", "a@example.com");
	const [one] = open();
	expect(decisionPush(one!)).toMatchObject({ tag: `decision:${one!.id}` });
	post("mail:sample-2", "d2", "b@example.com");
	post("mail:sample-3", "d3", "c@example.com");
	const [first, , third] = open();
	expect(confirmGroup(first!)).toEqual({ key: "mail", label: "메일 답장 확인", count: 3 });
	const a = decisionPush(first!), c = decisionPush(third!);
	expect(a).toMatchObject({ body: "메일 답장 확인 3건", tag: "decision-group:mail" });
	expect(c.tag).toBe(a.tag);
	expect(a.actions).toBeUndefined();
});
