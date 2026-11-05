import { describe, expect, test } from "bun:test";
import { changesBetween, correctionsFrom, rulesFrom } from "../lib/learn.ts";

const CELL = "medium-opinion" as const;
const fix = (before: string, after: string, run: string) => correctionsFrom({ before, after, cell: CELL, run, ts: `2026-01-0${run}T00:00:00Z` });

describe("고친 내용", () => {
	test("바뀐 문장만 짝으로 뽑고, 같은 글은 아무것도 뽑지 않아요", () => {
		const before = "그러나 비용만 따지는 것은 문제입니다. 모임은 열렸습니다. 이 동네는 조용합니다.";
		expect(changesBetween(before, before)).toEqual([]);
		expect(changesBetween(before, before.replace("그러나", "하지만"))).toEqual([{ from: "그러나 비용만 따지는 것은 문제입니다.", to: "하지만 비용만 따지는 것은 문제입니다." }]);
		expect(changesBetween(before, `${before} 마지막 문장을 새로 넣었습니다.`)).toEqual([{ from: "", to: "마지막 문장을 새로 넣었습니다." }]);
	});

	test("같은 고침이 두 번 나오면 규칙이 되고, 한 번이면 최근 고침이에요", () => {
		const first = fix("그러나 비용만 따지는 것은 문제입니다.", "하지만 비용만 따지는 것은 문제입니다.", "1");
		expect(rulesFrom(first, CELL)).toEqual({ rules: [], recent: ['"그러나 비용만 따지는 것은 문제입니다." -> "하지만 비용만 따지는 것은 문제입니다."'] });
		const both = [...first, ...fix("그러나 시장은 아직 남아 있습니다.", "하지만 시장은 아직 남아 있습니다.", "2")];
		const learned = rulesFrom(both, CELL);
		expect(learned.rules).toEqual(['고쳐 쓴 말: "그러나" -> "하지만"']);
		expect(learned.recent).toEqual([]);
		expect(rulesFrom(both, "short-guide").rules).toEqual([]);
	});

	test("한 번의 고침 안에서 두 번 나온 같은 바꿈은 규칙이 되지 않아요", () => {
		const one = fix("그러나 비용이 문제입니다. 그러나 시장은 남아 있습니다.", "하지만 비용이 문제입니다. 하지만 시장은 남아 있습니다.", "1");
		expect(one).toHaveLength(2);
		expect(rulesFrom(one, CELL).rules).toEqual([]);
	});

	test("숫자나 이름이 바뀐 고침은 사실 수정이라 문체 규칙으로 올라가지 않아요", () => {
		const facts = [...fix("모임은 3월 5일에 열렸습니다.", "모임은 3월 6일에 열렸습니다.", "1"), ...fix("모임은 4월 5일에 열렸습니다.", "모임은 4월 6일에 열렸습니다.", "2")];
		expect(facts.every(c => c.kind === "fact")).toBe(true);
		expect(rulesFrom(facts, CELL)).toEqual({ rules: [], recent: [] });
	});

	test("문장 끝 말투를 두 번 같은 쪽으로 고치면 끝맺음 규칙이 돼요", () => {
		const both = [...fix("시장은 아직 남아 있다.", "시장은 아직 남아 있습니다.", "1"), ...fix("골목은 오늘도 조용하다.", "골목은 오늘도 조용합니다.", "2")];
		expect(rulesFrom(both, CELL).rules.some(r => r.includes("합쇼체"))).toBe(true);
	});
});
