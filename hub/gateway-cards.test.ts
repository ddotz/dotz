import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDecisions, replyChoiceBlock } from "./choices.ts";
import { cfg, paths } from "./config.ts";
import { emit } from "./events.ts";
import { allNotices, resetNoticesForTest } from "./notices.ts";
import { runKey } from "./notices-schedule.ts";
import { ownerText } from "./owner-text.ts";
import { proposeRecipe, recipeBlock } from "./recipes.ts";
import { sendRepeatAlerts } from "./reflect.ts";
import { scheduleRan } from "./schedule-fire.ts";
import { addSchedule, removeSchedule, runNow } from "./schedule.ts";
import { RECONNECT_ACTION, watchChoice, watchIssueText, watchSubject } from "./watch-ask.ts";
import { clockKo } from "./watchtext.ts";

const DAY = 24 * 3600_000;
const NOW = Date.now();
type Card = { title: string; evidence: string[]; results: string[] };

const cardOf = (text: string): Card => {
	const blocks = parseDecisions(text).blocks;
	expect(blocks).toHaveLength(1);
	const b = blocks[0]!;
	return { title: b.title, evidence: b.evidence ?? [], results: b.options.map(o => o.desc) };
};

function expectSaysWhatEachAnswerDoes(card: Card): void {
	for (const r of card.results) expect(r.trim()).not.toBe("");
	expect(new Set(card.results).size).toBe(card.results.length);
}

function expectGatewayCard(card: Card, subject: string): void {
	expect(card.title.startsWith(`${subject} · `)).toBe(true);
	expect([...card.title].length).toBeLessThanOrEqual(40);
	expect(card.evidence.length).toBeGreaterThan(0);
	expectSaysWhatEachAnswerDoes(card);
}
const saved = cfg.identity;
beforeAll(() => void (cfg.identity = { ...saved, name: saved?.name ?? "sample-1", language: "ko" }));
afterAll(() => void (cfg.identity = saved));

afterEach(() => {
	for (const p of [paths.lanes, paths.recipeChoices, paths.corrections, paths.repeatAlerts]) rmSync(p, { recursive: true, force: true });
	resetNoticesForTest();
});

test("a monitor's card names the monitor, shows the failure count and since when, and says what each answer does and how a stop is undone", () => {
	const since = NOW - 5 * 3600_000;
	for (const login of [false, true]) {
		const card = cardOf(watchChoice("가격 확인", "failed 7 times in a row (exit 1)", login, { fails: 7, failSince: since }));
		expectGatewayCard(card, "가격 확인");
		expect(card.evidence).toContain("7번 연속 실패했어요");
		expect(card.evidence.some(l => l.endsWith("부터 실패하고 있어요"))).toBe(true);
		expect(card.results.at(-1)).toContain("다시 켜 달라고 하면");
		expect(watchSubject(card.title)).toBe("가격 확인");
	}
});

test("a monitor with a long label gets a title within 40 characters cut at a word, and the whole label as its first line", () => {
	const label = "아주 긴 이름을 가진 사내 그룹웨어 결재 대기 문서 확인";
	const card = cardOf(watchChoice(label, "failed 2 times in a row (exit 1)", true, { fails: 2 }));
	const subject = watchSubject(card.title)!;
	expectGatewayCard(card, subject);
	expect(subject.endsWith("…")).toBe(true);
	expect(label.startsWith(`${subject.slice(0, -1)} `)).toBe(true);
	expect(card.evidence[0]).toBe(`모니터링: ${label}`);
});

test("every line of a monitor's card is true for its case: a stopped monitor is not said to keep running, a skipped slot says which slot", () => {
	const at = NOW - 3600_000;
	for (const reason of ["stopped after 9 failures in a row over a day; it runs again once the owner approves (dotz_watch approve x) or the watch is added again", "stopped after a fetch failure; it runs again once the owner approves (dotz_watch approve x) or the watch is added again"]) {
		const card = cardOf(watchChoice("가격 확인", reason, false, { fails: 9, failSince: at }));
		expectGatewayCard(card, "가격 확인");
		expect(card.results.join(" ")).not.toContain("그대로 돌아요");
	}
	expect(cardOf(watchChoice("가격 확인", "failed 3 times in a row (exit 1)", false, { fails: 3, failSince: at })).results[0]).toContain("모니터링은 그대로 돌아요");
	const skipped = cardOf(watchChoice("정시 릴리스", "failed 1 times in a row (exit 3)", false, { fails: 1, failSince: at }));
	expectGatewayCard(skipped, "정시 릴리스");
	expect(skipped.evidence.some(l => l.includes("실패하고 있어요"))).toBe(false);
	expect(skipped.evidence).toEqual([`${clockKo(new Date(at).toISOString())} 릴리스 시간대를 건너뛰었어요`]);
});

test("a yes/no card derives its result lines only when they read true: an open, a nested or a negated question gets the plain lines", () => {
	const results = (q: string) => cardOf(ownerText(`**결정: ${q}**`)).results;
	const plain = ["물은 대로 하라고 답해요.", "하지 말라고 답해요."];
	for (const q of ["확인 안 할까요?", "몇 시에 할까요?", "왜 이렇게 할까요?", "얼마나 할까요?", "어떤 걸로 할까요?", "지금 업데이트해야 할까요?", "A안으로 할까요 B안으로 할까요?"]) expect(results(q)).toEqual(plain);
	expect(results("다음 주에 할까요?")).toEqual(["다음 주에 해요.", "다음 주에 하지 않아요."]);
	expect(results("배포 · 이대로 머지할까요?")).toEqual(["이대로 머지해요.", "이대로 머지하지 않아요."]);
	expect(results("삭제할까요?")).toEqual(["삭제해요.", "삭제하지 않아요."]);
	expect(results("새 안을 제안할까요?")).toEqual(["새 안을 제안해요.", "새 안을 제안하지 않아요."]);
});

test("a lost-login card keeps its 다시 연결 action, and a card stored with a title of the old code is still that monitor's card", () => {
	const old = "가격 확인: 로그인이 풀렸어요. 다시 연결할까요, 이 모니터링을 멈출까요?";
	expect(watchSubject(old)).toBe("가격 확인");
	expect(watchSubject("다시 연결할까요, 가격 확인 모니터링을 멈출까요?")).toBe("가격 확인");
	const w = { name: "price-check", session: { url: "https://shop.example.test" }, state: { fails: 2, kind: "login" } };
	for (const text of [watchIssueText(w as Parameters<typeof watchIssueText>[0], "가격 확인", "failed 2 times in a row (exit 1)", undefined, "DOTZ_FAIL login"), `[가격 확인] 로그인이 풀렸어요\n결정: ${old}\n**1) 다시 연결**\n지금 다시 로그인해서 확인해요.\n**2) 원인 확인**\n출력을 봐요.`]) {
		resetNoticesForTest();
		emit("outbox", { ts: new Date(NOW).toISOString(), kind: "out", source: "gateway", target: "alert", nk: "alert", text });
		const [card, ...rest] = allNotices().filter(n => n.kind === "decision");
		expect(rest).toHaveLength(0);
		expect(watchSubject(card!.title)).toBe("가격 확인");
		expect(card!.decision!.options.find(o => o.label === "다시 연결")?.action).toBe(RECONNECT_ACTION);
	}
});

test("three skipped release slots told about one monitor leave one open card that counts them", () => {
	for (const h of [0, 6, 12]) emit("outbox", { ts: new Date(NOW - (12 - h) * 3600_000).toISOString(), kind: "out", source: "gateway", target: "alert", nk: "alert", text: watchIssueText({ name: "release-slot", state: { fails: 1 } }, "정시 릴리스", "failed 1 times in a row (exit 3)", undefined, "") });
	const cards = allNotices().filter(n => n.kind === "decision");
	expect(cards).toHaveLength(1);
	expect(cards[0]!.decision).toMatchObject({ state: "open", asked: { n: 3 } });
});

test("a repeated correction's card names its topic, shows the count and one example, and says what each answer does", async () => {
	const ts = [3, 2, 1].map(d => new Date(NOW - d * DAY).toISOString());
	writeFileSync(paths.corrections, `${ts.map((t, i) => JSON.stringify({ ts: t, topic: "ui", conv: "web", text: `여백이 이상함 ${i}`, attachments: [], previous: "" })).join("\n")}\n`);
	const posted: string[] = [];
	await sendRepeatAlerts(async text => void posted.push(text), NOW);
	expect(posted).toHaveLength(1);
	const card = cardOf(posted[0]!);
	expectGatewayCard(card, "화면·디자인");
	expect(card.evidence).toContain("7일간 3건");
	expect(card.evidence).toContain("예: 여백이 이상함 2");
});

test("a recipe's card names the recipe, says when it is used, and says how a saved one is removed", () => {
	for (const [name, title] of [["report-a", "주간 매출 보고서 작성"], ["report-b", "주간 매출 보고서 정리"]]) {
		mkdirSync(join(paths.lanes, name!), { recursive: true });
		writeFileSync(join(paths.lanes, name!, "lane.json"), JSON.stringify({ name, title, status: "exited", endedAt: new Date(NOW - DAY).toISOString(), claim: { state: "verified" } }));
	}
	const id = /recipes\.ts propose (\S+)/.exec(recipeBlock(NOW))![1]!;
	const card = cardOf(proposeRecipe(id, { slug: "weekly-report", name: "주간 보고서", when: "주간 보고서를 달라고 할 때", body: "1. 시트를 읽어요\n2. 틀을 채워요" }, NOW));
	expectGatewayCard(card, "주간 보고서");
	expect(card.evidence).toContain("쓸 때: 주간 보고서를 달라고 할 때");
	expect(card.results[0]).toContain("그 폴더를 지우면");
});

test("a yes/no card a model wrote says what yes and no each do, in the question's words when it asks to do one thing", () => {
	const derived = cardOf(ownerText("확인했어요.\n**결정: sample-2 배포 · 지금 진행할까요?**"));
	expect(derived.title).toBe("sample-2 배포 · 지금 진행할까요?");
	expect(derived.results).toEqual(["지금 진행해요.", "지금 진행하지 않아요."]);
	for (const q of ["sample-2 배포 · 어떻게 할까요?", "sample-2 배포 · 괜찮을까요?"]) expectSaysWhatEachAnswerDoes(cardOf(ownerText(`**결정: ${q}**`)));
});

test("a reply question names whose reply it is and says what each choice sends", () => {
	const card = cardOf(replyChoiceBlock("몇 시에 만날까요?", ["3시에 만나요", "5시에 만나요"], "민수 답장"));
	expect(card.title).toBe("민수 답장 · 몇 시에 만날까요?");
	expect(card.results).toHaveLength(3);
	expect(card.results[0]).toContain("3시에 만나요");
	expectSaysWhatEachAnswerDoes(card);
});

test("a failed schedule run's card is correct Korean for any name and says what 다시 실행 and 그만두기 do", () => {
	for (const name of ["sample-4 매일 점검", "피드백 보고서", "Big Bath 점검 시간이에요"]) {
		const s = addSchedule({ name, kind: "task", text: "상태 보고해", in_minutes: 600, every_minutes: 1440 });
		const run = runNow(s.id);
		scheduleRan({ ids: [run], sk: "task" }, "failed");
		const card = allNotices().find(n => n.key === runKey(run))!;
		removeSchedule(s.id);
		expect(card.title).toBe(`${name} · 다시 실행할까요?`);
		expect(card.title).not.toContain("(를)");
		expect(card.decision!.evidence!.length).toBeGreaterThan(0);
		expectSaysWhatEachAnswerDoes({ title: card.title, evidence: card.decision!.evidence!, results: card.decision!.options.map(o => o.desc) });
	}
});
