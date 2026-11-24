import { afterAll, beforeEach, expect, test } from "bun:test";
import fc from "fast-check";
import { cardBlock } from "./choices.ts";
import { now } from "./config.ts";
import { DOCTOR_LOOK_EN, DOCTOR_LOOK_KO, doctorEn, doctorKo as t, doctorLookAsk, isDoctorLook } from "./doctor-text.ts";
import { emit } from "./events.ts";
import { flush, sendWeb } from "./intake.ts";
import { allNotices, resetNoticesForTest, type Notice } from "./notices.ts";
import { convs } from "./convsessions.ts";
import { msg } from "./i18n.ts";

process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => {
	delete process.env.DOTZ_NO_ORCHESTRATOR;
	resetNoticesForTest();
});

const DAY = "11월 24일";
const WATCH = t.watchFailing("Sample-2", 2, "11월 23일 21:00");
const CARD = cardBlock({ subject: t.diskSubject, question: t.diskQuestion, evidence: ["남은 공간 9GB (4%)"], options: [{ name: t.diskCleanName, result: t.diskCleanResult }, { name: t.diskKeepName, result: t.diskKeepResult }] });
const MESSAGE = `${[`${t.head(DAY)} · ${t.told(1)} · ${t.decide(1)}`, t.toldPart, `- ${WATCH}${DOCTOR_LOOK_KO}`, t.lookHint].join("\n")}\n\n${t.decidePart}\n\n${CARD}`;
const card = (): Notice => allNotices().find(n => n.kind === "decision" && n.decision?.to === "alert")!;
const alertQueue = () => convs.forTarget("web:alert")!.queue;
const turns = () => (convs.forTarget("web:alert")?.queue.queued() ?? []).filter(p => p.text.includes("web:alert"));
const followUps = () => (convs.forTarget("web:alert")?.queue.queued() ?? []).filter(p => p.text.startsWith("[dotz gateway]"));
const openLine = () => msg().openQuestions([card().title]);

async function ownerSays(text: string): Promise<string> {
	const before = turns().length;
	await sendWeb({ channel: "web", conv: "alert", text, mode: "default", login: "local" });
	flush("web:alert");
	expect(turns()).toHaveLength(before + 1);
	return turns().at(-1)!.text;
}

beforeEach(() => {
	resetNoticesForTest();
	emit("outbox", { ts: new Date(Date.parse(now()) - 10 * 60_000).toISOString(), kind: "out", source: "gateway", target: "alert", wk: "doctor", text: MESSAGE });
	expect(card().decision).toMatchObject({ state: "open" });
});

test("the look-up reply the button sends, while a doctor card is open, gets no open-questions line, marks no card judging and closes none", async () => {
	const prompt = await ownerSays(doctorLookAsk.ko(DAY, WATCH));
	expect(prompt).toContain(doctorLookAsk.ko(DAY, WATCH));
	expect(prompt).not.toContain(openLine());
	expect(card().decision!.judging).toBeUndefined();
	alertQueue().onPrompt(prompt);
	alertQueue().onAnswer("원인을 찾아볼게요.");
	alertQueue().settleTurn();
	expect(followUps()).toHaveLength(0);
	expect(card().decision).toMatchObject({ state: "open" });
	expect(card().decision!.answer).toBeUndefined();
	expect(card().decision!.kept_open).toBeUndefined();
});

test("the told line typed back with its mark, as the hint says, is a look-up too", async () => {
	const prompt = await ownerSays(`${WATCH}${DOCTOR_LOOK_KO}`);
	expect(prompt).not.toContain(openLine());
	expect(card().decision!.judging).toBeUndefined();
	expect(card().decision).toMatchObject({ state: "open" });
});

test("a told line copied with its sub-lines, as the owner copies it from Discord, is a look-up too: a number in a sub-line closes no card", async () => {
	const copied = [`- ${WATCH}${DOCTOR_LOOK_KO}`, "  - 마지막 이유: 2번 페이지를 열지 못했어요", `  - ${t.subMore(2)}`].join("\n");
	const prompt = await ownerSays(copied);
	expect(prompt).not.toContain(openLine());
	expect(card().decision!.judging).toBeUndefined();
	expect(card().decision).toMatchObject({ state: "open" });
	expect(isDoctorLook(copied.replace(/^- /, "").replace(/\n {2}- /g, "\n• "))).toBe(true);
	expect(isDoctorLook(`${copied}\n2번으로 해요`)).toBe(false);
});

const RESTARTED_KO = "하루 사이에 게이트웨이가 5번 다시 시작했고, 그중 1번은 이유를 몰라요.";
const RESTART_SUBS_KO = "\n11월 24일 03:10 · 누가 요청했는지 로그에 나와 있지 않아요\n11월 24일 05:40 · 누가 요청했는지 로그에 나와 있지 않아요";
const RESTARTED_EN = doctorEn.restarts({ all: 5, update: 2, owner: 1, orchestrator: 1, unexplained: 1 });
const WEB_COPIES: [string, string][] = [
	...["원인 찾기", "보내는 중", "보냈어요", "다시 보내기"].map((word): [string, string] => [`the web page's selection while its button reads ${word}`, `${RESTARTED_KO} ${word}${RESTART_SUBS_KO}`]),
	["the web page's selection with the hint line under it", `${RESTARTED_KO} 원인 찾기${RESTART_SUBS_KO}\n\n${t.lookHint}`],
	["a Chromium selection of a told line with its sub-line", "'price-check' 모니터링이 11월 23일 02:00 KST부터 3번 연속 실패했어요. 원인 찾기\n이유를 아는 것: 업데이트 설치 2번, 직접 하신 재시작 1번"],
	["a told line cut with … and copied from the web", `${"아주 긴 제목이 이어져요 ".repeat(4).trim()}… 원인 찾기\n마지막 이유: 2번 페이지를 열지 못했어요`],
	["the told line sent back with its mark, its sub-lines and the hint line", [`- ${WATCH}${DOCTOR_LOOK_KO}`, "  - 이유를 아는 것: 업데이트 설치 2번, 직접 하신 재시작 1번", t.lookHint].join("\n")],
	...["Find the cause", "Sending", "Sent", "Send again"].map((word): [string, string] => [`the English web page's selection while its button reads ${word}`, `${RESTARTED_EN} ${word}\nNov 24 03:10 · The log does not say who asked for it\nLast reason: page 2 did not open`]),
	["the English selection with the hint line under it", `${RESTARTED_EN} Find the cause\nLast reason: page 2 did not open\n${doctorEn.lookHint}`],
];
for (const [name, copied] of WEB_COPIES)
	test(`a told line copied from the web is a look-up that closes no card, whatever number it holds: ${name}`, async () => {
		expect(isDoctorLook(copied)).toBe(true);
		const prompt = await ownerSays(copied);
		expect(prompt).not.toContain(openLine());
		expect(card().decision!.judging).toBeUndefined();
		expect(card().decision).toMatchObject({ state: "open" });
	});

test("a plain typed number or number with words still answers the card, and owner words that end in a button's word are no look-up", async () => {
	for (const said of ["2", "2번으로 해"]) {
		resetNoticesForTest();
		emit("outbox", { ts: new Date(Date.parse(now()) - 5 * 60_000).toISOString(), kind: "out", source: "gateway", target: "alert", wk: "doctor", text: MESSAGE });
		await ownerSays(said);
		expect(card().decision).toMatchObject({ state: "answered", answer: said });
	}
	for (const said of ["메일 보냈어요", "2번 보냈어요", "1. 보냈어요", "2) 보냈어요", "원인 찾기", "Sent", "2) Sent"]) expect(isDoctorLook(said)).toBe(false);
});

test("a typed answer to the card in the same state still answers it, by its label or by its number alone", async () => {
	await ownerSays(`1) ${t.diskCleanName}`);
	expect(card().decision).toMatchObject({ state: "answered" });
	resetNoticesForTest();
	emit("outbox", { ts: new Date(Date.parse(now()) - 5 * 60_000).toISOString(), kind: "out", source: "gateway", target: "alert", wk: "doctor", text: MESSAGE });
	await ownerSays("2번");
	expect(card().decision).toMatchObject({ state: "answered", answer: "2번" });
});

test("a look-up text sent with the card's decision id is a button answer of that card, outside the look-up rule: it closes the card", async () => {
	await sendWeb({ channel: "web", conv: "alert", text: doctorLookAsk.ko(DAY, WATCH), mode: "default", login: "local", decision: card().id });
	flush("web:alert");
	expect(card().decision).toMatchObject({ state: "answered" });
});

test("another message in the same state is still judged against the open card", async () => {
	const prompt = await ownerSays("디스크는 내가 볼게");
	expect(prompt).toContain(openLine());
	expect(card().decision!.judging).toMatchObject({ text: "디스크는 내가 볼게" });
});

test("the recogniser knows the reply of both languages and the marked line, and nothing that only resembles them", () => {
	for (const [ask, day] of [[doctorLookAsk.ko, DAY], [doctorLookAsk.en, "November 24"]] as const) expect(isDoctorLook(ask(day, WATCH))).toBe(true);
	expect(isDoctorLook(`${doctorEn.restarts({ all: 5, update: 2, owner: 1, orchestrator: 1, unexplained: 1 })}${DOCTOR_LOOK_EN}`)).toBe(true);
	for (const other of ["", "1", `1) ${t.diskCleanName}`, `${WATCH}${DOCTOR_LOOK_KO} 그리고 디스크는 정리해`, `${doctorLookAsk.ko(DAY, WATCH)}\n그리고 1번으로 해`, doctorLookAsk.ko(DAY, ""), `${"아주 긴 앞말".repeat(5)}${doctorLookAsk.ko("", WATCH)}`]) expect(isDoctorLook(other)).toBe(false);
	fc.assert(fc.property(fc.string({ unit: fc.constantFrom("a", "1", " ", "·", "'", "가", "닥", "원", ":", ")", "%") }).filter(s => !!s.trim()), s => {
		expect(isDoctorLook(doctorLookAsk.ko(DAY, s))).toBe(true);
		expect(isDoctorLook(doctorLookAsk.en("November 24", s))).toBe(true);
		expect(isDoctorLook(`1) ${s}`)).toBe(false);
	}));
});

test("the owner's own sentence that ends in a word the web's button reads is no look-up: it answers the card it was written to", async () => {
	for (const said of ["네, 오늘 오전에 확인했어요. 보냈어요", "견적서 다시 정리했어요. 보냈어요", "초안 고쳤어요. 다시 보내기", "지금 정리했어요. 보내는 중", "2번으로 할게요. 보냈어요", "I checked the invoice. Sent", "Fixed the draft. Send again"]) expect([said, isDoctorLook(said)]).toEqual([said, false]);
	resetNoticesForTest();
	emit("outbox", { ts: new Date(Date.parse(now()) - 5 * 60_000).toISOString(), kind: "out", source: "orchestrator", target: "alert", text: "[ask] 거래처에 견적서를 보내셨나요? 보내셨으면 알려 주세요." });
	const said = "네, 오늘 오전에 확인했어요. 보냈어요";
	await ownerSays(said);
	expect(card().decision).toMatchObject({ state: "answered", answer: said });
});

test("a told line that has no sub-lines, copied alone from the web before its button was pressed, is still a look-up: its number closes no card", async () => {
	const copied = `${WATCH} 원인 찾기`;
	expect([isDoctorLook(copied), isDoctorLook(`${doctorEn.watchFailing("Sample-2", 2, "Nov 23 21:00")} Find the cause`)]).toEqual([true, true]);
	const prompt = await ownerSays(copied);
	expect(prompt).not.toContain(openLine());
	expect(card().decision).toMatchObject({ state: "open" });
});
