// The gateway's own send path on the real modules (outbound.out -> queue -> notices -> inbox -> the real draft.ts send CLI): 보내기 on a
// card shows the next card at once with no model turn, the send runs in the background and its result lands on the card, a failure is one
// [fail] note, and a session CLI's failed send reported through POST /api/approvals/failed reaches the card.
// The drafts are mails of a source this machine cannot send from, refused after the approval check, so nothing leaves this machine.
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { realSetTimeout, realClearTimeout } from "./runtime/test-clock.ts";
import { type HubEvent, onBroadcast, onEmit } from "./events.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { askText } from "./draft-attach.ts";
import { ignoreNotice, listNotices, settleOpenDecision } from "./notices.ts";
import * as outbound from "./outbound.ts";
import { out } from "./outbound.ts";
import { withSendState } from "./approval-queue.ts";
import { approvalRoute, reportSend, sendTargetOf, sender, webAnswer } from "./approval-wire.ts";
import { commentsDir, createStore } from "./comments/store.ts";
import { replies } from "./reply-wire.ts";
import { DATA_DIR, cfg } from "./config.ts";
import { addDraft, getDraft, newId, setStatus } from "../features/reply-drafts/lib/store.ts";

beforeEach(() => void (cfg.web.send_undo_sec = 0));
const CONV = "mail:aw-test";
const draft = (body: string, to = "friend@example.com") => {
	const id = newId();
	addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `aw-${id.toLowerCase()}`, to, body, status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", text: "안녕" } as never });
	return id;
};
const refs = [draft("첫째 답"), draft("둘째 답"), draft("셋째 답"), draft("넷째 답")];
const card = (ref: string) => `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: getDraft(ref)!.body, ref, question: "이대로 보낼까요?" })}`;
const openCards = () => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === CONV);
const outs: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && e.target === CONV && outs.push(e)));
// The next card the queue posts here, awaited with a deadline.
const nextCard = (ref: string) =>
	new Promise<void>((resolve, reject) => {
		const timer = realSetTimeout(() => reject(new Error(`card ${ref} never came`)), 5000);
		onEmit(e => {
			if (e.kind === "out" && e.target === CONV && String(e.text).includes(`(${ref})`)) {
				realClearTimeout(timer);
				resolve();
			}
		});
	});
const route = (method: string, path: string, body?: unknown) =>
	approvalRoute(new Request(`http://local${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://local${path}`));

test("보내기 shows the next card at once with no model turn; the send runs in the background and a failure is one note on the card", async () => {
	for (const r of refs) await out(CONV, card(r));
	expect(openCards().map((n: any) => n.decision.draft.ref)).toEqual([refs[0]]);
	const bot: string[] = [];
	const next = nextCard(refs[1]!);
	// The owner presses 보내기 on the version the reply item shows him (its hash, as the web sends it).
	const r = await webAnswer(openCards()[0].id, { n: 1, hash: (await replies.view(refs[0]!))!.draft.hash }, "owner@example.com", async a => void bot.push(a.text));
	expect(r.status).toBe(200);
	// The answer came back while the send was still queued or running: neither it nor the next card waited for the send.
	expect(sender.results(CONV).find(x => x.ref === refs[0])?.state).not.toBe("failed");
	await next;
	expect(bot).toEqual([]);
	await sender.idle();
	const first = listNotices(500).items.find((n: any) => n.decision?.draft?.ref === refs[0]) as any;
	expect(first.decision.send.state).toBe("failed");
	console.log(`send result: ${first.decision.send.text}`);
	// The CLI's own approval check saw the pick: the refusal is the sender's, not "아직 보내도 된다는 답을 받지 못했어요".
	expect(first.decision.send.text).not.toContain("답을 받지 못했어요");
	expect(outs.filter(e => String(e.text).startsWith("[fail]") && String(e.text).includes(refs[0]!))).toHaveLength(1);
});

test("a send a session's CLI ran fails: the gateway report reaches the owner where the card is and marks the card failed", async () => {
	const conv = "mail:aw-report";
	const ref = draft("세션이 보낸 답");
	await out(conv, card(ref));
	const told = new Promise<string>((resolve, reject) => {
		const timer = realSetTimeout(() => reject(new Error("no [fail] note came")), 5000);
		onEmit(e => {
			if (e.kind === "out" && e.target === conv && String(e.text).startsWith("[fail]")) (realClearTimeout(timer), resolve(String(e.text)));
		});
	});
	// The CLI knows only the draft, so the conversation it names is not the card's: the card is found by its ref.
	const res = await route("POST", "/api/approvals/failed", { op: "report", ref, conv: `mail:aw-${ref.toLowerCase()}`, text: "메일 계정을 알 수 없어서 보내지 않았어요" });
	expect(res!.status).toBe(200);
	const note = await told;
	expect(note).toContain(ref);
	expect(note).toContain("메일 계정을 알 수 없어서 보내지 않았어요");
	const shown = listNotices(500).items.find((n: any) => n.decision?.draft?.ref === ref) as any;
	expect(shown.decision.send).toMatchObject({ state: "failed", text: "메일 계정을 알 수 없어서 보내지 않았어요" });
	ignoreNotice(shown.id);
});

// The card as the CLI prints it (askText), posted in a conversation of its own: what the open card holds as its draft.
const printedCard = async (conv: string, id: string) => {
	await out(conv, askText(getDraft(id)!, []));
	const open = listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === conv) as any[];
	const seen = open.map(n => [n.decision.draft?.ref, n.decision.draft?.to]);
	for (const n of open) ignoreNotice(n.id);
	return seen;
};

test("a mail draft whose recipient has no address: its card shows the sender's address the send will use and keeps its draft", async () => {
	const id = draft("이름만 아는 답", "친구");
	expect(await printedCard("mail:aw-name", id)).toEqual([[id, "friend@example.com"]]);
});

test("a draft longer than the gateway reads of a card keeps its draft: the card shows it whole", async () => {
	const id = draft("긴 답장의 한 줄이에요.\n".repeat(600));
	expect(await printedCard("mail:aw-long", id)).toEqual([[id, "friend@example.com"]]);
});

afterAll(() => {
	for (const n of openCards()) ignoreNotice(n.id);
	expect(openCards()).toEqual([]);
});

test("a failed comment reply's note goes where its card was asked, or to the main conversation when it never had one; never to the store's place (Dggtza6)", async () => {
	const place = "comment:site-aw";
	const notes: HubEvent[] = [];
	onEmit(e => void (e.kind === "out" && String(e.text).startsWith("[fail]") && notes.push(e)));
	const fail = (ref: string) => reportSend({ ref, conv: place, title: `이 답글 올릴까요? (${ref})`, state: "failed", text: "앱에서 이 글을 받지 않았어요", reason: { code: "rejected", text: "앱에서 이 글을 받지 않았어요" }, safeToAuto: false, at: Date.now() });
	// A later post to the same place passes the queue after the note, so the note is out by then.
	const flush = (to: string) => out(to, "정리했어요", undefined, { source: "gateway" });

	fail("DAWNOCARD1");
	await flush("web");
	expect(notes.filter(e => String(e.text).includes("DAWNOCARD1")).map(e => e.target)).toEqual(["web"]);

	const asked = "mail:aw-comment-card";
	// A card is read as a draft's only when it shows the stored draft (card()), so this one has a draft of its own.
	const carded = draft("카드 답");
	await out(asked, card(carded));
	fail(carded);
	await flush(asked);
	expect(notes.filter(e => String(e.text).includes(carded)).map(e => e.target)).toEqual([asked]);
	for (const n of listNotices(500).items.filter((x: any) => x.decision?.draft?.ref === carded)) ignoreNotice(n.id);
});

// The card's countdown line (a Discord card is edited with it) is drawn from the milliseconds left in the window.
test("a send in its undo window gives its card a countdown in whole seconds", () => {
	const shown = spyOn(outbound, "showSendOnCard");
	try {
		reportSend({ ref: "DAWCOUNT01", conv: "mail:aw-countdown", title: "이대로 보낼까요? (DAWCOUNT01)", state: "undo", text: "", until: Date.now() + 10_000, at: Date.now() });
		const left = shown.mock.calls.at(-1)![4]!;
		expect(Number.isFinite(left)).toBe(true);
		expect(withSendState("카드", "undo", "", left)).toContain("-# 10초 후 보내요");
	} finally {
		shown.mockRestore();
	}
});

test("답글만 보내기 through the gateway: the mail draft left behind gets one open card, also when the send is reported twice, and 보내기 on it is a mail send", async () => {
	// Its own conversation: a card waits behind the open card of its conversation, and the tests above leave one open in CONV.
	const owed = "mail:aw-owed";
	const mail = draft("메일 본문");
	const code = "DOWED00001";
	createStore(commentsDir(DATA_DIR)).putDraft({ code, commentId: "cm:x:1", source: "x", thread: "t", text: "답글", status: "sent", created: 1, changes: [], clean: true, notes: [], mail });
	const mailCards = () => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === owed && n.decision.draft?.ref === mail);
	const posts: string[] = [];
	onEmit(e => void (e.kind === "out" && e.target === owed && posts.push(String(e.text))));
	const report = () => reportSend({ ref: code, conv: owed, title: "댓글 답글 (" + code + ")", state: "sent", text: "답글만 올렸어요", at: Date.now() });
	// A later post of the same conversation passes the queue after the card, so the card is a notice by then.
	const flush = () => out(owed, "정리했어요", undefined, { source: "gateway" });
	report();
	await flush();
	expect(mailCards()).toHaveLength(1);
	report();
	await flush();
	expect(mailCards()).toHaveLength(1);
	expect(posts.filter(t => t.includes(`(${mail})`))).toHaveLength(1);
	expect(sendTargetOf(mail, "send")).toMatchObject({ kind: "mail" });
});

test("U4-6 보내기 on the card of a mail draft already sent closes the card as handled: nothing queued, the bot not asked", async () => {
	const conv = "mail:aw-sent";
	const id = draft("이미 보낸 답");
	await out(conv, card(id));
	const shown = listNotices(500).items.find(n => n.decision?.state === "open" && n.decision.to === conv && n.decision.draft?.ref === id)!;
	const hash = (await replies.view(id))!.draft.hash;
	setStatus(id, "sent");
	const bot: string[] = [];
	const r = await webAnswer(shown.id, { n: 1, hash }, "owner@example.com", async a => void bot.push(a.text));
	expect(r.status).toBe(200);
	expect(listNotices(500).items.find(n => n.id === shown.id)!.decision).toMatchObject({ state: "answered", answer: "이미 처리됨: 이미 보낸 답장이에요" });
	expect(bot).toEqual([]);
	expect(sender.results().filter(x => x.ref === id)).toEqual([]);
});

test("a new card of a draft whose card was answered is that card asked again: one card per draft in its conversation", async () => {
	const conv = "mail:aw-again";
	const id = draft("다시 물은 답");
	await out(conv, card(id));
	const first = listNotices(500).items.find(n => n.decision?.to === conv && n.decision.draft?.ref === id)!;
	settleOpenDecision(first.id, "2) 고치기");
	await out(conv, `[ask] 다시 올려요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: getDraft(id)!.body, ref: id, question: "이제 보낼까요?" })}`);
	const cards = listNotices(500).items.filter(n => n.decision?.to === conv && n.decision.draft?.ref === id);
	expect(cards.map(n => [n.id, n.decision!.state])).toEqual([[first.id, "open"]]);
	for (const n of cards) ignoreNotice(n.id);
});

test("a failed send tells every page the item as it is now, so a card redraws with the version the next 보내기 must carry", async () => {
	const conv = "mail:aw-fresh";
	const id = draft("새로 그릴 답");
	await out(conv, card(id));
	const shown = listNotices(500).items.find(n => n.decision?.state === "open" && n.decision.to === conv && n.decision.draft?.ref === id)!;
	const items: unknown[] = [];
	onBroadcast(e => void (e.kind === "reply" && e.ref === id && e.item && items.push(e.item)));
	const r = await webAnswer(shown.id, { n: 1, hash: (await replies.view(id))!.draft.hash }, "owner@example.com", async () => undefined);
	expect(r.status).toBe(200);
	await sender.idle();
	await new Promise(resolve => realSetTimeout(resolve, 50));
	expect(items.at(-1)).toMatchObject({ ref: id, send: { state: "failed" }, draft: { hash: (await replies.view(id))!.draft.hash } });
	for (const n of listNotices(500).items.filter(x => x.decision?.draft?.ref === id)) ignoreNotice(n.id);
});
