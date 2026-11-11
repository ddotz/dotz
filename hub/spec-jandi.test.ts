import { describe, expect, test } from "bun:test";
import { type SpecElement, specOfElements } from "./message-spec.ts";
import { renderJandi } from "./spec-jandi.ts";
import { plainChoice } from "./tone.ts";
import { elementPlain } from "./message-spec.ts";

const spec = (...els: SpecElement[]) => specOfElements(els);
const MARKERS = /\[(?:done|run|wait|ask|fail)\]/;

describe("renderJandi", () => {
	test("each component is a few plain lines", () => {
		const out = renderJandi(
			spec(
				{ type: "Facts", props: { head: "요약", rows: [{ key: "상태", value: "**정상**" }, { key: "버전", from: "1.0", to: "1.1" }] } },
				{ type: "Table", props: { head: ["이름", "값"], rows: [["가", "1"]] } },
				{ type: "Sources", props: { items: [{ href: "https://a.example/x", title: "문서" }] } },
				{ type: "Meta", props: { text: "12초" } },
				{ type: "Rule", props: {} },
				{ type: "Schedule", props: { rows: [{ time: "10:00", text: "회의" }] } },
			),
		);
		expect(out).toBe("요약\n상태: 정상\n버전: 1.0 → 1.1\n\n이름 · 값\n가 · 1\n\n문서: https://a.example/x\n\n12초\n\n\n\n10:00 회의");
	});
	test("a Choice keeps the plainChoice form and Files is left out", () => {
		const choice: SpecElement = { type: "Choice", props: { question: "어느 쪽?", options: [{ n: 1, label: "A" }, { n: 2, label: "B" }] } };
		expect(renderJandi(spec(choice, { type: "Files", props: { items: [{ path: "/tmp/a" }] } }))).toBe(plainChoice(elementPlain(choice)));
	});
	test("markup and mentions stay literal text and no status marker shows", () => {
		const out = renderJandi(spec({ type: "Facts", props: { rows: [{ key: "<@123>", value: "<script>x</script> [y](javascript:alert(1))" }] } }));
		expect(out).toContain("<script>x</script>");
		expect(out).not.toMatch(MARKERS);
		expect(out).not.toContain("https://");
	});
});
