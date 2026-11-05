import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAsk } from "./ask-normalize.ts";
import { hasDecisionHead, parseChoices, parseDecisions } from "./choices.ts";
import { parseDraftApproval } from "./draft-approval.ts";
import { brokenHeads, ownerText } from "./owner-text.ts";
import { SHOT_BULLETS, SHOT_DRAFT } from "./owner-text.fixture.ts";
import { parseTone } from "./tone.ts";

// The page's own parser, the code the bundle serves: the hub and the web must read one text the same way.
const card = readFileSync(join(import.meta.dir, "../web/js/10-decision-card.js"), "utf8");
const web = new Function(`${card.slice(0, card.indexOf("const DC = {"))}\nreturn { parseChoices, stripChoices, inlineBody };`)() as {
	parseChoices: (t: string) => { blocks: { title: string; options: { n: number; label: string; desc: string }[] }[] };
	stripChoices: (t: string) => string;
	inlineBody: (t: string) => string;
};
const shown = (text: string) => parseTone(ownerText(text)).text;
const labels = (text: string) => parseDecisions(ownerText(text)).blocks.map(b => b.options.map(o => o.label));
// Hub and page agree on every block, title, label and description, and the raw "결정:" line never stays in the body under the card.
const agree = (text: string) => {
	const body = shown(text);
	const hub = parseDecisions(body).blocks.map(b => ({ title: b.title, options: b.options.map(o => [o.n, o.label, o.desc]) }));
	const page = web.parseChoices(body).blocks.filter(b => b.options.length > 1).map(b => ({ title: b.title, options: b.options.map(o => [o.n, o.label, o.desc]) }));
	expect(page).toEqual(hub);
	if (hub.length) expect(web.inlineBody(body)).not.toMatch(/^\s*(?:\*\*)?(?:결정|decision)[^\n]*[:：]/im);
};
const SEND = ["보내기", "고치기", "보내지 않기"];

describe("the two messages of 2026-11-05", () => {
	test("bullets under a 결정 line become options with their descriptions", () => {
		const out = ownerText(SHOT_BULLETS);
		const [block] = parseDecisions(out).blocks;
		expect(parseDecisions(out).blocks).toHaveLength(1);
		expect(block!.title).toBe("새 시험판을 회사 메일로 보낼까요?");
		expect(block!.options.map(o => o.label)).toEqual(["보내기", "보내지 않기"]);
		expect(block!.options[0]!.desc).toContain("Hatch-portable.zip");
		expect(parseTone(out).tone).toBe("ask");
		expect(out).toContain("Hatch 시험판의 마우스 지연");
		agree(SHOT_BULLETS);
	});
	test("the send approval keeps its id and its three labels, so the draft flow still reads it", () => {
		const out = ownerText(SHOT_DRAFT);
		expect(labels(SHOT_DRAFT)).toEqual([SEND]);
		const d = parseDraftApproval(out);
		expect(d?.ref).toBe("hatch-2769e70");
		expect(d?.to).toBe("owner@example.com");
		agree(SHOT_DRAFT);
	});
});

describe("every shape of an option list under a 결정 line", () => {
	const Q = "결정: 어느 쪽으로 할까요?";
	const cases: [string, string, string[]][] = [
		["bullets with a description", `${Q}\n- 이름: 설명\n- 다른 이름: 설명`, ["이름", "다른 이름"]],
		["plain numbers", `${Q}\n1) 이름\n2) 다른 이름`, ["이름", "다른 이름"]],
		["dotted numbers", `${Q}\n1. 이름\n2. 다른 이름`, ["이름", "다른 이름"]],
		["circled numbers", `${Q}\n① 이름\n② 다른 이름`, ["이름", "다른 이름"]],
		["bold dotted numbers", `${Q}\n**1. 이름**\n**2. 다른 이름**`, ["이름", "다른 이름"]],
		["a description on the option line", `${Q}\n1) 이름 - 무슨 일이 생겨요\n2) 다른 이름: 다른 일이 생겨요`, ["이름", "다른 이름"]],
		["a bold name, then its description", `${Q}\n- **이름**: 설명\n- **다른 이름** - 설명`, ["이름", "다른 이름"]],
		["blank lines between options", `${Q}\n\n- 이름\n\n- 다른 이름`, ["이름", "다른 이름"]],
		["a bold head", `**결정:** 어느 쪽으로 할까요?\n1) 이름\n2) 다른 이름`, ["이름", "다른 이름"]],
		["a heading head", `### 결정: 어느 쪽으로 할까요?\n- 이름\n- 다른 이름`, ["이름", "다른 이름"]],
		["an English block", "Decision: Which one?\n- First: does this\n- Second: does that", ["First", "Second"]],
		["a decision with an id", "결정: 보낼까요? (mail-12)\n- 보내기\n- 보내지 않기", ["보내기", "보내지 않기"]],
	];
	for (const [name, text, want] of cases)
		test(name, () => {
			expect(labels(text)).toEqual([want]);
			expect(parseTone(ownerText(text)).tone).toBe("ask");
			agree(text);
		});
	test("the description stays with its option", () => {
		const [o] = parseDecisions(ownerText(`${Q}\n1) 이름 - 무슨 일이 생겨요\n2) 다른 이름`)).blocks[0]!.options;
		expect(o).toMatchObject({ label: "이름", desc: "무슨 일이 생겨요" });
	});
	test("a block in the middle of the message keeps the text after it", () => {
		const out = ownerText(`앞 문단이에요.\n\n${Q}\n- 이름: 설명\n- 다른 이름: 설명\n\n뒤 문단이에요.`);
		expect(parseDecisions(out).blocks[0]!.options).toHaveLength(2);
		expect(web.inlineBody(parseTone(out).text)).toContain("뒤 문단이에요.");
		agree(out);
	});
	test("several decisions are several blocks", () => {
		const text = "결정 1: 첫째를 할까요?\n- 하기: 설명\n- 말기: 설명\n\n결정 2: 둘째를 할까요?\n1. 하기\n2. 말기";
		expect(labels(text)).toEqual([["하기", "말기"], ["하기", "말기"]]);
		agree(text);
	});
	test("a bare 결정 필요 heading does not stay above its blocks", () => {
		const out = parseTone(ownerText("보고예요.\n\n**결정 필요**\n\n결정: 할까요?\n1) 하기\n2) 말기")).text;
		expect(out).not.toContain("결정 필요");
	});
	test("[fail] and [done] keep their marker, the block is still a card", () => {
		for (const tone of ["fail", "done"]) {
			const out = ownerText(`[${tone}] 끝났어요.\n\n${Q}\n- 이름\n- 다른 이름`);
			expect(out.startsWith(`[${tone}]`)).toBe(true);
			expect(hasDecisionHead(parseDecisions(out).blocks)).toBe(true);
		}
	});
	test("Discord buttons read the same options", () => {
		expect(parseChoices(ownerText(SHOT_BULLETS)).options.map(o => o.label)).toEqual(["보내기", "보내지 않기"]);
		expect(parseChoices(ownerText(SHOT_DRAFT)).options.map(o => o.label)).toEqual(SEND);
	});
	test("normalizing twice changes nothing", () => {
		for (const [, text] of cases) expect(ownerText(ownerText(text))).toBe(ownerText(text));
		for (const text of [SHOT_BULLETS, SHOT_DRAFT]) expect(ownerText(ownerText(text))).toBe(ownerText(text));
	});
});

describe("what stays as written", () => {
	const untouched: [string, string][] = [
		["a code block", "예시예요.\n```\n결정: 할까요?\n- 하기\n- 말기\n```"],
		["a quote", "그 메일에 이렇게 있었어요.\n\n> 결정: 할까요?\n> - 하기\n> - 말기"],
		["a past decision over a list of facts", "결정: 사이드바를 유지했어요.\n- 너비 고정\n- 아이콘 교체"],
		["a report list", "오늘 한 일이에요.\n- 메일 보냈어요\n- 파일 옮겼어요"],
		["ordinary prose", "결정을 내렸어요. 내일 다시 볼게요."],
		["a question and a list of reasons", "왜 이렇게 됐을까요?\n1) 캐시가 낡았어요\n2) 설정이 달랐어요"],
	];
	for (const [name, text] of untouched) test(name, () => expect(ownerText(text)).toBe(text));
	test("a numbered line in a code block stays in the body under a card", () => {
		const body = "결정: 할까요?\n1) 하기\n2) 말기\n\n```\n1) 코드\n```";
		expect(web.inlineBody(body)).toContain("1) 코드");
	});
});

describe("a 결정 line the parser cannot make a card from", () => {
	test("is reported, and a question loses the raw label", () => {
		const seen: string[] = [];
		const out = ownerText("[ask] 일이 있어요.\n\n결정: 지금 보낼까요?", head => seen.push(head));
		expect(seen).toEqual(["결정: 지금 보낼까요?"]);
		expect(parseTone(out).text).not.toContain("결정:");
		expect(parseTone(out).text).toContain("지금 보낼까요?");
	});
	test("one option is not a choice", () => {
		expect(brokenHeads("결정: 보낼까요?\n1) 보내기")).toEqual(["결정: 보낼까요?"]);
	});
	test("a statement keeps its words but is still counted", () => {
		const seen: string[] = [];
		expect(ownerText("결정: 사이드바를 유지했어요.", head => seen.push(head))).toBe("결정: 사이드바를 유지했어요.");
		expect(seen).toHaveLength(1);
	});
	test("a finished block is not reported", () => {
		const seen: string[] = [];
		ownerText(SHOT_DRAFT, head => seen.push(head));
		ownerText(SHOT_BULLETS, head => seen.push(head));
		expect(seen).toEqual([]);
	});
	test("the old rule still holds: normalizeAsk leaves an [ask] without a block to the session", () => {
		expect(normalizeAsk("[ask] 이거 할까요?")).toBe("[ask] 이거 할까요?");
	});
});
