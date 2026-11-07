import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listBlock } from "./listblock.ts";

// The web side: the 목록 fence becomes a Rows element (hub/message-spec-derive.ts, the page runs the same code) and specRowsHtml of 02-answer-shapes.js draws it.
function webListHtml(block: string): string {
	const read = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");
	const shapes = read("02-answer-shapes.js"), fn = shapes.slice(shapes.indexOf("function specRowsHtml"), shapes.indexOf("// A table of a head"));
	const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
	const rows = new Function(`${read("01-message-spec.js")}; return (text) => specChildren(deriveBasicSpec(text))[0].props;`)();
	return new Function("esc", `${fn}\nreturn specRowsHtml;`)(esc)(rows(block));
}

test("a 목록 block: title line, one row per item, empty trailing fields and zero badges dropped, separators and fences neutralised", () => {
	expect(listBlock("카톡 대화방", [
		{ title: "가족", sub: "단체", meta: "20:58" },
		{ title: "Alex", sub: "1:1", meta: "21:26", badge: 2 },
		{ title: "a | b```", badge: 0 },
	])).toBe("```목록\n# 카톡 대화방\n가족 | 단체 | 20:58\nAlex | 1:1 | 21:26 | 2\na / b'''\n```");
});

test("the web renders a 목록 block as rows: initial, title, subtitle, meta, and a badge only for a positive count", () => {
	const html = webListHtml(listBlock("Rooms", [{ title: "<b>Alex</b>", sub: "1:1", meta: "21:26", badge: 3 }, { title: "🍀 Club", meta: "9/30" }]));
	expect(html.match(/class="mlist-row"/g)).toHaveLength(2);
	expect(html).toContain('<div class="mlist-h">Rooms</div>');
	expect(html).toContain("&#60;b&#62;Alex&#60;/b&#62;");
	expect(html).not.toContain("<b>");
	expect(html.match(/class="mlist-b"/g)).toHaveLength(1);
	expect(html).toContain('<span class="mlist-av" aria-hidden="true">C</span>');
	expect(readFileSync(join(import.meta.dir, "..", "web", "js", "02-answer-shapes.js"), "utf8")).toContain("Rows: specRowsHtml");
});
