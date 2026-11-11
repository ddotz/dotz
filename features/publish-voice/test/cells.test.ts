import { describe, expect, test } from "bun:test";
import { type CellId, cellOfText, lengthOf, purposeOf, requestAxes, resolveCell } from "../lib/cells.ts";
import { cellFor, routeRequest } from "../lib/route.ts";
import { synth } from "./synth.ts";

describe("길이 경계", () => {
	test.each([
		[0, "short"],
		[499, "short"],
		[500, "medium"],
		[2999, "medium"],
		[3000, "long"],
		[80000, "long"],
	] as const)("%i자는 %s", (chars, want) => expect(lengthOf(chars)).toBe(want));
});

describe("용도 판별", () => {
	test("합성한 의견, 이야기, 안내 글을 가려요", () => {
		expect(purposeOf(synth("opinion", 12, 1))).toBe("opinion");
		expect(purposeOf(synth("story", 12, 1))).toBe("story");
		expect(purposeOf(synth("guide", 12, 1))).toBe("guide");
	});

	test("파일 이름이나 제목의 말이 표면 점수보다 먼저예요", () => {
		expect(purposeOf(synth("story", 12, 1), "공지-3")).toBe("guide");
		expect(purposeOf(synth("guide", 12, 1), "칼럼 초안")).toBe("opinion");
		expect(purposeOf(synth("opinion", 12, 1), "일기")).toBe("story");
	});

	test("글자 수와 용도가 합쳐져 칸이 돼요", () => {
		expect(cellOfText(synth("opinion", 28, 2))).toBe("medium-opinion");
		expect(cellOfText(synth("guide", 6, 2))).toBe("short-guide");
	});
});

describe("요청 말과 칸의 대응", () => {
	test.each([
		["칼럼 한 편", { length: "medium", purpose: "opinion" }],
		["에세이 써 줘", { length: "medium", purpose: "story" }],
		["책 원고 이어서", { length: "long" }],
		["스레드로 올릴 글", { length: "short" }],
		["블로그 글", { length: "medium" }],
		["뉴스레터", { length: "medium" }],
		["공지문", { length: "short", purpose: "guide" }],
		["설명글 하나", { length: "medium", purpose: "guide" }],
		["3000자 블로그", { length: "long" }],
		["짧게 블로그 글", { length: "short" }],
		["길게 칼럼", { length: "long", purpose: "opinion" }],
	] as const)("%s", (request, want) => {
		const a = requestAxes(request);
		expect({ length: a.length, purpose: a.purpose }).toEqual(want);
	});

	test("비는 축은 프로필에서 글이 가장 많은 칸으로 채우고, 채울 글이 없으면 물어요", () => {
		const counts: Partial<Record<CellId, number>> = { "medium-story": 3, "medium-opinion": 7 };
		expect(resolveCell({ length: "medium" }, counts).cell).toBe("medium-opinion");
		expect(resolveCell({}, counts).cell).toBe("medium-opinion");
		expect(resolveCell({ length: "medium", purpose: "guide" }, counts).cell).toBe("medium-guide");
		const none = resolveCell({ length: "long" }, counts);
		expect(none.cell).toBeUndefined();
		expect(none.ask).toBeDefined();
	});
});

describe("발동 시나리오 표", () => {
	test.each([
		["블로그 글 써 줘", true, "new", false],
		["이 글 칼럼으로 다듬어 줘", true, "edit", false],
		["뉴스레터 초안 잡아 줘", true, "new", false],
		["책 원고 3장 이어서 써 줘", true, "new", false],
		["내 말투로 스레드 올릴 글 써 줘", true, "new", false],
		["이 사람처럼 써 줘", true, "new", true],
		["공지문 다듬어 줘", true, "edit", false],
		["칼럼 청탁이 들어왔는데 800자로 한 편 부탁해", true, "new", false],
	] as const)("발동: %s", (request, fire, mode, other) => {
		const r = routeRequest(request, undefined, {});
		expect([r.fire, r.mode, r.other]).toEqual([fire, mode, other]);
	});

	test.each([
		["블로그에 올릴 글 써 보고 싶어", true],
		["오늘 작업 보고해 줘", false],
		["주간 보고서 써 줘", false],
	] as const)("보고는 보고서와 보고하다만 걸러요: %s", (request, fire) => {
		expect(routeRequest(request, undefined, {}).fire).toBe(fire);
	});

	test.each([
		["하루키처럼 블로그 글 써 줘", true],
		["이 사람처럼 써 줘", true],
		["평소처럼 블로그 글 써 줘", false],
		["지난번처럼 써 줘", false],
		["내 문체로 써 줘", false],
		["늘 쓰던 스타일로 써 줘", false],
	] as const)("다른 사람 흉내인지: %s", (request, other) => {
		expect(routeRequest(request, undefined, { "medium-story": 1 }).other).toBe(other);
	});

	test.each(["이 메일 답장 써 줘", "카톡 뭐라고 답할까", "README 고쳐 줘, API 문서 써 줘", "오늘 작업 보고해 줘", "이 코드 주석 달아 줘"])("발동하지 않음: %s", request => {
		expect(routeRequest(request, undefined, {}).fire).toBe(false);
	});

	test("요청에서 칸이 정해지는 것과 초안이 있으면 다듬기", () => {
		expect(routeRequest("이 글 요약 부탁해", undefined, {}).fire).toBe(false);
		const counts = { "medium-story": 4 };
		expect(routeRequest("조용한 아침 이야기", undefined, counts).cell).toBeUndefined();
		expect(cellFor("조용한 아침 이야기", undefined, counts).cell).toBe("medium-story");
		expect(routeRequest("이 글 칼럼으로 다듬어 줘", undefined, {}).cell).toBe("medium-opinion");
		expect(routeRequest("공지문 다듬어 줘", undefined, {}).cell).toBe("short-guide");
		expect(routeRequest("블로그 글 써 줘", "초안입니다.", {}).mode).toBe("edit");
	});

	test("요청에 없는 축은 초안에서 읽고, 요청이 말한 축이 이겨요", () => {
		const guide = synth("guide", 6, 2);
		const counts: Partial<Record<CellId, number>> = { "long-story": 9 };
		const fromDraft = routeRequest("이 글 다듬어 줘", guide, counts);
		expect([fromDraft.cell, fromDraft.basis]).toEqual([cellOfText(guide), "요청에 없는 쪽은 초안을 읽어 정했어요"]);
		expect(routeRequest("이 글 다듬어 줘", undefined, counts).cell).toBe("long-story");
		expect(routeRequest("이 글 칼럼으로 다듬어 줘", guide, counts).cell).toBe("medium-opinion");
		const named = routeRequest("공지문 다듬어 줘", synth("story", 40, 3), counts);
		expect(named.cell).toBe("short-guide");
		expect(named.basis).not.toContain("초안");
	});

	test("용도가 비는 요청은 글이 있으면 채우고 없으면 묻는다", () => {
		const empty = routeRequest("블로그 글 써 줘", undefined, {});
		expect([empty.cell, typeof empty.ask]).toEqual([undefined, "string"]);
		expect(routeRequest("블로그 글 써 줘", undefined, { "medium-story": 4 }).cell).toBe("medium-story");
	});
});
