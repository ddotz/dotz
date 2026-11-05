// The gateway's send of a card whose files disagree with its words is refused by the CLI (sendDraft). The draft stays pending, and the card the owner
// answered opens again with the reason, so 이대로 보내기 can still be picked; any other failed send keeps the card answered, as before.
import { afterAll, expect, test } from "bun:test";
import { onEmit } from "./events.ts";
import { ATTACH_REFUSED, draftApprovalBlock } from "./draft-approval.ts";
import { answerDecision, ignoreNotice, listNotices, markDraftSend } from "./notices.ts";
import { out } from "./outbound.ts";
import { pickedSend } from "./reply-outcomes.ts";

const CONV = "mail:attach-refused-test";
const why = "본문에 악보·문서 파일을 보낸다고 썼지만 첨부파일이 없어요";
const REFS = ["att-refused-1", "att-failed-2"];
const card = (ref: string) => `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: `${ref} 악보 보내드립니다`, ref, question: "이 답장 보낼까요?", attachIssues: [why] })}`;
const all = () => listNotices(500).items as any[];
const cardOf = (ref: string) => all().find(n => n.decision?.to === CONV && n.decision.draft?.ref === ref);
const seen = new Set<string>();
const waiting = new Map<string, () => void>();
onEmit(e => {
	if (e.kind !== "out" || e.target !== CONV) return;
	for (const [ref, done] of waiting) if (String(e.text).includes(`(${ref})`)) (seen.add(ref), waiting.delete(ref), done());
});
const shown = (ref: string) =>
	new Promise<void>((resolve, reject) => {
		if (seen.has(ref)) return resolve();
		const timer = setTimeout(() => reject(new Error(`card ${ref} never came`)), 5000);
		waiting.set(ref, () => (clearTimeout(timer), resolve()));
	});

test("a send refused for its files opens the card again with the reason; 이대로 보내기 is then a pick the gateway sends", async () => {
	const posted = shown(REFS[0]!);
	await out(CONV, card(REFS[0]!));
	await posted;
	const n = cardOf(REFS[0]!);
	expect(n.decision.options.map((o: { label: string }) => o.label)).toEqual(["보내기", "고치기", "보내지 않기", "이대로 보내기"]);

	await answerDecision(n.id, { n: 1 }, async () => {});
	expect(cardOf(REFS[0]!).decision.state).toBe("answered");
	expect(pickedSend(cardOf(REFS[0]!).decision)).toBe("send");

	markDraftSend(CONV, REFS[0]!, "failed", `${ATTACH_REFUSED} ${why}. 그래도 보내려면 카드에서 '이대로 보내기'를 골라 주세요`);
	const again = cardOf(REFS[0]!);
	expect(again.decision.state).toBe("open");
	expect(again.decision.send).toMatchObject({ state: "failed", text: expect.stringContaining(why) });

	await answerDecision(again.id, { n: 4 }, async () => {});
	expect(pickedSend(cardOf(REFS[0]!).decision)).toBe("send-as-is");
});

test("a send that failed for another reason keeps the card answered", async () => {
	const posted = shown(REFS[1]!);
	await out(CONV, card(REFS[1]!));
	await posted;
	await answerDecision(cardOf(REFS[1]!).id, { n: 1 }, async () => {});
	markDraftSend(CONV, REFS[1]!, "failed", "zele: thread changed");
	expect(cardOf(REFS[1]!).decision.state).toBe("answered");
	expect(cardOf(REFS[1]!).decision.send).toMatchObject({ state: "failed", text: "zele: thread changed" });
});

afterAll(() => {
	for (const n of all().filter(i => i.decision?.to === CONV && i.decision.state === "open")) ignoreNotice(n.id);
});
