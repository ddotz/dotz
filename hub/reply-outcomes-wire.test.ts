// pickedSend (hub/reply-outcomes.ts) against the answer text the real gateway paths leave on a card: the web button (webAnswer), a Discord
// button (discordGatewayAnswer) and the batch answer. A retry of a failed send is only offered for a card whose answer it can read.
// The drafts are mails of a source this machine cannot send from, refused after the approval check, so nothing leaves this machine.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { realSetTimeout, realClearTimeout } from "./runtime/test-clock.ts";
import { onEmit } from "./events.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { ignoreNotice, listNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { approvalRoute, discordGatewayAnswer, sender, webAnswer } from "./approval-wire.ts";
import { pickedSend } from "./reply-outcomes.ts";
import { cfg } from "./config.ts";
import { addDraft, newId } from "../features/reply-drafts/lib/store.ts";

// The subject is how the three routes record the answer, not the cancel window: with it off the approved sends start at once.
beforeEach(() => void (cfg.web.send_undo_sec = 0));
const CONV = "mail:ro-wire-test";
const draft = (body: string) => {
	const id = newId();
	addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `ro-${id.toLowerCase()}`, to: "friend@example.com", body, status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", text: "안녕" } as never });
	return id;
};
const refs = [draft("첫째 답"), draft("둘째 답"), draft("셋째 답")];
const card = (ref: string) => `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: `${ref} 답`, ref, question: "이대로 보낼까요?" })}`;
const all = () => listNotices(500).items as any[];
const openCards = () => all().filter(n => n.decision?.state === "open" && n.decision.to === CONV);
const cardOf = (ref: string) => all().find(n => n.decision?.draft?.ref === ref);
const posted = new Set<string>();
const waiters = new Map<string, () => void>();
onEmit(e => {
	if (e.kind !== "out" || e.target !== CONV) return;
	for (const [ref, done] of waiters) if (String(e.text).includes(`(${ref})`)) (posted.add(ref), waiters.delete(ref), done());
});
const shown = (ref: string) =>
	new Promise<void>((resolve, reject) => {
		if (posted.has(ref)) return resolve();
		const timer = realSetTimeout(() => reject(new Error(`card ${ref} never came`)), 5000);
		waiters.set(ref, () => (realClearTimeout(timer), resolve()));
	});

test("the web button, a Discord button and the batch answer each leave an answer pickedSend reads as 보내기", async () => {
	const second = shown(refs[1]!);
	const third = shown(refs[2]!);
	for (const r of refs) await out(CONV, card(r));

	await webAnswer(openCards()[0].id, { n: 1 }, "owner@example.com", async () => {});
	expect(pickedSend(cardOf(refs[0]!).decision)).toBe("send");

	await second;
	const q = openCards()[0].title;
	expect(discordGatewayAnswer(CONV, CONV, "1) 보내기", [{ q, n: 1, label: "보내기" }])).toBe(true);
	expect(pickedSend(cardOf(refs[1]!).decision)).toBe("send");

	await third;
	const res = await approvalRoute(new Request("http://local/api/approvals", { method: "POST", body: JSON.stringify({ items: [{ ref: refs[2], to: CONV, n: 1 }] }) }), new URL("http://local/api/approvals"), {
		login: "owner@example.com",
		triageMin: 3,
		deliver: async () => {},
	});
	expect(await res!.json()).toEqual({ ok: true, sending: 1, toBot: 0 });
	expect(pickedSend(cardOf(refs[2]!).decision)).toBe("send");

	await sender.idle();
	for (const r of refs) expect(cardOf(r)!.decision.send.state).toBe("failed");
});

afterAll(() => {
	for (const n of openCards()) ignoreNotice(n.id);
	expect(openCards()).toEqual([]);
});
