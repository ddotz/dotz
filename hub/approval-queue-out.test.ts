// The approval queue on the real outbound path (outbound.out -> events -> notices): cards the assistant posts in one conversation are
// shown one at a time, the same card again is not a second post, and closing the shown card brings the next one.
import { afterAll, expect, spyOn, test } from "bun:test";
import { realSetTimeout, realClearTimeout } from "./runtime/test-clock.ts";
import { mkdirSync, rmSync } from "node:fs";
import { type HubEvent, onEmit } from "./events.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import * as discord from "./discord.ts";
import { answerDecision, ignoreNotice, listNotices, markDraftPosted } from "./notices.ts";
import { approvals, out } from "./outbound.ts";
import { reconcileMailCards } from "./mail-card-reconcile.ts";
import { cardRef } from "./approval-queue.ts";
import { addDraft, listDrafts, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { paths } from "../features/reply-drafts/lib/settings.ts";

const card = (ref: string, body = `${ref} 님 답글이에요`) => `[ask] 댓글 답글 초안이에요\n${draftApprovalBlock({ to: `${ref} 댓글`, toLabel: "대상", body, ref, question: "이 답글 올릴까요?" })}`;
// A conversation of its own (a web-only mail conversation): other test files leave open cards in the main one.
const CONV = "mail:aq-test";
const posted: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && e.target === CONV && typeof e.text === "string" && e.text.includes("이 답글 올릴까요?") && posted.push(e)));
// The next card the queue posts in the web conversation, awaited with a deadline.
const nextCard = (ref: string) =>
	new Promise<HubEvent>((resolve, reject) => {
		const timer = realSetTimeout(() => reject(new Error(`card ${ref} never came`)), 5000);
		onEmit(e => {
			if (e.kind === "out" && e.target === CONV && String(e.text).includes(`(${ref})`)) {
				realClearTimeout(timer);
				resolve(e);
			}
		});
	});
const openCards = () => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === CONV);

// The bot's own card for a mail (`mail:<mailId>`, the way the model writes it once it has the mail) and the app's reply draft of that same mail.
const RECONV = "mail:aq-start-1a1a";
const botMailCard = `[ask] 이 메일에 답장할까요\n${draftApprovalBlock({ to: "owner@example.test", body: "문서 첨부해 드립니다.", ref: "mail:1a1a", question: "이 답장 보낼까요?" })}`;
const appDraft = {
	id: "RAAAAAA", kind: "mail", app: "mail", source: "zele", mailId: "1a1a", ref: "aq-start-1a1a",
	to: "owner@example.test", subject: "문서 요청", body: "문서 첨부해 드립니다.", status: "pending",
	created: "2026-11-02T01:00:00.000Z", changes: [], questions: [],
	item: { kind: "mail", subject: "문서 요청", text: "문서 보내 주세요", from: "sender@example.test" },
} as unknown as DraftRec;

test("a bot mail card whose mail has a waiting app draft is replaced by the app card on the start-up pass, once", async () => {
	await out(RECONV, botMailCard);
	addDraft(appDraft);
	expect(await reconcileMailCards()).toBe(1);
	const open = listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === RECONV);
	// One card for the mail, and it is the app draft's: its staged files are what the owner confirms.
	expect(open).toHaveLength(1);
	expect(open[0]!.decision!.draft!.ref).toBe("RAAAAAA");
	expect(open[0]!.text).toContain("(RAAAAAA)");
	expect(listDrafts().some(d => d.id === "RAAAAAA")).toBe(true);
	// The second start-up pass has nothing left to replace.
	expect(await reconcileMailCards()).toBe(0);
	for (const n of open) ignoreNotice(n.id);
	rmSync(paths.drafts(), { force: true });
	expect(listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === RECONV)).toEqual([]);
});

test("a card posted on Discord closes there: buttons off, and the queue goes on to the next card", async () => {
	const edit = spyOn(discord, "edit").mockImplementation(async () => ({ delivered: true }));
	try {
		await out(CONV, card("aq-dc-one"));
		await out(CONV, card("aq-dc-two"));
		markDraftPosted(CONV, "aq-dc-one", "1400000000000000001", ["1400000000000000002"]);
		const next = nextCard("aq-dc-two");
		ignoreNotice(openCards()[0].id);
		await next;
		expect(edit.mock.calls.map(c => [c[0], c[1], c[3]])).toEqual([["1400000000000000001", "1400000000000000002", { clearComponents: true }]]);
		for (const n of openCards()) ignoreNotice(n.id);
		expect(openCards()).toEqual([]);
	} finally {
		edit.mockRestore();
		posted.length = 0;
	}
});

test("three cards at once: one shows, the others wait; the same card again changes nothing; answering it shows the next", async () => {
	await out(CONV, card("aq-one"));
	await out(CONV, card("aq-two"));
	await out(CONV, card("aq-three"));
	await out(CONV, card("aq-one"));
	expect(posted.map(e => /\((aq-[a-z]+)\)/.exec(String(e.text))?.[1])).toEqual(["aq-one"]);
	expect(openCards().map((n: any) => n.decision.draft.ref)).toEqual(["aq-one"]);
	// The open card counts what waits behind it.
	expect(openCards()[0].text).toContain("남은 2건");

	const next = nextCard("aq-two");
	// 3) 보내지 않기 on the shown card (the hub answer path; the message itself goes nowhere here).
	expect((await answerDecision(openCards()[0].id, { n: 3 }, async () => {})).status).toBe(200);
	const second = await next;
	expect(String(second.text)).toContain("남은 1건");
	expect(openCards().map((n: any) => n.decision.draft.ref)).toEqual(["aq-two"]);
});

// The notice store and the queue are shared by every test file in the run: the rest of this test's cards are answered and drained.
afterAll(async () => {
	const last = nextCard("aq-three");
	for (const n of openCards()) ignoreNotice(n.id);
	await last;
	for (const n of openCards()) ignoreNotice(n.id);
	expect(openCards()).toEqual([]);
});

test("one post with several draft blocks becomes one card per draft, shown one at a time", async () => {
	const conv = "mail:aq-multi";
	const block = (ref: string) => draftApprovalBlock({ to: "friend@example.com", toLabel: "받는이", subject: `Re: ${ref}`, body: `보내 ${ref}`, ref, question: "이 답장 보낼까요?" });
	const open = () => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === conv);
	await out(conv, `[ask] 답장 초안이에요\n${["mb-1", "mb-2", "mb-3"].map(block).join("\n")}`);
	for (const ref of ["mb-1", "mb-2", "mb-3"]) {
		const [shown] = open();
		expect(open()).toHaveLength(1);
		expect(shown!.decision!.draft?.ref).toBe(ref);
		const next = new Promise<void>(resolve => onEmit(e => e.kind === "out" && e.target === conv && resolve()));
		ignoreNotice(shown!.id);
		if (ref !== "mb-3") await next;
	}
	expect(open()).toEqual([]);
});

test("the answer written after the last of several cards goes out once as its own post, not with a held card", async () => {
	const conv = "mail:aq-tail";
	const block = (ref: string) => draftApprovalBlock({ to: "friend@example.com", toLabel: "받는이", subject: `Re: ${ref}`, body: `보내 ${ref}`, ref, question: "이 답장 보낼까요?" });
	const events: HubEvent[] = [];
	onEmit(e => void (e.kind === "out" && e.target === conv && events.push(e)));
	await out(conv, `[ask] 답장 초안이에요\n${block("tl-1")}\n\n두 번째예요\n${block("tl-2")}\n\n나머지는 끝냈어요`);
	const tails = events.filter(e => String(e.text).includes("나머지는 끝냈어요"));
	expect(tails).toHaveLength(1);
	expect(cardRef(String(tails[0]!.text))).toBeUndefined();
	expect(events.map(e => cardRef(String(e.text)))).toEqual(["tl-1", undefined]);
	const open = () => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === conv);
	const second = new Promise<void>(resolve => onEmit(e => e.kind === "out" && e.target === conv && cardRef(String(e.text)) === "tl-2" && resolve()));
	ignoreNotice(open()[0]!.id);
	await second;
	const card2 = events.find(e => cardRef(String(e.text)) === "tl-2")!;
	expect(String(card2.text)).not.toContain("나머지");
	for (const n of open()) ignoreNotice(n.id);
	expect(open()).toEqual([]);
});

test("a card held in one conversation leaves the queue when the same draft is carded in another", async () => {
	const [a, b] = ["mail:aq-x-a", "mail:aq-x-b"];
	const openIn = (conv: string) => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === conv);
	await out(b, card("aq-x-first"));
	await out(b, card("aq-x-both"));
	await out(a, card("aq-x-both"));
	expect(openIn(a).map((n: any) => n.decision.draft.ref)).toEqual(["aq-x-both"]);
	// The copy held in b behind its open card is gone: closing that card shows nothing more there.
	expect(approvals.heldIn(b)).toEqual([]);
	ignoreNotice(openIn(b)[0]!.id);
	expect(approvals.heldIn(b)).toEqual([]);
	expect(openIn(b)).toEqual([]);
	for (const n of openIn(a)) ignoreNotice(n.id);
});

test("a card is posted while the reply-draft store cannot be read: the queue takes the ref as its own item", async () => {
	const conv = "mail:aq-unreadable";
	const openIn = () => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === conv);
	const shown: string[] = [];
	onEmit(e => void (e.kind === "out" && e.target === conv && shown.push(cardRef(String(e.text)) ?? "")));
	mkdirSync(paths.drafts(), { recursive: true });
	try {
		await out(conv, card("aq-unreadable-one"));
		await out(conv, card("aq-unreadable-two"));
		expect(shown).toEqual(["aq-unreadable-one"]);
		expect(approvals.heldIn(conv).map(h => h.ref)).toEqual(["aq-unreadable-two"]);
	} finally {
		rmSync(paths.drafts(), { recursive: true, force: true });
		for (const n of openIn()) ignoreNotice(n.id);
	}
});
