// A phone browser keeps :hover on the element a finger last touched, so a hover colour stays on after the tap (golden rule V29). Every :hover
// rule in web/css that changes a colour, background, border, shadow or opacity sits inside @media (hover: hover); a rule that a
// (hover: none) or (pointer: coarse) block takes back for the same selector is left alone, and so are those blocks themselves.
import { expect, test } from "bun:test";

type Rule = { sel: string; body: string; media: string[] };

// A small reader for the app's CSS: comments, strings and parentheses are skipped; @media/@supports/@layer/@container blocks are walked
// with their conditions; other at-rules (@keyframes, @font-face) are skipped whole. web/css has no nested style rules.
function rules(src: string): Rule[] {
	const out: Rule[] = [];
	let i = 0;
	const comment = () => { if (!src.startsWith("/*", i)) return false; const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; return true; };
	const until = (stops: string) => {
		const s = i;
		let paren = 0;
		while (i < src.length) {
			if (comment()) continue;
			const c = src[i];
			if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1; i++; continue; }
			if (c === "(") paren++;
			else if (c === ")") paren--;
			else if (paren === 0 && stops.includes(c)) break;
			i++;
		}
		return src.slice(s, i);
	};
	const block = (media: string[]) => {
		for (;;) {
			while (i < src.length && (/\s/.test(src[i]) || comment())) if (/\s/.test(src[i])) i++;
			if (i >= src.length) return;
			if (src[i] === "}") { i++; return; }
			const pre = until("{;}").replace(/\/\*[\s\S]*?\*\//g, "").trim();
			if (src[i] === ";") { i++; continue; }
			if (src[i] === "}") continue;
			i++;
			if (/^@(media|supports|layer|container)\b/.test(pre)) { block([...media, pre]); continue; }
			if (pre.startsWith("@")) { let depth = 1; while (i < src.length && depth) { if (comment()) continue; depth += src[i] === "{" ? 1 : src[i] === "}" ? -1 : 0; i++; } continue; }
			const body = until("{}");
			expect(src[i], `nested rule in ${pre}`).toBe("}");
			i++;
			out.push({ sel: pre, body, media });
		}
	};
	block([]);
	return out;
}

const selectors = (sel: string) => {
	const parts: string[] = [];
	let depth = 0, cur = "";
	for (const c of sel) {
		if (c === "(") depth++;
		if (c === ")") depth--;
		if (c === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += c;
	}
	return [...parts, cur.trim()].filter(Boolean);
};
const LOOK = /(?:^|;)\s*(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|box-shadow|opacity)\s*:/i;
const inHover = (r: Rule) => r.media.some(m => /\(\s*hover\s*:\s*hover\s*\)/.test(m));
const inTouch = (r: Rule) => r.media.some(m => /\(\s*hover\s*:\s*none\s*\)|\(\s*pointer\s*:\s*coarse\s*\)/.test(m));

test("every :hover rule that changes a colour, background, border, shadow or opacity is for a mouse only, so a tap leaves no hover behind", async () => {
	const files = [...new Bun.Glob("*.css").scanSync({ cwd: new URL("../web/css/", import.meta.url).pathname })].sort();
	const stuck: string[] = [];
	let mouseOnly = 0;
	for (const file of files) {
		const all = rules(await Bun.file(new URL(`../web/css/${file}`, import.meta.url)).text());
		const takenBack = new Set(all.filter(inTouch).flatMap(r => selectors(r.sel)));
		for (const r of all) {
			const hover = selectors(r.sel).filter(s => s.includes(":hover"));
			if (!hover.length || !LOOK.test(";" + r.body)) continue;
			if (inHover(r)) { mouseOnly++; continue; }
			if (inTouch(r) || hover.every(s => takenBack.has(s))) continue;
			stuck.push(`${file}: ${hover.join(", ")}`);
		}
	}
	expect(files.length).toBeGreaterThan(30);
	expect(mouseOnly).toBeGreaterThan(0);   // the reader found the hover rules, so an empty read cannot pass
	expect(stuck).toEqual([]);
});
