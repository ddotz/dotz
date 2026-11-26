import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { clipKeepingAsk, normalizeAsk } from "./ask-normalize.ts";
import { ASK_A, ASK_B } from "./ask-normalize.fixture.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { cardBlock, cleanChoices, decisionText, detailOf, hasDecisionHead, INERT, issueBlock, parseChoices, parseDecisions, plainDecisions, replyChoiceBlock, stripRecommendMark, unnumbered } from "./choices.ts";
import { decisionsOf } from "./notices-decisions.ts";

const cardJs = readFileSync(join(import.meta.dir, "../web/js/10-decision-card.js"), "utf8");
const evidenceJs = readFileSync(join(import.meta.dir, "../web/js/10-card-evidence.js"), "utf8");
const web = new Function(`${cardJs.slice(0, cardJs.indexOf("const DC = {"))}\n${evidenceJs}\nreturn { parseChoices, inlineBody };`)() as {
	parseChoices: (t: string) => { blocks: { title: string; evidence?: string[]; options: { label: string; desc: string }[] }[] };
	inlineBody: (t: string) => string;
};
const LEAD = "닥터 점검: 정할 것이 3가지 있어요.";
const THREE = [
	LEAD,
	"",
	cardBlock({ subject: "디스크", question: "오래된 로그를 지울까요?", evidence: ["로그 12GB, 어제 9GB", "가장 큰 파일: hub.log"], options: [{ name: "지워요", result: "7일 넘은 로그만 지워요" }, { name: "둬요", result: "그대로 둬요" }] }),
	"",
	cardBlock({ subject: "토큰", question: "점검 모델을 바꿀까요?", evidence: ["어제 4.1M, 평소 0.9M", "가장 큰 세션: lane:abc"], options: [{ name: "바꿔요", result: "작은 모델로 바꿔요" }, { name: "둬요", result: "그대로 둬요" }] }),
	"",
	cardBlock({ subject: "업데이트", question: "다시 받을까요?", evidence: ["실패 2번, 마지막 08:00", "원인: 네트워크"], options: [{ name: "받아요", result: "지금 다시 받아요" }, { name: "둬요", result: "내일 다시 봐요" }] }),
].join("\n");

test("cardBlock writes the head, the card's own evidence and each option with its result line", () => {
	expect(cardBlock({ subject: "디스크", question: "지울까요?", evidence: ["로그 12GB", " "], options: [{ name: "지워요", result: "7일 넘은 것만" }, { name: "둬요", result: "" }] })).toBe(
		"결정: 디스크 · 지울까요?\n로그 12GB\n**1) 지워요**\n7일 넘은 것만\n**2) 둬요**",
	);
});

test("bullet evidence, a blank line, then numbered options: the numbered list is the card's options and the bullets stay its evidence", () => {
	const text = "[ask] 패치가 안 읽히는 곳에 있었어요.\n\n결정: 패치 · 옮길까요?\n- 지금 앱은 하나예요.\n- 전 → 후: 파일A → 파일B\n\n**1) 옮기고 치우기**\n백업 뒤 옮겨요.\n**2) 옮기기만**\n남겨요.\n**3) 그대로**\n안 바뀌어요.\n\n- 뒤 보고 한 줄";
	const [b] = parseDecisions(normalizeAsk(text)).blocks;
	expect(b!.options.map(o => o.label)).toEqual(["옮기고 치우기", "옮기기만", "그대로"]);
	expect(normalizeAsk(text)).toContain("- 지금 앱은 하나예요.");
});

const alertOf = (text: string) => decisionsOf({ ts: "2026-11-24T00:00:00.000Z", kind: "out", source: "gateway", target: "alert", text });

test("three cards of one message each store their own evidence lines, then the shared lead, with no 결정: head line", () => {
	const cards = alertOf(THREE);
	expect(cards.map(c => c.title)).toEqual(["디스크 · 오래된 로그를 지울까요?", "토큰 · 점검 모델을 바꿀까요?", "업데이트 · 다시 받을까요?"]);
	expect(cards.map(c => c.detail)).toEqual([`로그 12GB, 어제 9GB\n가장 큰 파일: hub.log\n\n${LEAD}`, `어제 4.1M, 평소 0.9M\n가장 큰 세션: lane:abc\n\n${LEAD}`, `실패 2번, 마지막 08:00\n원인: 네트워크\n\n${LEAD}`]);
	expect(cards.map(c => c.evidence)).toEqual([["로그 12GB, 어제 9GB", "가장 큰 파일: hub.log"], ["어제 4.1M, 평소 0.9M", "가장 큰 세션: lane:abc"], ["실패 2번, 마지막 08:00", "원인: 네트워크"]]);
	expect(parseDecisions(THREE).blocks.map(b => b.evidence)).toEqual(cards.map(c => c.evidence));
});

test("a single card with evidence stores its lines then the lead; a card without evidence keeps the whole message and carries no evidence", () => {
	const one = `${LEAD}\n\n${cardBlock({ subject: "디스크", question: "지울까요?", evidence: ["로그 12GB"], options: [{ name: "지워요", result: "지워요" }, { name: "둬요", result: "둬요" }] })}\n\n뒤에 한 줄`;
	expect(alertOf(one).map(c => [c.detail, c.evidence])).toEqual([[`로그 12GB\n\n${LEAD}\n\n뒤에 한 줄`, ["로그 12GB"]]]);
	const bare = `${LEAD}\n\n결정: 디스크 · 지울까요?\n**1) 지워요**\n지워요\n**2) 둬요**\n둬요`;
	expect(alertOf(bare).map(c => [c.detail, c.evidence])).toEqual([[bare, undefined]]);
});

test("a 결정: head with no option or one option before the cards stores nothing and shifts no card onto its neighbour's evidence", () => {
	const cards = (first: string) => `점검 결과예요.\n\n${first}\n\n결정: 디스크 · 지울까요?\n로그 12GB\n**1) 지워요**\n지워요\n**2) 둬요**\n둬요\n\n결정: 토큰 · 바꿀까요?\n어제 4.1M\n**1) 바꿔요**\n바꿔요\n**2) 둬요**\n둬요`;
	for (const first of ["결정: 참고만 해 주세요", "결정: 하나뿐\n**1) 알겠어요**"]) {
		expect(alertOf(cards(first)).map(c => [c.title, c.detail])).toEqual([
			["디스크 · 지울까요?", "로그 12GB\n\n점검 결과예요."],
			["토큰 · 바꿀까요?", "어제 4.1M\n\n점검 결과예요."],
		]);
	}
});

test("the page reads the same evidence per card and keeps it out of the body above the cards", () => {
	expect(web.parseChoices(THREE).blocks.map(b => [b.title, b.evidence])).toEqual(parseDecisions(THREE).blocks.map(b => [b.title, b.evidence]));
	expect(web.inlineBody(THREE)).toBe(LEAD);
});

test("a headed block of one option with evidence stays in the chat body next to a real card, as it did before cards carried evidence", () => {
	const t = "점검이에요.\n\n결정: 참고 · 이건 알려만 드려요\n로그가 12GB예요.\n**1) 알겠어요**\n\n결정: 디스크 · 지울까요?\n**1) 지워요**\n지워요\n**2) 둬요**\n둬요";
	expect(web.inlineBody(t)).toBe("점검이에요.\n\n결정: 참고 · 이건 알려만 드려요\n로그가 12GB예요.\n**1) 알겠어요**");
});

test("with evidence lines under its head, parseChoices still asks the head's question, so 자세히 · 나중에 find the card", () => {
	const one = `${LEAD}\n\n${cardBlock({ subject: "디스크", question: "지울까요?", evidence: ["로그 12GB", "세션 abc"], options: [{ name: "지워요", result: "지워요" }, { name: "둬요", result: "둬요" }] })}`;
	expect(parseChoices(one)).toEqual({ question: "결정: 디스크 · 지울까요?", options: [{ n: 1, label: "지워요" }, { n: 2, label: "둬요" }] });
	expect(parseChoices("결정: [ask] 결정: 고를까요?\n근거 한 줄\n**1) 네**\n**2) 아니요**").question).toBe("결정: 고를까요?");
});

const seen = (s: string) => s.replaceAll(INERT, "");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const readBack = (text: string) => {
	const hub = parseDecisions(text).blocks.map(b => ({ title: seen(b.title), evidence: (b.evidence ?? []).map(seen), options: b.options.map(o => [seen(o.label), seen(o.desc)]) }));
	const page = web.parseChoices(text).blocks.map(b => ({ title: seen(b.title), evidence: (b.evidence ?? []).map(seen), options: b.options.map(o => [seen(o.label), seen(o.desc)]) }));
	const discord = parseChoices(text);
	return { hub, page, discord: { question: seen(discord.question ?? ""), labels: discord.options.map(o => seen(o.label)) } };
};
const given = (c: { subject: string; question: string; evidence?: string[]; options: { name: string; result: string }[] }) => {
	const title = [c.subject, c.question].map(flat).filter(Boolean).join(" · ");
	const card = { title, evidence: (c.evidence ?? []).map(flat).filter(Boolean), options: c.options.map(o => [flat(o.name), flat(o.result)]) };
	return { hub: [card], page: [card], discord: { question: `결정: ${title}`, labels: card.options.map(o => o[0]) } };
};

test("data that looks like a head, an option, a fence or a dropped line reads back as the words given, on the hub, the page and Discord", () => {
	const O = [{ name: "지워요", result: "7일 넘은 것만" }, { name: "둬요", result: "그대로" }];
	const cases = [
		{ subject: "디스크", question: "지울까요?", evidence: ["결정: 다른 것", "Decision: pending", "**결정:** 굵은 머리"], options: O },
		{ subject: "디스크", question: "지울까요?", evidence: ["1) 큰 파일 hub.log", "**1) 큰 파일** hub.log", "> 2) 인용"], options: O },
		{ subject: "디스크", question: "지울까요?", evidence: ["```", "로그"], options: O },
		{ subject: "디스크", question: "지울까요?", evidence: ["번호로 답해 주세요", "[file] /tmp/a.png"], options: O },
		{ subject: "디스크", question: "지울까요?", options: [{ name: "지워요", result: "3) 로그만" }, { name: "둬요", result: "번호를 알려 주세요" }] },
		{ subject: "[ask] 디스크", question: "결정: 지울까요?**", options: [{ name: "1) **지워요**", result: "[file] /tmp/a" }, { name: "a**b*", result: "> 인용" }] },
	];
	for (const c of cases) expect(readBack(cardBlock(c))).toEqual(given(c));
});

test("cardBlock refuses a call no card can come from", () => {
	const O = [{ name: "지워요", result: "" }, { name: "둬요", result: "" }];
	expect(() => cardBlock({ subject: "디스크", question: "지울까요?", options: [O[0]!] })).toThrow();
	expect(() => cardBlock({ subject: "디스크", question: "지울까요?", options: [] })).toThrow();
	expect(() => cardBlock({ subject: "디스크", question: "지울까요?", options: [{ name: " ", result: "x" }, O[1]!] })).toThrow();
	expect(() => cardBlock({ subject: " ", question: "", options: O })).toThrow();
});

test("any card cardBlock writes reads back as the same title, evidence and options on the hub, the page and Discord", () => {
	const piece = fc.constantFrom("가", "나", "a", " ", ".", "?", "·", "'", "\"", "$", "-", ":", ")", "*", "**", "`", "```", "결정:", "Decision:", "[file] ", "[ask]", ">", "1", "2) ", "번호로 답해", "\n");
	const line = fc.array(piece, { minLength: 1, maxLength: 8 }).map(p => p.join("")).filter(s => /[가나a]/.test(s));
	fc.assert(fc.property(line, line, fc.array(line, { maxLength: 4 }), fc.array(fc.record({ name: line, result: fc.oneof(line, fc.constant("")) }), { minLength: 2, maxLength: 4 }), (subject, question, evidence, options) => {
		const c = { subject, question, evidence, options };
		expect(readBack(cardBlock(c))).toEqual(given(c));
	}));
});

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
	const body = "[ask] 세 가지예요\n결정: 가\n참고 한 줄\n**1) 하나**\n설명\n**2) 둘**\n설명\n뒤에 한 줄\n\n결정: 나\n**1) 셋**\n설명\n**2) 넷**\n설명\n번호로 답해 주세요";
	expect(decisionText(body, 0)).toBe("참고 한 줄\n\n세 가지예요\n\n뒤에 한 줄");
	expect(decisionText(body, 1)).toBe("세 가지예요");
});

test("a message whose only 결정: head has one option is no card: its text is that head's lines and the lead, never empty", () => {
	const block = "결정: 참고 · 알려만 드려요\n로그가 12GB예요.\n**1) 알겠어요**\n알겠다고 답해요";
	expect(decisionText(block, 0)).toBe("로그가 12GB예요.");
	expect(decisionText(`정리했어요.\n\n${block}`, 0)).toBe("로그가 12GB예요.\n\n정리했어요.");
});

test("the sheet of a card with evidence keeps the message's pictures, also when the message has no text before its first card", () => {
	const sheet = new Function("noticeKo", "NK", "ntPlain", `${cardJs.slice(0, cardJs.indexOf("const DC = {"))}\n${evidenceJs}\nreturn ntEvFold;`)((s: string) => s, {}, (s: string) => s) as (n: { title: string; decision: { evidence?: string[] } }, text: string) => { head: string; rest: string } | null;
	const fold = (text: string) => {
		const [card] = alertOf(text);
		return sheet({ title: card!.title, decision: { evidence: card!.evidence } }, card!.detail);
	};
	const card = cardBlock({ subject: "화면", question: "버튼을 옮길까요?", evidence: ["버튼이 겹쳐요"], options: [{ name: "옮겨요", result: "아래로 내려요" }, { name: "둬요", result: "그대로 둬요" }] });
	expect(fold(`${card}\n[file] /tmp/shot.png`)).toEqual({ head: "버튼이 겹쳐요\n[file] /tmp/shot.png", rest: "" });
	expect(fold(`화면 점검이에요.\n\n${card}\n[file] /tmp/shot.png`)).toEqual({ head: "버튼이 겹쳐요\n[file] /tmp/shot.png", rest: "화면 점검이에요." });
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

test("a head written twice is one head: no marker and no second label in the title or the question", () => {
	const text = "결정: [ask] 결정: 남은 디자인 두 가지를 어떻게 할까요?\n**1) 둘 다**\n설명\n**2) 하나만**\n설명";
	expect(parseDecisions(text).blocks.map(b => b.title)).toEqual(["남은 디자인 두 가지를 어떻게 할까요?"]);
	expect(parseChoices(text).question).toBe("결정: 남은 디자인 두 가지를 어떻게 할까요?");
});

test("아니요 and 다른 … answer at once; 안 됨, 고치기 and a marked option ask for text", () => {
	expect(["아니요", "아냐", "다른 날로", "안 됨", "고치기"].map(label => detailOf({ label }))).toEqual([false, false, false, true, true]);
	expect(detailOf({ label: "아니요", detail: true })).toBe(true);
});

test("plainDecisions keeps each question and drops its options and their lines", () => {
	const text = "README를 올렸어요.\n\n결정: 라이선스를 무엇으로 할까요?\n**1) MIT**\n짧아요\n**2) Apache-2.0**\n특허 조항\n\n- 남은 것: 배지";
	expect(plainDecisions(text)).toBe("README를 올렸어요.\n\n라이선스를 무엇으로 할까요?\n\n- 남은 것: 배지");
	expect(plainDecisions("본문\n1) 하나\n2) 둘")).toBe("본문\n1) 하나\n2) 둘");
});

test("a send card is never cut, however long: the owner approves only a draft he saw whole", () => {
	const card = `[ask] 초안이에요\n${draftApprovalBlock({ to: "a@example.test", body: "긴 본문이에요.\n".repeat(300), ref: "abc123", question: "보낼까요?" } as Parameters<typeof draftApprovalBlock>[0])}`;
	expect(card.length).toBeGreaterThan(1800);
	expect(clipKeepingAsk(card, 1800)).toBe(card);
});

test("a choice label that already starts with its number is numbered once, whoever wrote the number", () => {
	const written = "결정: 어디로 받을까요?\n**1) 1) 회사 메일로 받기**\n본사 주소로 와요\n**2) 2. 집 메일로 받기**\n집 주소로 와요";
	expect(parseDecisions(written).blocks[0]!.options.map(o => `${o.n}) ${o.label}`)).toEqual(["1) 회사 메일로 받기", "2) 집 메일로 받기"]);
	expect(parseChoices(written).options.map(o => `${o.n}) ${o.label}`)).toEqual(["1) 회사 메일로 받기", "2) 집 메일로 받기"]);
	const posted = replyChoiceBlock("어디로 받을까요?", cleanChoices(["1) 회사 메일로 받기", "2) 집 메일로 받기"]));
	expect(posted.split("\n").filter(l => l.startsWith("**"))).toEqual(["**1) 회사 메일로 받기**", "**2) 집 메일로 받기**", "**3) 직접 쓸게 …**"]);
	expect(issueBlock("어떻게 할까요?", [{ name: "1) 원인 확인", result: "살펴봐요." }, { name: "넘어가요", result: "" }])).toBe("결정: 어떻게 할까요?\n**1) 원인 확인**\n살펴봐요.\n**2) 넘어가요**");
});

test("a list under an option's description is part of that option, never text left for the folded rest", () => {
	const text = "[ask] 초안을 만들었어요.\n\n결정: 신청서 · 비어 있는 칸 채우기\n**1) 지금 바로 정하기 …**\n아래 두 가지를 답해 주세요\n- 공개일: 언제로 할지\n  모르면 비워 둬요\n- 회원 번호\n**2) 같이 하기**\n로그인해 주세요\n\n끝나면 알려 드릴게요.";
	const [o1, o2] = parseDecisions(text).blocks[0]!.options;
	expect(o1!.desc).toBe("아래 두 가지를 답해 주세요\n- 공개일: 언제로 할지\n모르면 비워 둬요\n- 회원 번호");
	expect([o2!.label, o2!.desc]).toEqual(["같이 하기", "로그인해 주세요"]);
	const rest = decisionText(text, 0);
	expect(rest).not.toContain("회원 번호");
	expect(rest).toContain("끝나면 알려 드릴게요.");
	expect(plainDecisions(text)).not.toContain("공개일");
	// A list after a blank line is the message going on, not the option's.
	const after = "결정: 배포 · 올릴까요?\n**1) 올리기**\n바로 올려요\n**2) 두기**\n그대로 둬요\n\n- 참고 항목";
	expect(parseDecisions(after).blocks[0]!.options[1]!.desc).toBe("그대로 둬요");
});

test("a label is cut only at a number the model wrote as a list mark", () => {
	for (const [label, shown] of [["3개월 보관", "3개월 보관"], ["2.5 버전으로", "2.5 버전으로"], ["10) 열 번째", "열 번째"], ["", ""]] as const) expect(unnumbered(label)).toBe(shown);
});
