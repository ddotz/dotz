import { describe, expect, test } from "bun:test";
import { computeCell } from "../lib/profile.ts";
import { docsOf } from "./synth.ts";

const status = (docs: ReturnType<typeof docsOf>, id: Parameters<typeof computeCell>[1]) => computeCell(docs, id);

describe("칸 상태", () => {
	test("문턱 아래는 empty이고 값이 없어요", () => {
		const docs = docsOf("opinion", 2, 600);
		expect(docs.every(d => d.cell === "medium-opinion")).toBe(true);
		const c = status(docs, "medium-opinion");
		expect([c.status, c.values, c.ranges]).toEqual(["empty", undefined, undefined]);
	});

	test("글 3편 이상이지만 한글 5,000자에 못 미치면 direction이고 값은 보여요", () => {
		const c = status(docsOf("opinion", 10, 500), "medium-opinion");
		expect(c.hangul).toBeLessThan(5000);
		expect([c.status, c.values !== undefined, c.ranges !== undefined]).toEqual(["direction", true, true]);
	});

	test("글 3편 이상, 한글 5,000자 이상, 측정 단위 10개 이상이면 ok이고 범위가 위아래로 있어요", () => {
		const c = status(docsOf("opinion", 12, 600), "medium-opinion");
		expect(c.status).toBe("ok");
		const [lo, hi] = c.ranges?.s_mean ?? [1, 0];
		expect(lo).toBeLessThanOrEqual(hi);
	});

	test("측정 단위가 10개에 못 미치면 글자 수가 충분해도 direction", () => {
		const c = status(docsOf("opinion", 9, 700), "medium-opinion");
		expect(c.hangul).toBeGreaterThanOrEqual(5000);
		expect(c.status).toBe("direction");
	});

	test("short는 글 30편이 있어야 ok", () => {
		const twenty = docsOf("guide", 20, 430);
		const thirty = docsOf("guide", 30, 430);
		expect(thirty.every(d => d.cell === "short-guide")).toBe(true);
		expect(status(twenty, "short-guide").hangul).toBeGreaterThanOrEqual(5000);
		expect(status(twenty, "short-guide").status).toBe("direction");
		expect(status(thirty, "short-guide").status).toBe("ok");
	});

	test("책 한 권(50,000자 이상)이면 글 수 조건이 면제돼 long이 차요", () => {
		expect(status(docsOf("story", 1, 60000), "long-story").status).toBe("ok");
		expect(status(docsOf("story", 1, 20000), "long-story").status).toBe("empty");
	});

	test("메일과 메시지에서 온 글은 긴 글 칸에 섞이지 않아요", () => {
		const messages = docsOf("story", 40, 4000, "messages");
		expect(messages.every(d => d.cell.startsWith("short-"))).toBe(true);
		const long = status(messages, "long-story");
		expect([long.docs, long.status]).toEqual([0, "empty"]);
	});
});
