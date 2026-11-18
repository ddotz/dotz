import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, waitFor } from "./test-web.ts";
import { listBlock } from "./listblock.ts";

// The web side: the 목록 fence becomes a Rows element (hub/message-spec-derive.ts, the page runs the same code) and specRowsHtml of 02-answer-shapes.js draws it,
// here in the real page.
const hub = fakeHub();
afterAll(() => hub.stop());
const view = await hub.view({}, "/");
await waitFor(view, `typeof specRowsHtml === "function" && S`);
const webListHtml = (block: string) => ev<string>(view, `specRowsHtml(specChildren(deriveBasicSpec(${JSON.stringify(block)}))[0].props)`);

test("a 목록 block: title line, one row per item, empty trailing fields and zero badges dropped, separators and fences neutralised", () => {
	expect(listBlock("카톡 대화방", [
		{ title: "가족", sub: "단체", meta: "20:58" },
		{ title: "Alex", sub: "1:1", meta: "21:26", badge: 2 },
		{ title: "a | b```", badge: 0 },
	])).toBe("```목록\n# 카톡 대화방\n가족 | 단체 | 20:58\nAlex | 1:1 | 21:26 | 2\na / b'''\n```");
});

test("the web renders a 목록 block as rows: initial, title, subtitle, meta, and a badge only for a positive count", async () => {
	const html = await webListHtml(listBlock("Rooms", [{ title: "<b>Alex</b>", sub: "1:1", meta: "21:26", badge: 3 }, { title: "🍀 Club", meta: "9/30" }]));
	expect(html.match(/class="mlist-row"/g)).toHaveLength(2);
	expect(html).toContain('<div class="mlist-h">Rooms</div>');
	expect(html).toContain("&lt;b&gt;Alex&lt;/b&gt;");
	expect(html).not.toContain("<b>");
	expect(html.match(/class="mlist-b"/g)).toHaveLength(1);
	expect(html).toContain('<span class="mlist-av" aria-hidden="true">C</span>');
});
