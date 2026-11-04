import { beforeEach, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { commentDraftHandled, draftHandled, kakaoDraftHandled, mailDraftHandled, mailItemKey, mailRefHandled, type AllFacts } from "./draft-handled.ts";
import { emit } from "./events.ts";
import { type ClosedCard, confirmGroup, listNotices, markDraftPosted, onDecisionClosed, resetNoticesForTest, setAppLabelResolver, setAppResolver, setDraftHandled, settleHandledDrafts, unreadCount } from "./notices.ts";
import { decisionPush } from "./push.ts";

const mail = (id: string, ref: string, status = "pending", created = "2026-10-01T00:00:00.000Z") => ({ id, ref, status, created });
const noMail = { drafts: () => [], record: () => undefined };
const noComment = { drafts: () => [], waiting: () => undefined };
const noKakao = { drafts: async () => [], waiting: async () => undefined };
const facts = (over: Partial<AllFacts>): AllFacts => ({ mail: noMail, comment: noComment, kakao: noKakao, ...over });

test("a mail draft is handled once it was sent, dropped, replaced, answered from his own client, marked 답장 안 함 or deleted at the source", () => {
	const rec = (r?: { reply?: string; noReply?: boolean; suggest?: { state?: string } } | undefined) => ({ drafts: () => [mail("d1", "m1")], record: () => r });
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
	// He answered from his own client: the mail is marked replied.
	expect(mailDraftHandled("d1", rec({ reply: "replied" }))).toBe(true);
});

// The bot's manual card for a mail: ref `mail:<mailId>` in the conversation `mail:<instance>-<mailId>`.
test("a mail:<id> card is handled when its mail is answered, skipped, gone or a draft of it went out; a pending app draft keeps it open", () => {
	const conv = "mail:score-1a16.1";
	const f = (r: Record<string, unknown> | undefined, drafts = [mail("RQN7IC4", "score-1a16.1")]) => ({ drafts: () => drafts, record: () => r });
	expect(mailRefHandled("mail:1a16.1", conv, f({}))).toBe(false);
	expect(mailRefHandled("mail:1a16.1", conv, f({ reply: "needs" }))).toBe(false);
	expect(mailRefHandled("mail:1a16.1", conv, f({ reply: "replied" }))).toBe(true);
	expect(mailRefHandled("mail:1a16.1", conv, f({ reply: "skipped" }))).toBe(true);
	expect(mailRefHandled("mail:1a16.1", conv, f({ reply: "fyi" }))).toBe(true);
	expect(mailRefHandled("mail:1a16.1", conv, f({ noReply: true }))).toBe(true);
	expect(mailRefHandled("mail:1a16.1", conv, f({ suggest: { state: "sent" } }))).toBe(true);
	expect(mailRefHandled("mail:1a16.1", conv, f(undefined))).toBe(true);
	expect(mailRefHandled("mail:1a16.1", conv, f({}, [mail("RQN7IC4", "score-1a16.1", "sent")]))).toBe(true);
	// The conversation is not that mail's (or not a mail conversation): the app cannot say, nothing is guessed.
	expect(mailRefHandled("mail:1a16.1", "mail:score-other.2", f(undefined))).toBeUndefined();
	expect(mailRefHandled("mail:1a16.1", "main", f(undefined))).toBeUndefined();
	expect(mailRefHandled("mail:1a16.1", undefined, f(undefined))).toBeUndefined();
});

test("the bot's mail:<id> card and the app's reply draft of that mail are one item", () => {
	const conv = "mail:score-1a16.1", drafts = () => [mail("RQN7IC4", "score-1a16.1")];
	expect(mailItemKey("mail:1a16.1", conv, drafts)).toBe("mail:score-1a16.1");
	expect(mailItemKey("RQN7IC4", conv, drafts)).toBe("mail:score-1a16.1");
	expect(mailItemKey("cm-A", conv, drafts)).toBe("cm-A");
	expect(mailItemKey("mail:1a16.1", "main", drafts)).toBe("mail:1a16.1");
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
	setDraftHandled((_d, _n, ref) => handled.has(ref));
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

test("one message asking about several drafts: each block closes when its own draft was sent or dropped elsewhere (the 모니터링 queue)", async () => {
	const block = (ref: string) => draftApprovalBlock({ to: "유튜브 댓글", toLabel: "대상", body: `답글 ${ref}`, ref, question: "이 답글 올릴까?" });
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "ch:1", text: `[ask] 댓글 답글 초안이에요\n\n${["c1", "c2", "c3"].map(block).join("\n\n")}` });
	const blocks = () => listNotices(100).items.filter(i => i.decision?.to === "ch:1");
	expect(blocks().map(i => [i.decision!.group, !!i.decision!.draft, i.decision!.state])).toEqual([[3, false, "open"], [3, false, "open"], [3, false, "open"]]);
	handled.add("c2");
	expect(await settleHandledDrafts()).toBe(1);
	const settled = blocks().filter(i => i.decision!.state !== "open");
	expect(settled.map(i => i.title)).toEqual(["이 답글 올릴까? (c2)"]);
	expect(settled[0]).toMatchObject({ read: true, decision: { state: "answered", resolved: true } });
	// A plain several-decision question (no draft options) is never asked about.
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "ch:2", text: "[ask] 두 가지\n\n결정: 어느 쪽? (c1)\n1) 가\n2) 나\n\n결정: 언제? (c3)\n1) 오늘\n2) 내일" });
	handled.add("c1");
	handled.add("c3");
	expect(await settleHandledDrafts()).toBe(2);
	expect(listNotices(100).items.filter(i => i.decision?.to === "ch:2" && i.decision.state === "open")).toHaveLength(2);
});

test("draftHandled answers a mail:<id> ref from the conversation it was asked in", async () => {
	const gone = facts({ mail: { drafts: () => [], record: () => undefined } });
	expect(await draftHandled("mail:1a16.1", gone, "mail:score-1a16.1")).toBe(true);
	expect(await draftHandled("mail:1a16.1", gone)).toBe(false);
});

test("a closing send approval hands the hook what closes its Discord message: where it went, and how it ended", async () => {
	const closed: { ref?: string; card?: ClosedCard }[] = [];
	onDecisionClosed((_to, ref, card) => void closed.push({ ref, card }));
	post("mail:sample-1", "d1", "a@example.com");
	post("mail:sample-2", "d2", "b@example.com");
	markDraftPosted("mail:sample-1", "d1", "mail:sample-1", ["111"]);
	handled.add("d1");
	expect(await settleHandledDrafts()).toBe(1);
	expect(closed).toHaveLength(1);
	expect(closed[0]).toMatchObject({ ref: "d1", card: { how: "resolved", target: "mail:sample-1", ids: ["111"] } });
	// The ids are on the stored notice, so a restart still finds the message.
	expect(listNotices(100).items.find(i => i.decision?.draft?.ref === "d1")?.decision?.card).toEqual({ target: "mail:sample-1", ids: ["111"] });
	// A card that never reached Discord closes with no ids.
	handled.add("d2");
	expect(await settleHandledDrafts()).toBe(1);
	expect(closed[1]!.card?.ids).toBeUndefined();
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
