import { describe, expect, test } from "bun:test";
import { inlinePlain, inlineTokens } from "./spec-inline.ts";

// The same table is in hub/basic-markdown-strike.test.ts (web) and hub/spec-inline.test.ts; web/js/02-basic-markdown.js and hub/spec-inline.ts keep one rule.
// [input, the text struck through (none when the tildes are a range or an approximation)]
const TILDE_CASES: [string, string[]][] = [
	["10~~20명, 30~~40명", []],
	["A ~~ B, C ~~ D", []],
	["약 3~~5일", []],
	["~~지운 글~~", ["지운 글"]],
	["앞 ~~지운 글~~ 뒤", ["지운 글"]],
	["(~~지운 글~~)", ["지운 글"]],
	["`~~지운 글~~`", []],
	["약 3~~5일, ~~지운 글~~ 끝", ["지운 글"]],
];

describe("inlineTokens", () => {
	test("reads each mark", () => {
		expect(inlineTokens("a **b** *i* ~~s~~ `c` z")).toEqual([
			{ t: "text", text: "a " },
			{ t: "b", text: "b" },
			{ t: "text", text: " " },
			{ t: "i", text: "i" },
			{ t: "text", text: " " },
			{ t: "s", text: "s" },
			{ t: "text", text: " " },
			{ t: "code", text: "c" },
			{ t: "text", text: " z" },
		]);
	});
	test("a link needs http(s); a bare url loses the closing punctuation", () => {
		expect(inlineTokens("[문서](https://a.example/x?y=1)")).toEqual([{ t: "link", text: "문서", href: "https://a.example/x?y=1" }]);
		expect(inlineTokens("see https://a.example/p.")).toEqual([{ t: "text", text: "see " }, { t: "link", text: "https://a.example/p", href: "https://a.example/p" }, { t: "text", text: "." }]);
		for (const bad of ["[x](javascript:alert(1))", "[x](file:///etc/passwd)", "[x](data:text/html,a)", "[x](ftp://a.example)"]) {
			expect(inlineTokens(bad).some(k => k.t === "link")).toBe(false);
		}
	});
	test("code keeps its marks literal and a lone star is text", () => {
		expect(inlineTokens("`**x**`")).toEqual([{ t: "code", text: "**x**" }]);
		expect(inlineTokens("2 * 3 * 4")).toEqual([{ t: "text", text: "2 * 3 * 4" }]);
	});
	test("inlinePlain drops marks and shows a link as label and url", () => {
		expect(inlinePlain("**a** [b](https://c.example) ~~d~~")).toBe("a b https://c.example d");
		expect(inlinePlain("https://c.example")).toBe("https://c.example");
	});
	test("two tildes are a strike only for a deliberate pair", () => {
		for (const [input, struck] of TILDE_CASES) {
			expect({ input, struck: inlineTokens(input).filter(k => k.t === "s").map(k => k.text) }).toEqual({ input, struck });
		}
	});
	test("a range keeps its tildes as text", () => {
		expect(inlinePlain("10~~20명, 30~~40명")).toBe("10~~20명, 30~~40명");
		expect(inlinePlain("약 3~~5일, ~~지운 글~~ 끝")).toBe("약 3~~5일, 지운 글 끝");
	});
});
