import { describe, expect, test } from "bun:test";
import { inlinePlain, inlineTokens } from "./spec-inline.ts";

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
});
