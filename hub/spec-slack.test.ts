import { describe, expect, test } from "bun:test";
import { type SpecElement, specOfElements } from "./message-spec.ts";
import { mrkdwn, SLACK_LIMITS, slackBlocks } from "./spec-slack.ts";

const spec = (...els: SpecElement[]) => specOfElements(els);
const MARKERS = /\[(?:done|run|wait|ask|fail)\]/;
const facts = (n: number): SpecElement => ({ type: "Facts", props: { rows: Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: `v${i}` })) } });

describe("slackBlocks", () => {
	test("facts are section fields, evidence and meta are context, a rule is a divider, code is a fenced section", () => {
		const blocks = slackBlocks(spec(facts(2), { type: "Evidence", props: { items: ["로그"] } }, { type: "Meta", props: { text: "3초" } }, { type: "Rule", props: {} }, { type: "Code", props: { code: "a < b" } }))!;
		expect(blocks.map(b => b.type)).toEqual(["section", "context", "context", "divider", "section"]);
		expect((blocks[0] as any).fields).toEqual([{ type: "mrkdwn", text: "*k0*\nv0" }, { type: "mrkdwn", text: "*k1*\nv1" }]);
		expect((blocks[4] as any).text.text).toBe("```\na &lt; b\n```");
	});
	test("rows and schedule are mrkdwn sections, links are <url|label>", () => {
		const blocks = slackBlocks(spec({ type: "Rows", props: { rows: [{ title: "글", sub: "[문서](https://a.example/x?a=1&b=2)" }] } }, { type: "Schedule", props: { rows: [{ time: "10:00", text: "회의" }] } }))!;
		expect((blocks[0] as any).text.text).toBe("*글* · <https://a.example/x?a=1&amp;b=2|문서>");
		expect((blocks[1] as any).text.text).toBe("*10:00* 회의");
	});
	test("the tone emoji leads the first section and the web link closes", () => {
		const blocks = slackBlocks(spec({ type: "Text", props: { text: "안녕" } }), { emoji: "✅", link: "<https://w.example/a|웹에서 보기>" })!;
		expect((blocks[0] as any).text.text).toBe("✅ 안녕");
		expect(blocks.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "<https://w.example/a|웹에서 보기>" }] });
	});
	test("& < > are escaped, so a mention or tag stays text, and nothing shows a status marker", () => {
		const out = JSON.stringify(slackBlocks(spec({ type: "Text", props: { text: "<@U123> <!channel> <script>x</script> [x](javascript:alert(1))" } }), { emoji: "❌" }));
		expect(out).not.toContain("<@U123>");
		expect(out).not.toContain("<!channel>");
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;@U123&gt;");
		expect(out).not.toContain("|x>");
		expect(out).not.toMatch(MARKERS);
		expect(mrkdwn("[a](https://x.example)")).toBe("<https://x.example|a>");
	});
	test("past 10 fields Facts degrades to text in sections", () => {
		const blocks = slackBlocks(spec(facts(11)))!;
		expect(blocks).toHaveLength(1);
		expect((blocks[0] as any).fields).toBeUndefined();
		expect((blocks[0] as any).text.text.split("\n")).toHaveLength(11);
	});
	test("a long text splits into sections of at most 3000 characters", () => {
		const line = "가".repeat(100);
		const blocks = slackBlocks(spec({ type: "Text", props: { text: Array.from({ length: 80 }, () => line).join("\n") } }))!;
		expect(blocks.length).toBeGreaterThan(2);
		for (const b of blocks) expect((b as any).text.text.length).toBeLessThanOrEqual(SLACK_LIMITS.text);
	});
	test("past 50 blocks there are no blocks", () => {
		const rules = Array.from({ length: 60 }, (): SpecElement => ({ type: "Rule", props: {} }));
		expect(slackBlocks(spec(...rules))).toBeUndefined();
		const texts = Array.from({ length: 60 }, (_, i): SpecElement => ({ type: "Facts", props: { rows: [{ key: `k${i}`, value: "v" }, ...Array.from({ length: 10 }, (_, j) => ({ key: `x${j}`, value: "y" }))] } }));
		expect(slackBlocks(spec(...texts))!.length).toBeLessThanOrEqual(SLACK_LIMITS.blocks);
	});
});
