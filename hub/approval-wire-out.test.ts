// The gateway's own send path on the real modules (outbound.out -> queue -> notices -> inbox -> the real draft.ts send CLI): 보내기 on a
// card shows the next card at once with no model turn, the send runs in the background and its result lands on the card, a failure is one
// [fail] note, and the batch answer sends the picked cards, hands 고치기 to the bot in one message and leaves the skipped ones waiting.
// The drafts are mails of a source this machine cannot send from, refused after the approval check, so nothing leaves this machine.
import { afterAll, expect, test } from "bun:test";
import { type HubEvent, onEmit } from "./events.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { ignoreNotice, listNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { approvalRoute, sender, webAnswer } from "./approval-wire.ts";
import { addDraft, newId } from "../features/reply-drafts/lib/store.ts";

const CONV = "mail:aw-test";
const draft = (body: string) => {
	const id = newId();
	addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `aw-${id.toLowerCase()}`, to: "friend@example.com", body, status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", text: "안녕" } as never });
	return id;
};
const refs = [draft("첫째 답"), draft("둘째 답"), draft("셋째 답"), draft("넷째 답")];
const card = (ref: string) => `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: `${ref} 답`, ref, question: "이대로 보낼까요?" })}`;
const openCards = () => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === CONV);
const outs: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && e.target === CONV && outs.push(e)));
// The next card the queue posts here, awaited with a deadline.
const nextCard = (ref: string) =>
	new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`card ${ref} never came`)), 5000);
		onEmit(e => {
			if (e.kind === "out" && e.target === CONV && String(e.text).includes(`(${ref})`)) {
				clearTimeout(timer);
				resolve(performance.now());
			}
		});
	});
const route = (method: string, path: string, body?: unknown, delivered: string[] = []) =>
	approvalRoute(new Request(`http://local${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://local${path}`), {
		login: "owner@example.com",
		triageMin: 3,
		deliver: async (_to, text) => void delivered.push(text),
	});

test("보내기 shows the next card at once with no model turn; the send runs in the background and a failure is one note on the card", async () => {
	for (const r of refs) await out(CONV, card(r));
	expect(openCards().map((n: any) => n.decision.draft.ref)).toEqual([refs[0]]);
	const bot: string[] = [];
	const next = nextCard(refs[1]!);
	const t0 = performance.now();
	const r = await webAnswer(openCards()[0].id, { n: 1 }, "owner@example.com", async a => void bot.push(a.text));
	expect(r.status).toBe(200);
	const ms = (await next) - t0;
	console.log(`next card after 보내기: ${ms.toFixed(1)} ms`);
	expect(ms).toBeLessThan(1000);
	expect(bot).toEqual([]);
	await sender.idle();
	const first = listNotices(500).items.find((n: any) => n.decision?.draft?.ref === refs[0]) as any;
	expect(first.decision.send.state).toBe("failed");
	console.log(`send result: ${first.decision.send.text}`);
	// The CLI's own approval check saw the pick: the refusal is the sender's, not "아직 보내도 된다는 답을 받지 못했어요".
	expect(first.decision.send.text).not.toContain("답을 받지 못했어요");
	expect(outs.filter(e => String(e.text).startsWith("[fail]") && String(e.text).includes(refs[0]!))).toHaveLength(1);
});

test("the batch answer: picked cards go (sends by the gateway, 고치기 to the bot in one message), the skipped one shows next", async () => {
	const list = (await (await route("GET", "/api/approvals"))!.json()) as any;
	const group = list.groups.find((g: any) => g.cards.some((c: any) => c.to === CONV));
	expect(group.cards.filter((c: any) => c.to === CONV).map((c: any) => [c.ref, !!c.notice, c.sendable])).toEqual([
		[refs[1], true, true],
		[refs[2], false, true],
		[refs[3], false, true],
	]);
	const delivered: string[] = [];
	const next = nextCard(refs[3]!);
	const t0 = performance.now();
	const res = await route("POST", "/api/approvals", { items: [{ ref: refs[1], to: CONV, n: 1 }, { ref: refs[2], to: CONV, n: 2, note: "더 짧게" }] }, delivered);
	const answeredMs = performance.now() - t0;
	expect(await res!.json()).toEqual({ ok: true, sending: 1, toBot: 1 });
	const nextMs = (await next) - t0;
	console.log(`batch answer returned: ${answeredMs.toFixed(1)} ms, next card: ${nextMs.toFixed(1)} ms`);
	expect(answeredMs).toBeLessThan(1000);
	expect(delivered).toHaveLength(1);
	expect(delivered[0]).toContain(`(${refs[2]}): 2) 고치기 - 더 짧게`);
	expect(openCards().map((n: any) => n.decision.draft.ref)).toEqual([refs[3]]);
	await sender.idle();
	expect(sender.results(CONV).find(r => r.ref === refs[1])?.state).toBe("failed");
});

afterAll(() => {
	for (const n of openCards()) ignoreNotice(n.id);
	expect(openCards()).toEqual([]);
});
