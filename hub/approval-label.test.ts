// A stale option number must not run another action: the page sends the label it showed, and the gateway refuses a mismatch (409, nothing recorded,
// the card stays open). A pick without a label (an older peer, Discord) acts as before. Same real modules as hub/approval-wire-out.test.ts.
import { expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { listNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { approvalRoute, webAnswer } from "./approval-wire.ts";
import { addDraft, newId } from "../features/reply-drafts/lib/store.ts";

const CONV = "mail:aw-label";
const STALE = "카드 선택지가 바뀌었어요. 다시 확인하고 골라 주세요";
const id = newId();
addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `awl-${id.toLowerCase()}`, to: "friend@example.com", body: "첫째 답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], item: { id: `m-${id}`, from: "friend@example.com", subject: "s", text: "t" }, questions: [] } as never);
const openCard = () => listNotices(500).items.find((n: any) => n.decision?.state === "open" && n.decision.to === CONV) as any;

test("a pick whose label is not the option's label is refused with 409 and records nothing; the card stays open", async () => {
	await out(CONV, `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: "첫째 답", ref: id, question: "이대로 보낼까요?" })}`);
	const card = openCard();
	const bot: string[] = [];
	const deliver = async (a: { text: string }) => void bot.push(a.text);
	const stale = await webAnswer(card.id, { n: 1, label: "답글만 보내기" }, "owner@example.com", deliver);
	expect(stale).toEqual({ status: 409, body: { error: STALE } });
	const gone = await webAnswer(card.id, { n: 9, label: "보내기" }, "owner@example.com", deliver);
	expect(gone.status).toBe(409);
	expect(bot).toEqual([]);
	expect(openCard()?.id).toBe(card.id);

	// the batch path checks each item's label the same way
	const delivered: string[] = [];
	const res = await approvalRoute(new Request("http://local/api/approvals", { method: "POST", body: JSON.stringify({ items: [{ ref: id, to: CONV, n: 1, label: "답글만 보내기" }] }) }), new URL("http://local/api/approvals"), { login: "owner@example.com", triageMin: 3, deliver: async (_to, text) => void delivered.push(text) });
	expect(res!.status).toBe(409);
	expect(((await res!.json()) as { error: string }).error).toBe(STALE);
	expect(delivered).toEqual([]);
	expect(openCard()?.id).toBe(card.id);
});
