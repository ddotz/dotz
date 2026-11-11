import { describe, expect, test } from "bun:test";
import { type SpecElement, specOfElements } from "./message-spec.ts";
import { html, telegramParts } from "./spec-telegram.ts";

const spec = (...els: SpecElement[]) => specOfElements(els);
const MARKERS = /\[(?:done|run|wait|ask|fail)\]/;
const text = (t: string): SpecElement => ({ type: "Text", props: { text: t } });

describe("telegramParts", () => {
	test("marks become b, i, s, code, a, pre and blockquote", () => {
		expect(html("**b** *i* ~~s~~ `c` [l](https://a.example/?x=1&y=2)")).toBe('<b>b</b> <i>i</i> <s>s</s> <code>c</code> <a href="https://a.example/?x=1&amp;y=2">l</a>');
		const [p] = telegramParts(spec(text("> 인용\n\n```ts\nconst a = 1 < 2;\n```"), { type: "Code", props: { code: "x" } }));
		expect(p!.html).toContain("<blockquote>인용</blockquote>");
		expect(p!.html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
		expect(p!.html).toContain("<pre>x</pre>");
	});
	test("facts, a change and the rows read as lines", () => {
		const [p] = telegramParts(spec({ type: "Facts", props: { rows: [{ key: "상태", value: "정상" }, { key: "버전", from: "1.0", to: "1.1" }] } }, { type: "Rows", props: { rows: [{ title: "글", sub: "부제" }] } }));
		expect(p!.html).toBe("<b>상태</b>: 정상\n<b>버전</b>: <s>1.0</s> → <b>1.1</b>\n\n<b>글</b> · 부제");
	});
	test("everything is escaped and only http(s) links exist; the emoji leads, no marker shows", () => {
		const parts = telegramParts(spec(text("<script>alert(1)</script> <@123> [x](javascript:alert(1)) & <b>raw</b>")), { emoji: "❌" });
		const out = parts.map(p => p.html).join("");
		expect(out.startsWith("❌ ")).toBe(true);
		expect(out).not.toContain("<script>");
		expect(out).not.toContain("<@123>");
		expect(out).not.toContain("<b>raw");
		expect(out).not.toContain("<a ");
		expect(out).toContain("&lt;script&gt;");
		expect(out + parts.map(p => p.plain).join("")).not.toMatch(MARKERS);
	});
	test("Files is left out and the plain form of every part is kept for the 400 resend", () => {
		const parts = telegramParts(spec(text("안녕"), { type: "Files", props: { items: [{ path: "/tmp/a" }] } }));
		expect(parts).toEqual([{ html: "안녕", plain: "안녕" }]);
	});
	test("parts split at element boundaries under the limit", () => {
		const els = Array.from({ length: 10 }, (_, i) => text(`${i}${"가".repeat(99)}`));
		const parts = telegramParts(spec(...els), { limit: 250 });
		expect(parts.length).toBe(5);
		for (const p of parts) {
			expect(p.html.length).toBeLessThanOrEqual(250);
			expect(p.html.split("\n\n")).toHaveLength(2);
		}
	});
	test("one element past the limit is cut between lines, as escaped plain text", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `줄 ${i} <${"x".repeat(40)}>`);
		const parts = telegramParts(spec(text(lines.join("\n"))), { limit: 300 });
		expect(parts.length).toBeGreaterThan(1);
		for (const p of parts) expect(p.html.length).toBeLessThanOrEqual(300);
		expect(parts.map(p => p.plain).join("\n")).toBe(lines.join("\n"));
	});
});
