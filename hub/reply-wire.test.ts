// The live reply flow on the real modules (design lane C1): POST /api/reply/act sends a mail draft through the one queue, writes the owner's
// sealed pick before it, holds the undo window, refuses a second send while the first waits, and the undo takes the pick back. 되돌리기 after
// 보내지 않기 (POST /api/notices/reopen) puts the dropped draft back through the same flow's restore.
import { beforeEach, expect, test } from "bun:test";
import { dirname } from "node:path";
import { cfg, paths } from "./config.ts";
import { draftApprovalBlock, draftVerdict } from "./draft-approval.ts";
import { answerDecision, listNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { replyRoute } from "./reply-route.ts";
import { replies, sender } from "./reply-wire.ts";
import { webAnswer } from "./approval-wire.ts";
import { routeNotices } from "./routes-notices.ts";
import { addDraft, getDraft, newId, setStatus } from "../features/reply-drafts/lib/store.ts";
import { restoreDraft } from "../features/reply-drafts/lib/flow.ts";

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
const verdict = () => draftVerdict(paths.inbox, ref, 0, { conv: CONV }).verdict;

test("send through /api/reply/act: the pick is sealed where the card was asked, the window holds, a second send is refused, undo takes it back", async () => {
	await out(CONV, cardText(ref));
	expect(openCard()).toBeDefined();
	expect((await act({ ref, action: "drop" }, true))!.status).toBe(403);

	const sent = (await act({ ref, action: "send" }))!;
	expect(sent.status).toBe(200);
	expect(verdict()).toBe("send");
	expect(openCard()).toBeUndefined();
	expect(sender.results(CONV).find(r => r.ref === ref)?.state).toBe("undo");

	const again = (await act({ ref, action: "send" }))!;
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

test("restoreDraft refuses a sent or replaced draft and one whose mail has a newer draft waiting", () => {
	const [sent, older, newer, newest] = [newId(), newId(), newId(), newId()];
	mailDraft(sent);
	setStatus(sent, "sent");
	expect(restoreDraft(sent)).toMatchObject({ ok: false });
	const mailRef = `wt-shared-${older.toLowerCase()}`;
	mailDraft(older, mailRef);
	mailDraft(newer, mailRef); // the newer draft of the same mail makes the older one stale
	expect(getDraft(older)!.status).toBe("stale");
	expect(restoreDraft(older)).toMatchObject({ ok: false });
	setStatus(newer, "dropped");
	mailDraft(newest, mailRef);
	expect(restoreDraft(newer)).toMatchObject({ ok: false });
	expect([getDraft(newer)!.status, getDraft(newest)!.status]).toEqual(["dropped", "pending"]);
	expect(restoreDraft("RZZZZZ2")).toMatchObject({ ok: false });
});
