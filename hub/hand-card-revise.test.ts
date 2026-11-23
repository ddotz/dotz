import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { realSetTimeout } from "./runtime/test-clock.ts";
import { type HubEvent, onEmit } from "./events.ts";
import * as da from "./draft-approval.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { ignoreNotice, listNotices } from "./notices.ts";
import { approvals, out } from "./outbound.ts";
import { paths } from "../features/reply-drafts/lib/settings.ts";
import "./reply-wire.ts";

const CONV = "mail:hc-test";
const MULTI = "mail:hc-multi";
const UNREADABLE = "mail:hc-unreadable";
const CONVS = [CONV, MULTI, UNREADABLE];
const events: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && e.target === CONV && events.push(e)));
const openIn = (conv: string) => listNotices(500).items.filter((n) => n.decision?.state === "open" && n.decision.to === conv);
const open = () => openIn(CONV);
const settled = (conv = CONV) => out(conv, "정리했어요", undefined, { source: "gateway" });
const until = async (what: string, ok: () => boolean) => {
	const deadline = Date.now() + 5000;
	while (!ok()) {
		if (Date.now() > deadline) throw new Error(`${what} never happened`);
		await new Promise<void>(resolve => realSetTimeout(resolve, 10));
	}
};

type Card = { subject?: string; to?: string; body: string; question: string };
const block = (ref: string, o: Card) =>
	draftApprovalBlock({ to: o.to ?? "Kim <kim@example.com>", toLabel: "받는이", subject: o.subject ?? "RE: 제목A", attachments: [{ name: "fileA.xlsx" }], body: o.body, ref, question: o.question });
const hand = (ref: string, o: Card & { lead: string; mark?: string }) => `[ask] ${o.lead}\n\n[file] /tmp/fileA.xlsx\n\n${block(ref, o)}${o.mark ? `\n${o.mark}` : ""}`;
const body3 = "Kim님 안녕하세요.\n\n표 첫 줄은 12입니다.\n마무리 3";
const body4 = "Kim님 안녕하세요.\n\n표 첫 줄은 15입니다.\n마무리 4";
const gatewayNotes = () => events.filter(e => e.source === "gateway");

test("a revised hand-written card is posted again as the same notice, with its lead prose, and the bot's own [drop] of the old one is not acted on", async () => {
	await out(CONV, hand("hand-3", { lead: "초안을 만들었어요.", body: body3, question: "이 메일 보낼까요?" }));
	const [first] = open();
	expect(open()).toHaveLength(1);
	expect(first!.decision!.draft!.ref).toBe("hand-3");
	const before = events.length;

	await out(CONV, hand("hand-4", { lead: "표 숫자를 고쳤어요.", body: body4, question: "고친 메일 보낼까요?", mark: "[drop hand-3]" }));
	await settled();

	const now = open();
	expect(now).toHaveLength(1);
	expect(now[0]!.id).toBe(first!.id);
	expect(now[0]!.decision!.draft!.ref).toBe("hand-4");
	expect(now[0]!.decision!.draft!.body).toBe(body4);
	expect(now[0]!.title).toBe("고친 메일 보낼까요? (hand-4)");
	const posts = events.slice(before).filter(e => e.source !== "gateway");
	expect(posts).toHaveLength(1);
	expect(String(posts[0]!.text)).toContain("표 숫자를 고쳤어요.");
	expect(String(posts[0]!.text)).toContain("(hand-4)");
	expect(String(posts[0]!.text)).not.toContain("[drop");
	expect(posts[0]!.repost).toBe(first!.id);
	expect(events.filter(e => String(e.text).includes("표 숫자를 고쳤어요.")).length).toBe(1);
	expect(approvals.heldIn(CONV)).toEqual([]);
	await until("the shown card follows hand-4", () => approvals.openCard(CONV)?.ref === "hand-4");
	const title = approvals.openCard(CONV)!.title;
	expect(title.startsWith(">") || title.startsWith("-#")).toBe(false);
	expect(gatewayNotes().filter(e => String(e.text).includes("반영하지 못했어요"))).toEqual([]);
});

test("the same card again changes nothing; a hand card of another subject waits behind the open one and is named by its question when it comes", async () => {
	const before = events.length;
	await out(CONV, hand("hand-4", { lead: "다시 올려요.", body: body4, question: "고친 메일 보낼까요?" }));
	expect(events.slice(before).filter(e => e.source !== "gateway" && e.repost !== undefined)).toEqual([]);

	await out(CONV, hand("hand-5", { lead: "다른 메일도 만들었어요.", subject: "RE: 제목B", body: "Kim님 다른 건입니다.", question: "다른 메일 보낼까요?" }));
	expect(approvals.heldIn(CONV).map(h => h.ref)).toEqual(["hand-5"]);
	expect(open().map(n => n.decision?.draft?.ref)).toEqual(["hand-4"]);
	expect(events.slice(before).some(e => String(e.text).includes("(hand-5)"))).toBe(false);

	ignoreNotice(open()[0]!.id);
	await until("hand-5 shown", () => approvals.openCard(CONV)?.ref === "hand-5");
	expect(approvals.openCard(CONV)!.title).toBe("다른 메일 보낼까요?");
	expect(approvals.heldIn(CONV)).toEqual([]);
});

test("the mail a hand-written card is about: conversation, recipient addresses and subject; a card with no subject has no key", () => {
	const draft = (to: string, subject?: string, toLabel = "받는이") => ({ toLabel, to, body: "x", ...(subject === undefined ? {} : { subject }) });
	const key = (d: Parameters<typeof da.handMailKey>[1], conv = "c") => da.handMailKey(conv, d);
	const kim = key(draft("Kim <kim@example.com>", " RE: 제목A "));
	expect(kim).toBeDefined();
	expect(key(draft("kim@EXAMPLE.com", "RE: 제목A"))).toBe(kim);
	expect(key(draft("Kim <kim@example.com>, Lee <lee@example.com>", "RE: 제목A"))).toBe(key(draft("lee@example.com; kim@example.com", "RE: 제목A")));
	expect(key(draft("Kim <kim@example.com>, Lee <lee@example.com>", "RE: 제목A"))).not.toBe(kim);
	expect(key(draft("Kim <kim@example.com>", "RE: 제목B"))).not.toBe(kim);
	expect(key(draft("Kim <kim@example.com>", "RE: 제목A"), "d")).not.toBe(kim);
	expect(key(draft("Kim <kim@example.com>", "RE: 제목A", "대상"))).not.toBe(kim);
	expect(key(draft("Kim <kim@example.com>", "  "))).toBeUndefined();
	expect(key(draft("Kim <kim@example.com>"))).toBeUndefined();
	expect(key(undefined)).toBeUndefined();
	expect(key(draft(" 팀 채널 ", "RE: 제목A"))).toBe(key(draft("팀 채널", "RE: 제목A")));
	expect(key(draft("팀 채널", "RE: 제목A"))).not.toBe(key(draft("다른 채널", "RE: 제목A")));
	expect(key(draft("팀 채널", "RE: 제목A"))).not.toBe(kim);
});

test("a post with several cards, one of them a revision of the open card: the bot's own [drop] of the old one is not acted on", async () => {
	const notes: HubEvent[] = [];
	onEmit(e => void (e.kind === "out" && e.target === MULTI && e.source === "gateway" && notes.push(e)));
	await out(MULTI, hand("hand-23", { lead: "초안을 만들었어요.", body: body3, question: "이 메일 보낼까요?" }));
	const [first] = openIn(MULTI);
	expect(first!.decision!.draft!.ref).toBe("hand-23");

	const revised = block("hand-23", { body: body4, question: "고친 메일 보낼까요?" });
	const other = block("hand-29", { subject: "RE: 제목B", body: "Kim님 다른 건입니다.", question: "다른 메일 보낼까요?" });
	await out(MULTI, `[ask] 두 초안이에요\n\n${revised}\n\n${other}\n[drop hand-23]`);
	await settled(MULTI);

	expect(openIn(MULTI).map(n => [n.id, n.decision?.draft?.ref, n.decision?.draft?.body])).toEqual([[first!.id, "hand-23", body4]]);
	expect(approvals.heldIn(MULTI).map(h => h.ref)).toEqual(["hand-29"]);
	expect(notes.filter(e => String(e.text).includes("반영하지 못했어요"))).toEqual([]);
});

test("a revision while the reply-draft store cannot be read still replaces the open card", async () => {
	await out(UNREADABLE, hand("hand-7", { lead: "초안을 만들었어요.", body: body3, question: "이 메일 보낼까요?" }));
	rmSync(paths.drafts(), { recursive: true, force: true });
	mkdirSync(paths.drafts(), { recursive: true });
	try {
		await out(UNREADABLE, hand("hand-7", { lead: "표 숫자를 고쳤어요.", body: body4, question: "이 메일 보낼까요?" }));
		expect(openIn(UNREADABLE).map(n => n.decision?.draft?.body)).toEqual([body4]);
	} finally {
		rmSync(paths.drafts(), { recursive: true, force: true });
	}
});

afterAll(() => {
	for (const conv of CONVS) approvals.take(conv, approvals.heldIn(conv).map(h => h.ref));
	for (const conv of CONVS) for (const n of openIn(conv)) ignoreNotice(n.id);
	expect(CONVS.flatMap(openIn)).toEqual([]);
});
