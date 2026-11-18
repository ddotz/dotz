import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, waitFor } from "./test-web.ts";

// Two tildes are drawn as strikethrough only for a deliberate pair (web/js/02-basic-markdown.js inline()); a range or an approximation keeps them.
// The real page is loaded and inline() is called on it.
const hub = fakeHub();
afterAll(() => hub.stop());
const view = await hub.view({}, "/");
await waitFor(view, `typeof inline === "function" && S`);
const inline = (s: string) => ev<string>(view, `inline(${JSON.stringify(s)})`);

// The same table is in hub/spec-inline.test.ts; web/js/02-basic-markdown.js and hub/spec-inline.ts keep one rule.
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

test("two tildes are a strike only for a deliberate pair", async () => {
	for (const [input, struck] of TILDE_CASES) {
		const html = await inline(input);
		expect({ input, struck: [...html.matchAll(/<s>(.*?)<\/s>/g)].map(m => m[1]) }).toEqual({ input, struck });
	}
});

test("a pair inside bold, italics and quotes still strikes", async () => {
	expect(await inline("**~~지운 글~~**")).toContain("<s>지운 글</s>");
	expect(await inline("*~~지운 글~~*")).toContain("<s>지운 글</s>");
	expect(await inline('"~~지운 글~~"')).toContain("<s>지운 글</s>");
	expect(await inline("~~지운 글~~, 남은 글")).toContain("<s>지운 글</s>");
});
