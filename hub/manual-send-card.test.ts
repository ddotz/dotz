// A send card the session writes by hand becomes a draft of the reply store: the card the owner reads, the text the store keeps and the text the
// sender gets are one text (hub/approval-queue.ts storeCard, on the post path of every send-approval card).
import { afterAll, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { runDraft } from "../features/reply-drafts/bin/draft.ts";
import { paths } from "../features/reply-drafts/lib/settings.ts";
import { getDraft, listDrafts } from "../features/reply-drafts/lib/store.ts";
import { mailHash } from "../features/reply-drafts/lib/view.ts";
import { storeCard } from "./approval-queue.ts";
import { approvalHash } from "./approval-send.ts";
import { appendSealed } from "./approval-seal.ts";
import { draftApprovalBlock, parseDraftApproval } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { postMail, type MailDeps } from "./mail.ts";
import { listNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { createReplyActions, type OpenCard, type ReplyDeps } from "./reply-actions.ts";
import type { DraftView, ReplyAdapter } from "./reply-types.ts";

const env = setupEnv();
afterAll(env.cleanup);

const mailDeps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: e => emit("inbox", e as Parameters<typeof emit>[1]), wake: () => undefined };
let seq = 0;
const incoming = async () => (await postMail({ source: "zele", id: `msc${++seq}`, subject: "점검 결과 부탁드립니다", from: "Kim <kim@example.com>", to: "me@example.com", account: "me@example.com", body: "점검 결과 보내 주세요" }, mailDeps)).key;
const SUBJECT = "Re: 점검 결과 부탁드립니다";
const handCard = (ref: string, body: string, to = "kim@example.com", subject = SUBJECT) => `[ask] 답장 초안이에요\n${draftApprovalBlock({ to, toLabel: "받는이", subject, body, ref, question: "이 답장 보낼까요?" })}`;
const openCards = (conv: string) => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === conv);

test("(a) a hand-written card in a mail conversation becomes a store draft and the card posted is the store's block", async () => {
	const key = await incoming();
	const conv = `mail:${key}`;
	await out(conv, handCard("mail:hand1", "확인해 보고 말씀드릴게요.\n감사합니다."));
	const drafts = listDrafts().filter(d => d.ref === key);
	expect(drafts).toHaveLength(1);
	const rec = drafts[0]!;
	expect([rec.kind, rec.status, rec.compose ?? false, rec.source, rec.mailId.startsWith("compose-"), rec.account, rec.to, rec.subject, rec.body]).toEqual(["mail", "pending", false, "zele", false, "me@example.com", "kim@example.com", SUBJECT, "확인해 보고 말씀드릴게요.\n감사합니다."]);
	const open = openCards(conv);
	expect(open).toHaveLength(1);
	expect(open[0]!.decision!.draft!.ref).toBe(rec.id);
	expect(open[0]!.text).toContain(`(${rec.id})`);
	expect(open[0]!.text).not.toContain("mail:hand1");
});

test("(a2) a hand-written card on a plugin source's mail becomes a draft that answers through that source", async () => {
	const key = (await postMail({ source: "acme", id: "p1", subject: "일정 문의", from: "Park <park@example.com>", body: "일정 알려 주세요" }, mailDeps)).key;
	const conv = `mail:${key}`;
	await out(conv, handCard("mail:hand-p", "다음 주 화요일에 가능합니다.", "park@example.com", "Re: 일정 문의"));
	const rec = listDrafts().find(d => d.ref === key)!;
	expect([rec.source, rec.mailId, rec.compose ?? false, rec.body]).toEqual(["acme", "p1", false, "다음 주 화요일에 가능합니다."]);
	expect(openCards(conv)[0]!.decision!.draft!.ref).toBe(rec.id);
});

test("(b) outside a mail thread a card to one plain address becomes a new mail draft; any other card stays as written with one 확인 line", async () => {
	const posted: unknown[] = [];
	const deps = { hub: { post: async (path: string, body: unknown) => (posted.push([path, body]), { status: 200 }) } };
	const card = handCard("hand-new", "견적서 보내 드립니다.\n\n  - 항목 하나", "lee@example.com", "견적 문의");
	const stored = await storeCard("main", card, deps as never);
	const rec = listDrafts().find(d => d.compose && d.to === "lee@example.com")!;
	expect([rec.kind, rec.status, rec.app, rec.subject, rec.body]).toEqual(["mail", "pending", "mail", "견적 문의", "견적서 보내 드립니다.\n\n  - 항목 하나"]);
	expect(parseDraftApproval(stored)).toMatchObject({ ref: rec.id, body: rec.body });
	expect(posted).toHaveLength(1);
	// The same card again (a revised text) is the same draft.
	await storeCard("main", handCard("hand-new-2", "견적서를 다시 보내 드립니다.", "lee@example.com", "견적 문의"), deps as never);
	expect(listDrafts().filter(d => d.compose && d.to === "lee@example.com").map(d => [d.id, d.body])).toEqual([[rec.id, "견적서를 다시 보내 드립니다."]]);
	// Two recipients, or a mail the hub does not know: the card goes out as written, with the reason on one line.
	const before = listDrafts().length;
	const several = handCard("hand-two", "안녕하세요.", "a@example.com, b@example.com", "공지");
	const noted = await storeCard("main", several, deps as never);
	expect(noted.split("\n").filter(l => l.includes("확인:"))).toHaveLength(1);
	expect(noted.replace(/^-# 확인:.*\n/m, "")).toBe(several);
	const unknown = await storeCard("mail:zele-nope", handCard("hand-lost", "안녕하세요."), deps as never);
	expect(unknown).toContain("확인:");
	expect(listDrafts()).toHaveLength(before);
});

test("(c) a send is refused card_mismatch when the open card shows another body than the stored draft, and nothing is sent", async () => {
	const stored = "저장된 글이에요.\n둘째 줄";
	const view: DraftView = { item: "mail:k1", ref: "RAAAAAA", kind: "mail", app: "mail", label: "메일", conv: "mail:k1", at: 0, can: { send: true, revise: true, edit: true, drop: true, restore: true }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: stored } };
	const adapter: ReplyAdapter = { kind: "mail", get: async ref => (ref === view.ref ? view : undefined), list: async () => [view], target: () => ({ kind: "mail", lane: "mail:x" }), revise: async () => ({ ok: false, reason: { code: "revise_failed", text: "" } }), edit: async () => ({ ok: true }), drop: async () => ({ ok: true }), restore: async () => ({ ok: true }), markSent: async () => ({ ok: true }), ask: async ref => `[ask] 카드 (${ref})`, question: ref => `이 답장 보낼까요? (${ref})` };
	let sends = 0;
	const shown = (body: string): OpenCard => ({ ref: view.ref, conv: "mail:k1", notice: "n1", title: "t", hash: approvalHash(view), draft: { toLabel: "받는이", to: "kim@example.com", body } });
	let card = shown("카드에 보인 다른 글이에요.\n둘째 줄");
	const deps = {
		adapters: [adapter],
		sender: { enqueue: () => (sends++, true), cancel: () => "none", settle: () => undefined, forget: () => false, results: () => [] },
		recordPick: () => undefined,
		learning: { record: async () => ({ kind: "correction", stored: false, replaced: [] }), refine: async () => undefined, forbid: async () => undefined },
		cards: { open: () => [card], replace: () => undefined, rewrite: () => undefined, repost: async () => undefined, close: () => undefined },
		toBot: async () => undefined,
		emit: () => undefined,
		log: () => undefined,
	} as unknown as ReplyDeps;
	const replies = createReplyActions(deps);
	const send = () => replies.act({ ref: view.ref, action: "send", hash: approvalHash(view) }, { surface: "web", login: "me" });
	const no = await send();
	expect(no.status).toBe(409);
	expect(no.body).toMatchObject({ ok: false, code: "card_mismatch" });
	expect(sends).toBe(0);
	card = shown(stored);
	expect((await send()).status).toBe(200);
	expect(sends).toBe(1);
});

test("(d) a revised hand-written card is the same store draft and the one open card, not a second", async () => {
	const key = await incoming();
	const conv = `mail:${key}`;
	await out(conv, handCard("mail:hand2", "처음 쓴 글이에요."));
	const first = listDrafts().find(d => d.ref === key)!;
	await out(conv, handCard("mail:hand2b", "고친 글이에요.\n하나 더 고쳤어요."));
	expect(listDrafts().filter(d => d.ref === key).map(d => [d.id, d.body, d.status])).toEqual([[first.id, "고친 글이에요.\n하나 더 고쳤어요.", "pending"]]);
	const open = openCards(conv);
	expect(open).toHaveLength(1);
	expect(open[0]!.decision!.draft!.ref).toBe(first.id);
	expect(open[0]!.text).toContain("고친 글이에요.");
	expect(open[0]!.text).not.toContain("처음 쓴 글이에요.");
});

test("(e) indentation, blank lines and a line with leading spaces are the same in the card, the store and the body the sender gets", async () => {
	const key = await incoming();
	const conv = `mail:${key}`;
	const body = "첫 줄이에요.\n\n둘째 문단이에요.\n  - 항목 하나\n    - 하위 항목\n\n끝이에요.";
	await out(conv, handCard("mail:hand3", body));
	const rec = listDrafts().find(d => d.ref === key)!;
	expect(rec.body).toBe(body);
	expect(parseDraftApproval(openCards(conv)[0]!.text)?.body).toBe(body);
	appendSealed(paths.inbox(), { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", channel: conv, author: "owner", text: "보내기", picks: [{ q: `이 답장 보낼까요? (${rec.id})`, n: 1, label: "보내기", hash: mailHash(getDraft(rec.id)!) }] });
	const sent: string[] = [];
	const r = await runDraft(["send", rec.id], "", { send: async (d: { body: string }) => (sent.push(d.body), { ok: true as const, message: "sent (fake)" }), hub: { post: async () => ({ status: 200 }) } } as never);
	expect(r.code).toBe(0);
	expect(sent).toEqual([body]);
});
