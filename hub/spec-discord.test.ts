import { describe, expect, test } from "bun:test";
import { buildPayloads } from "./discord-format.ts";
import { elementPlain, type SpecElement, specOfElements } from "./message-spec.ts";
import { plainChoice } from "./tone.ts";
import { renderDiscord } from "./spec-discord.ts";

const spec = (...els: SpecElement[]) => specOfElements(els);
const same = (s: string) => s;
const render = (...els: SpecElement[]) => renderDiscord(spec(...els), same);
const MARKERS = /\[(?:done|run|wait|ask|fail)\]/;

describe("renderDiscord", () => {
	test("facts, a change, schedule, section", () => {
		expect(render({ type: "Facts", props: { rows: [{ key: "상태", value: "정상" }, { key: "버전", from: "1.0", to: "1.1" }] } })).toBe("**상태** 정상\n**버전** ~~1.0~~ → **1.1**");
		expect(render({ type: "Schedule", props: { rows: [{ time: "10:00", text: "회의" }] } })).toBe("**10:00** 회의");
		expect(render({ type: "Section", props: { title: "배포", rows: [{ key: "서버", value: "2대", count: "3" }] } })).toBe("**배포**\n**서버** (3) 2대");
	});
	test("table, rows, sources, evidence, meta, rule", () => {
		expect(render({ type: "Table", props: { head: ["이름", "값"], rows: [["가", "1"], ["나", "2"]] } })).toBe("-# 이름 · 값\n**가** · 1\n**나** · 2");
		expect(render({ type: "Rows", props: { rows: [{ title: "글", sub: "부제", meta: "3분" }] } })).toBe("**글** · 부제 · 3분");
		expect(render({ type: "Sources", props: { items: [{ href: "https://a.example/x", title: "문서" }, { href: "https://b.example" }] } })).toBe("[문서](<https://a.example/x>)\n<https://b.example>");
		expect(render({ type: "Evidence", props: { items: ["로그"] } })).toStartWith("-# ");
		expect(render({ type: "Meta", props: { text: "12초" } })).toBe("-# 12초");
		expect(render({ type: "Text", props: { text: "가" } }, { type: "Rule", props: {} }, { type: "Text", props: { text: "나" } })).toBe("가\n\n\n\n나");
	});
	test("a type without an entry uses its plain form through the text callback; Files is left out", () => {
		const out = renderDiscord(spec({ type: "Heading", props: { text: "제목" } }, { type: "Files", props: { items: [{ path: "/tmp/a" }] } }), s => `<${s}>`);
		expect(out).toBe(`<${elementPlain({ type: "Heading", props: { text: "제목" } })}>`);
	});
	test("a Choice is exactly what plainChoice makes of its plain form", () => {
		const choice: SpecElement = { type: "Choice", props: { question: "어느 쪽?", options: [{ n: 1, label: "A", desc: "빠름" }, { n: 2, label: "B" }] } };
		expect(render(choice)).toBe(plainChoice(elementPlain(choice)));
	});
	test("marks in strings are escaped and mentions, links and markers stay inert", () => {
		const out = render({ type: "Facts", props: { rows: [{ key: "<@123>", value: "<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.example)" }] } });
		expect(out).not.toContain("<@123>");
		expect(out).toContain("<\u200b@123>");
		expect(out).not.toContain("[x](javascript:");
		expect(out).toContain("[ok](<https://a.example>)");
		expect(out).not.toMatch(MARKERS);
	});
});

describe("buildPayloads with a spec", () => {
	const wire = (...els: SpecElement[]) => () => spec(...els);
	test("the tone emoji leads, markers never show, null keeps today's text", () => {
		const [p] = buildPayloads("[done] 끝", undefined, 1900, undefined, wire({ type: "Facts", props: { rows: [{ key: "상태", value: "정상" }] } }));
		expect(p!.content).toBe("✅ **상태** 정상");
		expect(p!.content).not.toMatch(MARKERS);
		expect(buildPayloads("[done] 끝", undefined, 1900, undefined, () => null)).toEqual(buildPayloads("[done] 끝"));
	});
	test("a long Rows splits at row boundaries under the limit", () => {
		const rows = Array.from({ length: 80 }, (_, i) => ({ title: `항목 ${i}`, sub: "설명".repeat(10), meta: "메타" }));
		const out = buildPayloads("긴 목록", undefined, 1900, undefined, wire({ type: "Rows", props: { rows } }));
		const lines = rows.map(r => `**${r.title}** · ${r.sub} · ${r.meta}`);
		expect(out.length).toBeGreaterThan(1);
		for (const p of out) {
			expect(p.content!.length).toBeLessThanOrEqual(1900);
			for (const l of p.content!.split("\n").filter(x => x.startsWith("**") || x.includes("**항목"))) expect(lines.some(x => l.endsWith(x))).toBe(true);
		}
		expect(out.map(p => p.content).join("\n")).toContain(lines.at(-1)!);
	});
});

test("a row keeps the channel link a text line gets, and a mention stays inert", () => {
	const shaped = () => spec({ type: "Facts", props: { rows: [{ key: "방", value: "ch:123456789012345678 <#123456789012345678> <@123>" }] } });
	const out = buildPayloads("글", undefined, undefined, undefined, shaped)[0]!.content;
	expect(out).toContain("<#123456789012345678> <#123456789012345678>");
	expect(out).not.toContain("<@123>");
});
