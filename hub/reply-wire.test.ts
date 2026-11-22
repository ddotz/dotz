// The live reply flow on the real modules (design lane C1): POST /api/reply/act sends a mail draft through the one queue, writes the owner's
// sealed pick before it, holds the undo window, refuses a second send while the first waits, and the undo takes the pick back. 되돌리기 after
// 보내지 않기 (POST /api/notices/reopen) puts the dropped draft back through the same flow's restore.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { approvalHash } from "./approval-send.ts";
import { isSealed, readSealKey } from "./approval-seal.ts";
import { onBroadcast, onEmit, type HubEvent } from "./events.ts";
import { draftAttachRoute } from "./draft-attach.ts";
import { draftRecipientsRoute } from "./draft-recipients.ts";
import { cfg, paths } from "./config.ts";
import { draftApprovalBlock, draftVerdict } from "./draft-approval.ts";
import { answerDecision, listNotices, markCardShown, markDraftPosted, stampDraftCard } from "./notices.ts";
import { out } from "./outbound.ts";
import { replyRoute } from "./reply-route.ts";
import { replies, sender } from "./reply-wire.ts";
import { discordGatewayAnswer, webAnswer } from "./approval-wire.ts";
import { routeNotices } from "./routes-notices.ts";
import { addDraft, getDraft, newId, patchDraft, setStatus } from "../features/reply-drafts/lib/store.ts";
import { restoreDraft } from "../features/reply-drafts/lib/flow.ts";
import { mailHash } from "../features/reply-drafts/lib/view.ts";

process.env.DOTZ_DIR = dirname(paths.inbox);
beforeEach(() => void (cfg.web.send_undo_sec = 10));
const CONV = "mail:wire-test";
const mailDraft = (id: string, mailRef = `wt-${id.toLowerCase()}`) => addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: mailRef, to: "friend@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", text: "안녕" } as never });
const ref = newId();
mailDraft(ref);
const cardText = (id: string) => `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "받는이", body: "답", ref: id, question: "이 답장 보낼까요?" })}`;
const cardOf = (id: string) => listNotices(500).items.find((n: any) => n.decision?.draft?.ref === id) as any;
const reopen = (id: string) => routeNotices(new Request("http://local/api/notices/reopen", { method: "POST", body: JSON.stringify({ ids: [id] }) }), new URL("http://local/api/notices/reopen"));
const act = (b: object, agent = false) => replyRoute(new Request("http://local/api/reply/act", { method: "POST", body: JSON.stringify(b) }), new URL("http://local/api/reply/act"), { replies, login: "owner@example.com", agent });
const openCard = () => listNotices(500).items.find((n: any) => n.decision?.state === "open" && n.decision.draft?.ref === ref) as any;
const verdict = () => draftVerdict(paths.inbox, ref, 0, mailHash(getDraft(ref)!)).verdict;
const post = (path: string, body: object) => new Request(`http://local${path}`, { method: "POST", body: JSON.stringify(body) });
// The version the reply item shows now: what a web card's 보내기 names.
const shownHash = async (id: string) => (await replies.view(id))!.draft.hash;
const lastPick = () => (JSON.parse(readFileSync(paths.inbox, "utf8").trim().split("\n").findLast(l => l.includes(`(${ref})`) && l.includes('"picks"'))!) as { picks: { label: string; hash?: string }[] }).picks[0]!;

test("send through /api/reply/act: the pick is sealed where the card was asked, the window holds, a second send is refused, undo takes it back", async () => {
	await out(CONV, cardText(ref));
	expect(openCard()).toBeDefined();
	expect((await act({ ref, action: "drop" }, true))!.status).toBe(403);
	expect((await act({ ref, action: "send" }, true))!.status).toBe(403);

	const sent = (await act({ ref, action: "send", hash: await shownHash(ref) }))!;
	expect(sent.status).toBe(200);
	// Inside its undo window the pick sends nothing from a CLI (qa-clean-7 N13): only the gateway's sender, at the window's end.
	expect(verdict()).toBe("waiting");
	expect(lastPick()).toMatchObject({ label: "보내기", hash: approvalHash((await replies.list()).find(i => i.ref === ref)!) });
	// What the owner approved cannot change while its send waits: not the recipients, not the files.
	const to = await draftRecipientsRoute(post(`/api/drafts/${ref}/recipients`, { to: ["other@example.com"] }), ref);
	expect([to.status, ((await to.json()) as { code: string }).code]).toEqual([409, "already_sending"]);
	const files = await draftAttachRoute(post(`/api/drafts/${ref}/files`, { remove: 0 }), new URL(`http://local/api/drafts/${ref}/files`), ref, "files");
	expect([files.status, ((await files.json()) as { code: string }).code]).toEqual([409, "already_sending"]);
	expect(getDraft(ref)?.to).toBe("friend@example.com");
	expect(openCard()).toBeUndefined();
	expect(sender.results(CONV).find(r => r.ref === ref)?.state).toBe("undo");

	const again = (await act({ ref, action: "send", hash: await shownHash(ref) }))!;
	expect(again.status).toBe(409);
	expect((await again.json()).code).toBe("already_sending");

	expect((await act({ ref, action: "undo" }))!.status).toBe(200);
	expect(verdict()).toBe("undo");
	expect(getDraft(ref)?.status).toBe("pending");
	expect(openCard().decision.send).toMatchObject({ state: "back" });
});

test("되돌리기 after 보내지 않기 restores the dropped draft through the reply flow, and its card waits again", async () => {
	const id = newId();
	mailDraft(id);
	await out("mail:wire-restore", cardText(id));
	const card = cardOf(id);
	expect((await webAnswer(card.id, { n: 3 }, "owner@example.com", async () => undefined)).status).toBe(200);
	expect(getDraft(id)?.status).toBe("dropped");
	expect(((await (await reopen(card.id))!.json()) as { reopened: string[] }).reopened).toEqual([card.id]);
	expect(getDraft(id)?.status).toBe("pending");
	expect(cardOf(id).decision.state).toBe("open");
});

test("a reopen of a card answered 보내기 leaves the sent draft alone", async () => {
	const id = newId();
	mailDraft(id);
	await out("mail:wire-reopen-sent", cardText(id));
	const card = cardOf(id);
	await answerDecision(card.id, { n: 1 }, async () => undefined);
	setStatus(id, "sent");
	await reopen(card.id);
	expect(getDraft(id)?.status).toBe("sent");
});

test("restoreDraft refuses a sent or replaced draft and one whose mail has a newer draft waiting", async () => {
	const [sent, older, newer, newest] = [newId(), newId(), newId(), newId()];
	mailDraft(sent);
	setStatus(sent, "sent");
	expect(await restoreDraft(sent)).toMatchObject({ ok: false });
	const mailRef = `wt-shared-${older.toLowerCase()}`;
	mailDraft(older, mailRef);
	mailDraft(newer, mailRef); // the newer draft of the same mail makes the older one stale
	expect(getDraft(older)!.status).toBe("stale");
	expect(await restoreDraft(older)).toMatchObject({ ok: false });
	setStatus(newer, "dropped");
	mailDraft(newest, mailRef);
	expect(await restoreDraft(newer)).toMatchObject({ ok: false });
	expect([getDraft(newer)!.status, getDraft(newest)!.status]).toEqual(["dropped", "pending"]);
	expect(await restoreDraft("RZZZZZ2")).toMatchObject({ ok: false });
});

test("D1: the hub token on a draft's card answer is an agent's: a 보내기 or 보내지 않기 pick is 403 owner_only and nothing is queued or dropped", async () => {
	const id = newId(), conv = "mail:wire-agent";
	mailDraft(id);
	await out(conv, cardText(id));
	const card = cardOf(id);
	const deliver = async () => void 0;
	for (const pick of [{ n: 1, label: "보내기" }, { n: 3, label: "보내지 않기" }, { n: 1 }]) {
		const r = await webAnswer(card.id, pick, "hub-token", deliver, true);
		expect([r.status, (r.body as { code?: string }).code]).toEqual([403, "owner_only"]);
	}
	expect([sender.results().some(r => r.ref === id), getDraft(id)?.status, cardOf(id).decision.state]).toEqual([false, "pending", "open"]);
});

test("D3: an edit redraws the card with its hash; a Discord pick counts only while that message shows the card: a change or an edit Discord did not take is refused, nothing queued", async () => {
	const id = newId(), conv = "mail:wire-discord";
	mailDraft(id);
	await out(conv, cardText(id));
	const pick = () => discordGatewayAnswer("x", conv, "1) 보내기", [{ q: cardOf(id).title, n: 1, label: "보내기" }]);
	const hashNow = () => shownHash(id);
	const queued = () => sender.results().some(r => r.ref === id);
	// The Discord 고치기 form's text: saved as written, and the card keeps the saved version's hash.
	expect(await discordGatewayAnswer("x", conv, "2) 고치기", [{ q: cardOf(id).title, n: 2, label: "고치기" }], "다음 주에 다시 연락드릴게요.")).toEqual({});
	expect([getDraft(id)?.body, cardOf(id).decision.state, cardOf(id).decision.hash]).toEqual(["다음 주에 다시 연락드릴게요.", "open", await hashNow()]);
	// Never posted to Discord: no Discord message shows it, so a Discord pick sends nothing.
	expect([await pick(), queued()]).toEqual([{ error: expect.any(String) }, false]);
	// Posted as one message showing the card's text.
	markDraftPosted(conv, id, "ch:wire-discord", ["1400000000000000001"]);
	// The draft changes where the card did not see it (a CLI): the Discord 보내기 sends nothing and the card shows the new version.
	const drawn = cardOf(id).decision.hash;
	patchDraft(id, { body: "카드가 보지 못한 글" });
	// Refused: the owner hears why (hub/askbuttons.ts answers it ephemerally and leaves the buttons).
	expect([await pick(), queued()]).toEqual([{ error: expect.any(String) }, false]);
	expect([cardOf(id).decision.state, cardOf(id).decision.hash === drawn, cardOf(id).decision.hash, cardOf(id).text.includes("카드가 보지 못한 글")]).toEqual(["open", false, await hashNow(), true]);
	// The card is redrawn, but Discord did not take the edit (no Discord here): its message still shows the old text, so its pick is refused again.
	expect([await pick(), queued()]).toEqual([{ error: expect.any(String) }, false]);
	// Once an edit there lands, the message shows the card again and its pick sends.
	markCardShown(conv, id, cardOf(id).text);
	expect(await pick()).toEqual({});
	expect(sender.results().find(r => r.ref === id)?.state).toBe("undo");
	expect((await act({ ref: id, action: "undo" }))!.status).toBe(200);
});

test("a card keeps the version it shows only when that is the store's; a store written outside the hub voids it: the old card's pick is refused `changed`, nothing queued, the card redrawn; a card with none is refused and redrawn the same", async () => {
	const conv = "mail:wire-unseen", [shown, hand] = [newId(), newId()];
	mailDraft(shown);
	mailDraft(hand);
	// One card drawn from its store, one written by hand that names another recipient than the store's.
	await out(conv, (await replies.ask(shown))!);
	await out("mail:wire-unseen-2", cardText(hand));
	await Promise.all([stampDraftCard(cardOf(shown).id), stampDraftCard(cardOf(hand).id)]);
	expect([cardOf(shown).decision.hash, cardOf(hand).decision.hash]).toEqual([await shownHash(shown), undefined]);
	const answer = (id: string, hash?: string) => webAnswer(cardOf(id).id, { n: 1, label: "보내기", ...(hash ? { hash } : {}) }, "owner@example.com", async () => undefined);

	// A session's CLI rewrites the stored draft; the card still shows the old text.
	const seen = cardOf(shown).decision.hash;
	patchDraft(shown, { body: "카드가 보지 못한 글" });
	const old = await answer(shown, seen);
	expect([old.status, (old.body as { code?: string }).code]).toEqual([409, "changed"]);
	// The card now shows the new version and keeps it; a second pick naming the old one is refused the same.
	expect([cardOf(shown).decision.hash, cardOf(shown).text.includes("카드가 보지 못한 글")]).toEqual([await shownHash(shown), true]);
	expect((await answer(shown, seen)).status).toBe(409);

	// The hand-written card recorded no version: refused, then drawn from the store with its version.
	const none = await answer(hand);
	expect([none.status, (none.body as { code?: string }).code, cardOf(hand).decision.hash]).toEqual([409, "changed", await shownHash(hand)]);
	expect(sender.results().some(r => r.ref === shown || r.ref === hand)).toBe(false);
	// The owner picks again on the card as it is drawn now: it sends.
	for (const id of [shown, hand]) {
		expect((await answer(id, cardOf(id).decision.hash)).status).toBe(200);
		expect((await act({ ref: id, action: "undo" }))!.status).toBe(200);
	}
});

test("a draft's card opening tells every surface once, with the reply as that card shows it (its conversation and notice)", async () => {
	const id = newId(), conv = "mail:wire-carded";
	mailDraft(id);
	const seen: Record<string, unknown>[] = [];
	const told = new Promise<void>(r => onBroadcast(e => void (e.kind === "reply" && e.ref === id && e.item && (seen.push(e), r()))));
	await out(conv, cardText(id));
	await told;
	const shown = seen.map(e => e.item as { ref: string; conv: string; notice: string; draft: { hash: string } });
	expect(shown.map(i => [i.ref, i.conv, i.notice, i.draft.hash])).toEqual([[id, conv, cardOf(id).id, (await replies.view(id))!.draft.hash]]);
});

test("a confirm card is the same notice posted again at the bottom: one card, asked by the new post, holding the version it shows; nothing is sent", async () => {
	const id = newId(), conv = "mail:wire-confirm";
	mailDraft(id);
	await out(conv, cardText(id));
	const before = cardOf(id);
	const posted = new Promise<HubEvent>(r => onEmit(e => void (e.kind === "out" && e.target === conv && e.repost === before.id && r(e))));
	const r = await replies.confirm({ ref: id }, { surface: "chat", owner: { mid: "m-c1", text: "보내" } });
	const e = await posted;
	const open = listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.draft?.ref === id) as any[];
	expect([r.status, open.length, open[0].id, open[0].decision.reply_to === e.ts, open[0].decision.hash, String(e.text).includes("보낼까요? → 받는이 friend@example.com")]).toEqual([200, 1, before.id, true, (await replies.view(id))!.draft.hash, true]);
	expect(sender.results().some(x => x.ref === id)).toBe(false);
});

test("a drop the model read from the owner's words is his sealed pick, marked read by the model and naming his message", async () => {
	const id = newId(), conv = "mail:wire-model-drop";
	mailDraft(id);
	await out(conv, cardText(id));
	expect((await replies.act({ ref: id, action: "drop" }, { surface: "chat", owner: { mid: "m-d1", text: "메일 안 보내도 돼" } })).status).toBe(200);
	const line = JSON.parse(readFileSync(paths.inbox, "utf8").trim().split("\n").findLast(l => l.includes(`(${id})`) && l.includes('"picks"'))!);
	expect([line.read_by, line.owner_msg, line.picks[0].label, isSealed(readSealKey(paths.inbox), line), draftVerdict(paths.inbox, id, 0, undefined).verdict]).toEqual(["model", "m-d1", "보내지 않기", true, "drop"]);
});

test("D8: a staged file swapped for one of the same name with other bytes is another version (size, then content)", async () => {
	const id = newId();
	mailDraft(id);
	const dir = join(process.env.DOTZ_DIR!, "draft-files", id, "0");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "score.pdf");
	const hashOf = async () => (await replies.view(id))!.draft.hash;
	writeFileSync(file, "part one ");
	const first = await hashOf();
	writeFileSync(file, "part three, longer");
	const bigger = await hashOf();
	writeFileSync(file, "part three, LONGER");
	utimesSync(file, new Date(), new Date(Date.now() + 5000));
	const sameSize = await hashOf();
	expect(new Set([first, bigger, sameSize]).size).toBe(3);
	expect(await hashOf()).toBe(sameSize);
	rmSync(join(process.env.DOTZ_DIR!, "draft-files", id), { recursive: true, force: true });
});
