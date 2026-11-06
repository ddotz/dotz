import { expect, test } from "bun:test";
import { clipKeepingAsk, normalizeAsk } from "./ask-normalize.ts";
import { ASK_A, ASK_B } from "./ask-normalize.fixture.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { decisionText, hasDecisionHead, parseChoices, parseDecisions, stripRecommendMark } from "./choices.ts";

test("an old message's recommendation mark does not survive parsing or display", () => {
	const old = "[ask] 배포\n결정: 시점\n**1) 지금** ← 추천\n바로 올려요\n2) 내일 (recommended)\n3) 모레 <- recommended";
	expect(parseDecisions(old).blocks[0]!.options.map(o => o.label)).toEqual(["지금", "내일", "모레"]);
	expect(parseChoices("**1) A ← 추천**\n**2) B**").options.map(o => o.label)).toEqual(["A", "B"]);
	expect(stripRecommendMark(old)).toBe("[ask] 배포\n결정: 시점\n**1) 지금**\n바로 올려요\n2) 내일\n3) 모레");
	expect(stripRecommendMark("추천 ← 추천 이유는 빨라서")).toBe("추천 ← 추천 이유는 빨라서");
});

test("parses the MODE choice block", () => {
	const text = "[ask] 게이트웨이 시작 설정\n\n결정: 시작 설정\n**1) 지금 고치기**\n재부팅 뒤에도 켜져요\n**2) 그대로 두기**\n다음 재부팅까지는 괜찮아요";
	expect(parseChoices(text)).toEqual({
		question: "결정: 시작 설정",
		options: [
			{ n: 1, label: "지금 고치기" },
			{ n: 2, label: "그대로 두기" },
		],
	});
});

test("plain numbered lines, English marker, quote prefixes", () => {
	const r = parseChoices("> Which one?\n> **1) Fix it now**\n> restarts\n> 2) Leave it\n> nothing");
	expect(r.question).toBe("Which one?");
	expect(r.options).toEqual([
		{ n: 1, label: "Fix it now" },
		{ n: 2, label: "Leave it" },
	]);
});

test("the marker may sit inside the bold", () => {
	expect(parseChoices("**1) A**\n**2) B**").options[0]).toEqual({ n: 1, label: "A" });
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
	const text = ["처음 한 번만 정할 게 있어요.", "결정 1: 기차는 어디서 끊으세요?", "1) KTX (코레일)", "코레일 승차권 내역에서 가져와요", "2) SRT", "SRT 승차권 내역에서 가져와요", "3) 둘 다", "",
		"결정 2: 다 모은 증빙은 어디로 보낼까요?", "1) 회사 메일 나에게 보내기", "2) 맥북 땃쥐에게 넘기기", "3) 다운로드 폴더에만 저장", "", "번호로 답해 주세요."].join("\n");
	const r = parseDecisions(text);
	expect(r.blocks.map(b => [b.title, b.options.map(o => o.label)])).toEqual([
		["기차는 어디서 끊으세요?", ["KTX (코레일)", "SRT", "둘 다"]],
		["다 모은 증빙은 어디로 보낼까요?", ["회사 메일 나에게 보내기", "맥북 땃쥐에게 넘기기", "다운로드 폴더에만 저장"]],
	]);
	expect(hasDecisionHead(r.blocks)).toBe(true);
	expect(parseDecisions("결정 답: 기차 → 1) KTX\n1) a\n2) b").blocks.every(b => !b.headed)).toBe(true);
});

test("one decision of several keeps the lead text and its own lines, never the other decisions or the option lines", () => {
	const body = "[ask] 세 가지예요\n결정: 가\n참고 한 줄\n**1) 하나**\n설명\n**2) 둘**\n설명\n\n결정: 나\n**1) 셋**\n설명\n**2) 넷**\n설명\n번호로 답해 주세요";
	expect(decisionText(body, 0)).toBe("세 가지예요\n\n참고 한 줄");
	expect(decisionText(body, 1)).toBe("세 가지예요");
});


test("a final answer's plain option list becomes the contract's block, keeping the report", () => {
	const got = normalizeAsk(ASK_A);
	expect(got.startsWith("[ask] 2부를 브랜치에서 끝냈어요.")).toBe(true);
	expect(got).toContain("저는 그대로 반영하는 걸 추천해요.\n\n결정: 어떻게 할까요?\n**1) 그대로 반영**\n**2) 알림 행만 조정하고 반영 …**\n어떻게 바꿀지 알려 주세요\n**3) 반영 보류**");
	const { blocks } = parseDecisions(got);
	expect(blocks).toHaveLength(1);
	expect(blocks[0]!.options.map(o => [o.label, !!o.detail])).toEqual([["그대로 반영", false], ["알림 행만 조정하고 반영", true], ["반영 보류", false]]);
	expect(parseChoices(got).options.map(o => o.label)).toEqual(["그대로 반영", "알림 행만 조정하고 반영", "반영 보류"]);
	expect(got.endsWith("**3) 반영 보류**\n\n[file] /tmp/spacing-rules/compare/notices-390-light.png\n[file] /tmp/spacing-rules/compare/mail-1280-light.png")).toBe(true);
	expect(normalizeAsk(got)).toBe(got);
});

test("a marked [ask] in the wrong format is rewritten and its 결정 필요 heading goes", () => {
	const got = normalizeAsk(ASK_B);
	expect(got).toBe("[ask] 2부 이전을 브랜치에서 끝냈어요.\n\n땅콩 몫: 형 답을 받아 전달해 주세요.\n\n결정: 2부를 main에 반영할까요? (브랜치 `lane/spacing-rules`, 커밋 79개)\n**1) 그대로 반영**\n값이 규칙에 맞게 통일됐고, 나빠진 곳은 못 찾았어요.\n**2) 알림 행만 조정 후 반영**\n행 높이를 이전과 같게 두는 대신 목록 행 규칙(8px)에서는 벗어나요.\n**3) 보류 …**\n대조표를 보고 고칠 곳을 알려 주세요.\n\n대조표: `/tmp/spacing-rules/README.md` (이미지는 `/tmp/spacing-rules/compare/`)");
});

test("two numbered questions under a heading are two blocks; a [fail] keeps its marker", () => {
	const got = normalizeAsk("**결정 필요**\n1. 2부를 반영할까요?\n   - 반영\n   - 보류\n2. 알림도 고칠까요?\n   - 고치기\n   - 두기");
	expect(parseDecisions(got).blocks.map(b => b.title)).toEqual(["2부를 반영할까요?", "알림도 고칠까요?"]);
	expect(normalizeAsk("[fail] 배포가 실패했어요.\n어떻게 할까요?\n1) 다시 시도\n2) 중단").startsWith("[fail] 배포가 실패했어요.\n\n결정: 어떻게 할까요?")).toBe(true);
});

test("the question of 2026-10-31 gets a card; a For line after the options stays below the block", () => {
	const got = normalizeAsk("암호가 필요해요.\n\n둘 중 어떻게 할까요?\n\n1) 지수에게 메뉴로 업데이트해 달라고 하기\n2) 지수 Mac 암호를 받아 제가 설치하기\n\nFor 도리: 답이 오면 이어 가요");
	expect(parseDecisions(got).blocks[0]!.options[1]).toMatchObject({ desc: "", n: 2 });
	expect(got.endsWith("\n\nFor 도리: 답이 오면 이어 가요")).toBe(true);
});

const PLAIN: [string, string][] = [
	["numbered report", "오늘 한 일이에요.\n\n1) 여백 값을 눈금에 맞췄어요\n2) 검사 기준 목록을 없앴어요\n3) 대조표를 만들었어요"],
	["steps after a how-to question", "어떻게 설치할까요?\n1. 터미널을 여세요\n2. bun install 을 실행하세요\n3. 다시 시작하세요"],
	["steps with noun lines", "어떻게 설치할까요?\n1. 터미널 열기\n2. 명령 입력"],
	["[done] report", "[done] 반영했어요. 다음엔 뭘로 할까요?\n1) 알림 행\n2) 입력창"],
	["[done] further down", "Ask: 정리 - wanted: 끝\n\n[done] 끝났어요. 어느 쪽을 볼까요?\n1) 알림 행\n2) 입력창"],
	["rhetorical question", "왜 이렇게 됐을까요?\n1) 토큰이 없었음\n2) 검사가 꺼져 있었음"],
	["past question", "어떤 방식으로 고쳤나요?\n- 토큰으로 바꿈\n- 검사를 켬"],
	["yes / no with a plan under it", "이대로 진행할까요?\n- hub 수정\n- web 수정"],
	["menu", "메뉴는 이래요:\n1) 김치찌개 9000원\n2) 된장찌개 9000원\n3) 제육볶음 10000원"],
	["question then a note before the list", "반영할까요?\n\n참고로 바뀐 곳이에요:\n1) 알림 행\n2) 입력창"],
	["list inside a code block", "어느 쪽으로 할까요?\n```\n1) a\n2) b\n```"],
	["목록 block", "어느 방을 볼까요?\n```목록\n1) 방 | 하나\n2) 방 | 둘\n```"],
	["quoted list", "이 답장 어느 쪽으로 할까요?\n> 1) 네\n> 2) 아니요"],
	["quoted draft asking to send", "[ask] 답장 초안이에요.\n> 받는이: a@example.test\n> 제목: 안녕\n>\n> 본문이에요\n\n어느 쪽으로 할까요?\n1) 보내기\n2) 보내지 않기"],
	["five options", "어느 쪽으로 할까요?\n1) a\n2) b\n3) c\n4) d\n5) e"],
	["list not trailing", "어느 쪽으로 할까요?\n1) a\n2) b\n\n이어서 긴 설명이 더 있어요. 어제 로그를 보면 알 수 있어요."],
	["a question at the end only", "1) 알림 행 고침\n2) 입력창 고침\n\n더 볼 게 있나요?"],
];
for (const [name, text] of PLAIN) test(`stays plain: ${name}`, () => expect(normalizeAsk(text)).toBe(text));

test("a contract block and an exact draft approval block are never touched", () => {
	const issue = "[ask] 결정이 필요해요\n결정: 게이트웨이 설정\n**1) 고치기**\n재부팅해도 살아나요\n**2) 두기**\n다음 재부팅까지 괜찮아요";
	const draft = `[ask] 초안이에요\n${draftApprovalBlock({ to: "a@example.test", body: "본문이에요", ref: "abc123", question: "보낼까요?" } as Parameters<typeof draftApprovalBlock>[0])}`;
	expect(normalizeAsk(issue)).toBe(issue);
	expect(normalizeAsk(draft)).toBe(draft);
});

test("a numbered body list above the block does not cost the buttons; a clip keeps the block", () => {
	const text = normalizeAsk(`보고예요.\n1) 하나\n2) 둘\n\n${"긴 보고 ".repeat(400)}\n\n어느 쪽으로 할까요?\n1) 반영\n2) 보류`);
	expect(parseChoices(text).options.map(o => o.label)).toEqual(["반영", "보류"]);
	const cut = clipKeepingAsk(text, 1800);
	expect(cut.length).toBeLessThanOrEqual(1800);
	expect(parseChoices(cut).options.map(o => o.label)).toEqual(["반영", "보류"]);
});
