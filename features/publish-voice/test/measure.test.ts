import { describe, expect, test } from "bun:test";
import { endingOf, flat, measure } from "../lib/measure.ts";
import { buildProfile, makeDoc } from "../lib/profile.ts";
import { synth } from "./synth.ts";

const ENDINGS = ["했다", "갔다", "왔다", "봤다", "섰다", "좋아요", "가요", "와요", "봐요", "갑니다", "했어", "몰라"];
const SKEW = [0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 0];
const endingsText = (n: number) => Array.from({ length: n }, (_, i) => `그날은 ${ENDINGS[SKEW[i % SKEW.length] ?? 0]}.`).join("\n");

describe("재기", () => {
	test("같은 입력은 같은 출력", () => {
		const text = synth("opinion", 20, 3);
		expect(measure(text)).toEqual(measure(text));
	});

	test("어미 종류는 정해진 말투 표로 갈라요", () => {
		expect(endingOf("감사합니다.")).toBe("hapsyo");
		expect(endingOf("좋아요ㅋㅋ")).toBe("haeyo");
		expect(endingOf("비가 왔다.")).toBe("haera");
		expect(endingOf("오늘도 했음")).toBe("eumseum");
		expect(endingOf("진짜 몰라")).toBe("banmal");
		expect(endingOf("그래서 서울역")).toBe("noun");
	});

	test("문장 수를 열 배로 늘려도 정규화 엔트로피가 크게 변하지 않아요", () => {
		const few = measure(endingsText(18)).endEntropy;
		const many = measure(endingsText(180)).endEntropy;
		expect(few).toBeGreaterThan(0.5);
		expect(many).toBeLessThanOrEqual(1);
		expect(Math.abs(many - few)).toBeLessThan(0.2);
	});

	test("내용 명사는 측정값에도 프로필에도 남지 않아요", () => {
		const text = ["나는 은하수철도에서 자작나무숲까지 걸었다.", "우리가 향한 곳은 은하수철도", "자작나무숲은 조용했다.", "그래서 은하수철도를 다시 찾았다."].join("\n").repeat(5);
		const doc = makeDoc({ id: "d1", origin: "scope", source: "folder", text });
		const profile = buildProfile({ voice: "me", kind: "self", docs: [doc], cells: [doc.cell], now: new Date(0) });
		const stored = JSON.stringify([measure(text), doc, profile]);
		for (const noun of ["은하수", "철도", "자작나무", "나무숲"]) expect(stored).not.toContain(noun);
	});

	test("두 합성 저자는 서로 다른 값을 내요", () => {
		const a = measure(synth("authorA", 12, 1));
		const b = measure(synth("authorB", 12, 1));
		expect(a.sentLen.mean - b.sentLen.mean).toBeGreaterThan(5);
		expect(a.endings.hapsyo).toBeGreaterThan(0.5);
		expect(b.endings.haeyo).toBeGreaterThan(0.5);
		expect(b.punct.exclaim).toBeGreaterThan(a.punct.exclaim);
	});

	test("빈 글도 숫자만 내요", () => {
		expect(Object.values(flat(measure(""))).every(Number.isFinite)).toBe(true);
	});
});
