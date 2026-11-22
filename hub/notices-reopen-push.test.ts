import { expect, test } from "bun:test";
import { realClearTimeout, realSetTimeout } from "./runtime/test-clock.ts";
import { onEmit } from "./events.ts";
import { ATTACH_REFUSED, draftApprovalBlock } from "./draft-approval.ts";
import { answerDecision, listNotices, markDraftSend, onDecision, reopenNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { decisionPush } from "./push.ts";

const convOf = (ref: string) => `mail:reopen-push-${ref}`;
const cardOf = (ref: string) => {
	const n = listNotices(500).items.find(i => i.decision?.to === convOf(ref) && i.decision.draft?.ref === ref);
	if (!n?.decision) throw new Error(`no card of ${ref}`);
	return { id: n.id, decision: n.decision };
};
const cardText = (ref: string) => `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: `${ref} 답`, ref, question: "이 답장 보낼까요?" })}`;

const pushed: { id: string; ref: string; tag: string | undefined }[] = [];
onDecision(n => void pushed.push({ id: n.id, ref: n.decision?.draft?.ref ?? "", tag: decisionPush(n).tag }));
const pushesOf = (ref: string) => pushed.filter(p => p.ref === ref).length;

const seen = new Set<string>();
const waiting = new Map<string, () => void>();
onEmit(e => {
	if (e.kind !== "out" || !String(e.target).startsWith("mail:reopen-push-")) return;
	for (const [ref, done] of waiting) if (String(e.text).includes(`(${ref})`)) (seen.add(ref), waiting.delete(ref), done());
});
const shown = (ref: string) => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (seen.has(ref)) return Promise.resolve();
	const timer = realSetTimeout(() => reject(new Error(`card ${ref} never came`)), 5000);
	waiting.set(ref, () => (realClearTimeout(timer), resolve()));
	return promise;
};
const post = async (ref: string) => {
	const posted = shown(ref);
	await out(convOf(ref), cardText(ref));
	await posted;
};
const approve = (ref: string) => answerDecision(cardOf(ref).id, { n: 1 }, async () => {});
const REFUSED = `${ATTACH_REFUSED} 본문에 문서 파일을 보낸다고 썼지만 첨부파일이 없어요`;

test("a card reopened by a refused attachment pushes once more, and the same refusal again does not push a second time", async () => {
	await post("rp-attach");
	expect(pushesOf("rp-attach")).toBe(1);

	await approve("rp-attach");
	markDraftSend(convOf("rp-attach"), "rp-attach", "failed", REFUSED);
	expect(cardOf("rp-attach").decision.state).toBe("open");
	expect(pushesOf("rp-attach")).toBe(2);
	expect(pushed.filter(p => p.ref === "rp-attach").every(p => p.tag === `decision:${cardOf("rp-attach").id}`)).toBe(true);

	await approve("rp-attach");
	markDraftSend(convOf("rp-attach"), "rp-attach", "failed", REFUSED);
	expect(cardOf("rp-attach").decision.state).toBe("open");
	expect(pushesOf("rp-attach")).toBe(2);
});

test("a card taken back pushes once per reopen, and a different reason pushes again", async () => {
	await post("rp-back");
	await approve("rp-back");
	markDraftSend(convOf("rp-back"), "rp-back", "back", "보내기를 취소했어요. 보내려면 다시 보내기를 눌러 주세요");
	expect(pushesOf("rp-back")).toBe(2);

	await approve("rp-back");
	markDraftSend(convOf("rp-back"), "rp-back", "back", "보내기를 취소했어요. 보내려면 다시 보내기를 눌러 주세요");
	expect(pushesOf("rp-back")).toBe(2);

	await approve("rp-back");
	markDraftSend(convOf("rp-back"), "rp-back", "back", "게이트웨이가 다시 시작돼서 보내지 않았어요. 보내려면 다시 보내기를 눌러 주세요");
	expect(pushesOf("rp-back")).toBe(3);
});

test("a card that is still open when its send is reported pushes nothing", async () => {
	await post("rp-open");
	markDraftSend(convOf("rp-open"), "rp-open", "back", "보내기를 취소했어요. 보내려면 다시 보내기를 눌러 주세요");
	expect(pushesOf("rp-open")).toBe(1);
});

test("a failure that keeps the card answered does not reopen it or push", async () => {
	await post("rp-plain");
	await approve("rp-plain");
	markDraftSend(convOf("rp-plain"), "rp-plain", "failed", "zele: thread changed");
	expect(cardOf("rp-plain").decision.state).toBe("answered");
	expect(pushesOf("rp-plain")).toBe(1);
});

test("the owner's own reopen of an answered card does not push", async () => {
	await post("rp-owner");
	await approve("rp-owner");
	reopenNotices([cardOf("rp-owner").id]);
	expect(cardOf("rp-owner").decision.state).toBe("open");
	expect(pushesOf("rp-owner")).toBe(1);
});
