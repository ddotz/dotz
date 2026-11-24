import { beforeEach, expect, test } from "bun:test";
import { cardBlock } from "./choices.ts";
import { emit } from "./events.ts";
import { answerDecision, resetNoticesForTest } from "./notices.ts";
import { ANSWER_HOLD_MS, unholdDecision } from "./notices-answers.ts";
import { listNotices } from "./notices-bell.ts";
import { items, reconcileStored } from "./notices-store.ts";
import type { DecisionSend } from "./notices-answers.ts";
import { advance } from "./runtime/test-clock.ts";

const card = (subject: string) => cardBlock({ subject, question: "원인을 찾아볼까요?", options: [{ name: "찾아봐요", result: "원인부터 찾아봐요" }, { name: "이번엔 둬요", result: "그대로 둬요" }] });
const doctor = (subjects: string[]) => `닥터 점검: 정할 것이 ${subjects.length}가지 있어요.\n\n${subjects.map(card).join("\n\n")}`;
const post = (subjects: string[], ts = new Date(Date.now()).toISOString()) => {
	emit("outbox", { ts, kind: "out", source: "gateway", target: "alert", text: doctor(subjects) });
	return ts;
};
const placeOf = () => Object.fromEntries(items.filter(n => n.decision).map(n => [n.title.split(" · ")[0], n.decision!.place]));

beforeEach(resetNoticesForTest);

test("each card of a message stores its place in the order the message lists them, whatever order the list is read in", () => {
	post(["업데이트", "실패 작업", "토큰"]);
	expect(placeOf()).toEqual({ 업데이트: 0, "실패 작업": 1, 토큰: 2 });
	const listed = listNotices(300).items.filter(n => n.decision).map(n => n.title.split(" · ")[0]);
	expect(listed).not.toEqual(["업데이트", "실패 작업", "토큰"]);
});

test("a card asked again by a later message takes its place in that message", () => {
	post(["토큰", "디스크"], new Date(Date.now() - 60_000).toISOString());
	const at = post(["업데이트", "실패 작업", "토큰"]);
	const token = items.filter(n => n.decision && n.title.startsWith("토큰"));
	expect(token.map(n => [n.decision!.reply_to, n.decision!.place])).toEqual([[at, 2]]);
});

test("the redraw on start sets the place again, and a card stored before the field still lists", () => {
	post(["업데이트", "실패 작업"]);
	const [first, second] = items.filter(n => n.decision);
	delete first!.decision!.place;
	second!.decision!.place = 7;
	reconcileStored();
	expect(placeOf()).toEqual({ 업데이트: 0, "실패 작업": 1 });
	delete first!.decision!.place;
	expect(listNotices(300).items.filter(n => n.decision).map(n => n.id).sort()).toEqual([first!.id, second!.id].sort());
});

test("a held answer reaches the asking side once, after the window; 되돌리기 inside it sends nothing and the card waits as before", async () => {
	post(["업데이트", "실패 작업"]);
	const [a, b] = items.filter(n => n.decision);
	const sent: Parameters<DecisionSend>[0][] = [];
	const send: DecisionSend = async x => void sent.push(x);
	const held = await answerDecision(a!.id, { n: 1, hold: true }, send);
	expect(held.body.held).toMatchObject({ state: "held", left: ANSWER_HOLD_MS });
	expect(a!.decision!.state).toBe("open");
	expect(await answerDecision(a!.id, { n: 2, hold: true }, send)).toMatchObject({ status: 409, body: { code: "held" } });
	await advance(ANSWER_HOLD_MS - 1);
	expect(sent).toEqual([]);
	await advance(1);
	expect(sent.map(x => x.notice)).toEqual([a!.id]);
	expect(a!.decision!.state).toBe("answered");
	await advance(ANSWER_HOLD_MS * 2);
	expect(sent.length).toBe(1);
	expect(unholdDecision(a!.id).status).toBe(409);

	await answerDecision(b!.id, { n: 2, hold: true }, send);
	expect(unholdDecision(b!.id).status).toBe(200);
	await advance(ANSWER_HOLD_MS * 2);
	expect(sent.length).toBe(1);
	expect([b!.decision!.state, b!.decision!.answer]).toEqual(["open", undefined]);
});
