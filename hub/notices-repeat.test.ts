import { beforeEach, expect, test } from "bun:test";
import { TZ } from "./config.ts";
import { emit } from "./events.ts";
import { allNotices, ignoreNotice, listNotices, resetNoticesForTest, sweepQuestions } from "./notices.ts";
import { settleDecision } from "./notices-store.ts";
import { watchIssueText } from "./watch-ask.ts";

const HOUR = 3600_000;
const START = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
const at = (hours: number): string => new Date(START + hours * HOUR).toISOString();
const firstDay = new Date(START).toLocaleDateString("en-CA", { timeZone: TZ, month: "2-digit", day: "2-digit" });
const cards = () => listNotices(300).items.filter(n => n.kind === "decision");
const down = { name: "price-check", state: { fails: 3 } };
const watchIssue = (fails: number, ts: string) =>
	emit("outbox", { ts, kind: "out", source: "gateway", target: "alert", nk: "alert", text: watchIssueText(down, "가격 확인", `failed ${fails} times in a row (exit 1)`, undefined, "DOTZ_FAIL fetch") });
const releaseAsk = (ts: string) =>
	emit("outbox", { ts, kind: "out", source: "orchestrator", target: "main", text: "[ask]\n결정: 어떻게 할까요?\n**1) 릴리스 진행**\n지금 올려요\n**2) 미루기**\n다음 주에 해요" });

beforeEach(resetNoticesForTest);

test("a watch failure told again is the same card, saying how many times and the day of the first", () => {
	watchIssue(2, at(0));
	watchIssue(30, at(13));
	watchIssue(80, at(38));
	const [card, ...rest] = cards();
	expect(rest).toHaveLength(0);
	expect(card!.decision).toMatchObject({ state: "open", asked: { n: 3 } });
	expect(card!.text.endsWith(`3번째 알려요 · 처음 알린 날 ${firstDay}`)).toBe(true);
	expect(card!.title).toBe("가격 확인 · 원인을 확인할까요?");
	expect(card!.decision!.evidence).toContain("80번 연속 실패했어요");
});

test("the same question with the same choices asked again after hours is one card counted up; a second delivery of one ask is not a repeat", () => {
	releaseAsk(at(0));
	releaseAsk(at(0.1));
	expect(cards().map(c => c.decision!.asked)).toEqual([undefined]);
	releaseAsk(at(3));
	releaseAsk(at(30));
	const [card, ...rest] = cards();
	expect(rest).toHaveLength(0);
	expect(card!.decision!.asked).toEqual({ n: 3, first: at(0) });
	expect(card!.text).toContain(`3번째 알려요 · 처음 알린 날 ${firstDay}`);
});

test("a question answered and asked again later reopens the same card with its count", () => {
	releaseAsk(at(0));
	settleDecision(cards()[0]!, "2) 미루기", at(1));
	expect(cards()[0]!.decision!.state).toBe("answered");
	releaseAsk(at(5));
	const [card, ...rest] = cards();
	expect(rest).toHaveLength(0);
	expect(card!.decision).toMatchObject({ state: "open", asked: { n: 2 } });
	expect(card!.text.endsWith(`2번째 알려요 · 처음 알린 날 ${firstDay}`)).toBe(true);
});

test("the same question put again a minute later with other choices is the ask reworded, not a second time", () => {
	const ask = (ts: string, b: string) => emit("outbox", { ts, kind: "out", source: "orchestrator", target: "main", text: `[ask]\n결정: sample-2 릴리스를 언제 올릴까요?\n**1) 지금**\n바로 올려요\n**2) ${b}**\n그때 올려요` });
	ask(at(0), "내일");
	ask(at(0.02), "다음 주");
	expect(cards().map(c => c.decision!.asked)).toEqual([undefined]);
	expect(cards()[0]!.text).not.toContain("번째 알려요");
});

const idIssue = (ts: string) =>
	emit("outbox", { ts, kind: "out", source: "gateway", target: "alert", nk: "alert", text: watchIssueText(down, "가격 확인", "failed 3 times in a row (exit 1)", undefined, "DOTZ_FAIL fetch"), card_ids: ["watches:price-check"] });
const SECONDS = 1000;
const later = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

test("a card that expired unanswered is asked again at once by the same ask seconds later: reopened and counted, with or without an id", () => {
	idIssue(at(0));
	sweepQuestions(at(24));
	expect(cards()[0]!.decision).toMatchObject({ state: "answered", expired: true });
	idIssue(later(at(24), 5 * SECONDS));
	const [card, ...rest] = cards();
	expect(rest).toHaveLength(0);
	expect(card!.key).toBe("dec:alert:id:watches:price-check");
	expect(card!.decision).toMatchObject({ state: "open", asked: { n: 2, first: at(0) } });
	expect(card!.decision!.expired).toBeUndefined();
	expect(card!.text.endsWith(`2번째 알려요 · 처음 알린 날 ${firstDay}`)).toBe(true);
	resetNoticesForTest();
	releaseAsk(at(0));
	sweepQuestions(at(72));
	expect(cards()[0]!.decision).toMatchObject({ state: "answered", expired: true });
	releaseAsk(later(at(72), 5 * SECONDS));
	const [plain, ...others] = cards();
	expect(others).toHaveLength(0);
	expect(plain!.decision!.card_id).toBeUndefined();
	expect(plain!.decision).toMatchObject({ state: "open", asked: { n: 2, first: at(0) } });
	expect(plain!.text.endsWith(`2번째 알려요 · 처음 알린 날 ${firstDay}`)).toBe(true);
});

test("the same ask within 30 minutes of the owner's answer or his x is still one delivery: the card stays answered or ignored and is not counted", () => {
	idIssue(at(0));
	settleDecision(cards()[0]!, "1) 원인 확인", at(1));
	idIssue(later(at(1), 10 * 60 * SECONDS));
	expect(cards()[0]!.decision).toMatchObject({ state: "answered", answer: "1) 원인 확인" });
	expect(cards()[0]!.decision!.asked).toBeUndefined();
	expect(cards()[0]!.text).not.toContain("번째 알려요");
	resetNoticesForTest();
	idIssue(at(0));
	expect(ignoreNotice(cards()[0]!.id).status).toBe(200);
	const ignored = allNotices().find(n => n.kind === "decision")!;
	idIssue(later(ignored.ignored!, 10 * 60 * SECONDS));
	const after = allNotices().find(n => n.kind === "decision")!;
	expect(after.decision).toMatchObject({ state: "ignored" });
	expect(after.decision!.asked).toBeUndefined();
	expect(after.text).not.toContain("번째 알려요");
});

test("a card the gateway closed itself (its matter done) swallows the same ask within 30 minutes, as before; after that it reopens", () => {
	idIssue(at(0));
	settleDecision(cards()[0]!, "", at(1), true);
	expect(cards()[0]!.decision).toMatchObject({ state: "answered", resolved: true, closed_how: "done" });
	idIssue(later(at(1), 10 * 60 * SECONDS));
	expect(cards()[0]!.decision!.state).toBe("answered");
	idIssue(at(2));
	expect(cards()[0]!.decision).toMatchObject({ state: "open", asked: { n: 2 } });
});
