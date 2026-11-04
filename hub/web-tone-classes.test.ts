import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "./webapp.ts";

// The web app marks state with short tone classes added next to a component class ("card tap att", "dot err", "grow att err").
// A stylesheet rule keyed on a tone class alone styles every component that carries the tone: the file-attachment chip once used
// `.att`, so a home card with a warning ("사용량" at 1% left) became a 220px flex row and its rows were squeezed off the card.
const TONES = ["att", "warn", "err", "ok", "pri", "off"];

// Commas and combinators split a selector only outside brackets: in `.dot:is(.un, .err)` the tone stays scoped to `.dot`.
function compoundsOf(css: string): string[] {
	const out: string[] = [];
	const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const m of body.matchAll(/([^{}@;]+)\{/g)) {
		let depth = 0, part = "";
		for (const ch of `${m[1]},`) {
			if (ch === "(") depth++;
			if (ch === ")") depth--;
			if (depth > 0 || !/[,\s>+~]/.test(ch)) part += ch;
			else {
				if (part) out.push(part);
				part = "";
			}
		}
	}
	return out;
}

describe("web stylesheet tone classes", () => {
	const html = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");
	// web/css/*.css (served as /app.css) plus any <style> left in the page
	const css = [bundle("css").text, ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1])].join("\n");
	const compounds = compoundsOf(css);

	test("the stylesheet was found", () => {
		expect(compounds.length).toBeGreaterThan(100);
	});

	test("no rule styles a tone class on its own", () => {
		const bare = compounds.filter(c => {
			// A leading :is() / :where() has no component in front of it, so each of its entries stands alone.
			const list = c.match(/^:(?:is|where)\(([^()]*)\)/)?.[1].split(",").map(s => s.trim()) ?? [];
			const head = c.replace(/::?[\w-]+(\([^)]*\))?/g, "");
			return TONES.some(t => head === `.${t}` || list.includes(`.${t}`));
		});
		expect(bare).toEqual([]);
	});

	test("the attachment chip has its own class", () => {
		expect(compounds).toContain(".fatt");
		expect(bundle("js").text).toContain("class: `fatt${");
	});
});
