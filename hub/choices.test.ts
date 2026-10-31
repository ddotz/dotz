import { expect, test } from "bun:test";
import { hasDecisionHead, parseChoices, parseDecisions } from "./choices.ts";

test("parses the MODE choice block with a recommended option", () => {
	const text = "[ask] 게이트웨이 시작 설정\n\n결정: 시작 설정\n**1) 지금 고치기** ← 추천\n재부팅 뒤에도 켜져요\n**2) 그대로 두기**\n다음 재부팅까지는 괜찮아요";
	expect(parseChoices(text)).toEqual({
		question: "결정: 시작 설정",
		options: [
			{ n: 1, label: "지금 고치기", recommended: true },
			{ n: 2, label: "그대로 두기", recommended: false },
		],
	});
});

test("plain numbered lines, English marker, quote prefixes", () => {
	const r = parseChoices("> Which one?\n> **1) Fix it now** ← recommended\n> restarts\n> 2) Leave it\n> nothing");
	expect(r.question).toBe("Which one?");
	expect(r.options).toEqual([
		{ n: 1, label: "Fix it now", recommended: true },
		{ n: 2, label: "Leave it", recommended: false },
	]);
});

test("the marker may sit inside the bold", () => {
	expect(parseChoices("**1) A ← 추천**\n**2) B**").options[0]).toEqual({ n: 1, label: "A", recommended: true });
});

test("no options for prose, one option, fenced lines or a missing 1", () => {
	expect(parseChoices("그냥 말이에요").options).toEqual([]);
	expect(parseChoices("**1) only**").options).toEqual([]);
	expect(parseChoices("```\n1) a\n2) b\n```").options).toEqual([]);
	expect(parseChoices("2) a\n3) b").options).toEqual([]);
});

test("several decision blocks (numbers restart) give no single answer", () => {
	expect(parseChoices("**1) a**\n**2) b**\n둘째\n**1) c**\n**2) d**").options).toEqual([]);
});

test("question is absent when the options open the message; more than 25 options are refused", () => {
	expect(parseChoices("1) a\n2) b").question).toBeUndefined();
	const many = Array.from({ length: 26 }, (_, i) => `${i + 1}) o${i + 1}`).join("\n");
	expect(parseChoices(many).options).toEqual([]);
	expect(parseChoices(many.split("\n").slice(0, 25).join("\n")).options).toHaveLength(25);
});

test("numbered decision heads (결정 1: / 결정 2:) are decisions, each its own block", () => {
	const text = ["처음 한 번만 정할 게 있어요.", "결정 1: 기차는 어디서 끊으세요?", "1) KTX (코레일) ← 추천", "코레일 승차권 내역에서 가져와요", "2) SRT", "SRT 승차권 내역에서 가져와요", "3) 둘 다", "",
		"결정 2: 다 모은 증빙은 어디로 보낼까요?", "1) 회사 메일 나에게 보내기 ← 추천", "2) 맥북 땃쥐에게 넘기기", "3) 다운로드 폴더에만 저장", "", "번호로 답해 주세요."].join("\n");
	const r = parseDecisions(text);
	expect(r.blocks.map(b => [b.title, b.options.map(o => o.label), b.options.findIndex(o => o.rec)])).toEqual([
		["기차는 어디서 끊으세요?", ["KTX (코레일)", "SRT", "둘 다"], 0],
		["다 모은 증빙은 어디로 보낼까요?", ["회사 메일 나에게 보내기", "맥북 땃쥐에게 넘기기", "다운로드 폴더에만 저장"], 0],
	]);
	expect(hasDecisionHead(r.blocks)).toBe(true);
	expect(parseDecisions("결정 답: 기차 → 1) KTX\n1) a\n2) b").blocks.every(b => !b.headed)).toBe(true);
});
