import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Two tildes are drawn as strikethrough only for a deliberate pair (web/js/02-basic-markdown.js inline()); a range or an approximation keeps them.
// inline() is cut out of the file and run with the few globals it reads, so no browser is needed.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "02-basic-markdown.js"), "utf8");
const body = src.slice(src.indexOf("function inline(s) {"), src.indexOf("\n}\n", src.indexOf("function inline(s) {")) + 2);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const inline = new Function("esc", "dropIdNote", "targetName", `${body}\nreturn inline;`)(esc, (s: string) => s, (s: string) => s) as (s: string) => string;

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

test("inline() was cut out whole", () => {
	expect(body.startsWith("function inline(s) {")).toBe(true);
	expect(inline("**b**")).toBe("<b>b</b>");
});

test("two tildes are a strike only for a deliberate pair", () => {
	for (const [input, struck] of TILDE_CASES) {
		const html = inline(input);
		expect({ input, struck: [...html.matchAll(/<s>(.*?)<\/s>/g)].map(m => m[1]) }).toEqual({ input, struck });
	}
});

test("a pair inside bold, italics and quotes still strikes", () => {
	expect(inline("**~~지운 글~~**")).toContain("<s>지운 글</s>");
	expect(inline("*~~지운 글~~*")).toContain("<s>지운 글</s>");
	expect(inline('"~~지운 글~~"')).toContain("<s>지운 글</s>");
	expect(inline("~~지운 글~~, 남은 글")).toContain("<s>지운 글</s>");
});
