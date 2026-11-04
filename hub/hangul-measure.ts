// Measures Korean line breaks on the rendered page: lines are rebuilt from real glyph positions, never guessed from CSS (docs/ui-principles.md rule 11).
//   bun hub/hangul-measure.ts <url|file> [widths] [--scope selector] [--text 150,200] [--json]
// Reports split words, overflow (box or page) and orphans (report only); with --text, also button text clipped and buttons not tappable.
// Exit code: 0 clean, 1 problems, 2 could not run. Headless Bun.WebView, the same harness as hub/test-web.ts.
// Measuring idea ported from wrapcheck.mjs, github.com/hanmariyang/giting-skills (plugin hangul-wrap), MIT; see THIRD_PARTY_NOTICES.md.
import { existsSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";

// Rule 11: the chat window keeps ordinary line breaks and code may break anywhere, so split and orphan do not count there. Overflow still does.
const LOOSE = "#tl, pre, code, kbd, samp";
const RUN_LIMIT_MS = 30_000;

// These three run inside the page (Function.toString), so they use no outer names.
const settle = () => new Promise(done => {
	let quiet: ReturnType<typeof setTimeout>;
	const finish = () => { mo.disconnect(); requestAnimationFrame(() => requestAnimationFrame(done)); };
	const kick = () => { clearTimeout(quiet); quiet = setTimeout(finish, 250); };
	const mo = new MutationObserver(kick);
	mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
	setTimeout(finish, 3000);
	kick();
}).then(() => document.fonts.ready).then(() => 1);

// Text only, like a phone font-size setting: every font size (and px line height) grows, the layout width stays.
function scaleText(f: number) {
	const els = [document.body, ...document.body.querySelectorAll<HTMLElement>("*")];
	const was = els.map(e => { const cs = getComputedStyle(e); return [e, parseFloat(cs.fontSize), cs.lineHeight] as const; });
	for (const [e, fs, lh] of was) {
		if (fs) e.style.setProperty("font-size", `${fs * f}px`, "important");
		if (lh.endsWith("px")) e.style.setProperty("line-height", `${parseFloat(lh) * f}px`, "important");
	}
}

function measure(scopeSel: string, loose: string, tapsToo: boolean) {
	const WORD = /[\uAC00-\uD7A3\u3131-\u318E0-9A-Za-z]/, HANGUL = /[\uAC00-\uD7A3]/, SPACE = /[\s\u200B\u00A0]/;
	const scope = document.querySelector(scopeSel);
	if (!scope) throw new Error(`no element matches ${scopeSel}`);
	const name = (el: Element) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "");
	// A .wph phrase box (web/js/01-phrase-wrap.js) is an inline-block, but its lines belong to the box around it.
	const flows = (el: Element) => { const d = getComputedStyle(el).display; return el.classList.contains("wph") || d === "inline" || d === "contents"; };
	const blockOf = (n: Node) => { let el = n.parentElement; while (el && el !== scope && flows(el)) el = el.parentElement; return el; };
	// WebKit still gives boxes to what a closed <details> folds away, so only its summary counts as shown.
	const folded = (el: Element) => { const d = el.closest("details:not([open])"); return !!d && !d.querySelector(":scope > summary")?.contains(el); };
	const shown = (el: Element) => { const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && el.getClientRects().length > 0 && !folded(el); };
	// A box that ends its text on purpose: an ellipsis, or the end fade of a list title (web/css/25-list-title.css).
	const endsCut = (el: Element) => { const s = getComputedStyle(el); return s.textOverflow === "ellipsis" || s.maskImage !== "none"; };
	// overflow-y: auto also computes overflow-x to auto, so a box that scrolls vertically is not a horizontal scroller.
	const inScroller = (el: Element) => { for (let x: Element | null = el; x && x !== document.documentElement; x = x.parentElement) { const o = getComputedStyle(x).overflowX; if ((o === "auto" || o === "scroll") && x.scrollHeight <= x.clientHeight + 1) return true; } return false; };

	const blocks = new Map<Element, Text[]>();
	const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
	for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
		const p = n.parentElement;
		if (!n.data.trim() || !p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|OPTION)$/.test(p.tagName)) continue;
		const b = blockOf(n);
		if (!b || !shown(b)) continue;
		blocks.set(b, [...(blocks.get(b) ?? []), n]);
	}

	type Glyph = { ch: string; top: number | null; right: number; h: number; line?: number };
	const found: { kind: string; el: string; word?: string; px?: number; by?: string; page?: boolean; lines: string[] }[] = [];
	let measured = 0;
	for (const [el, nodes] of blocks) {
		// Glyphs in order. Whatever sits between two text nodes without being part of this block (a tag, a line break, an image) counts as a space.
		const seq: Glyph[] = [];
		const gap = (): void => { seq.push({ ch: " ", top: null, right: 0, h: 0 }); };
		nodes.forEach((node, k) => {
			if (k) {
				const r = document.createRange(); r.setStartAfter(nodes[k - 1]!); r.setEndBefore(node);
				const between = r.cloneContents();
				if (between.textContent || between.querySelector("br,img,svg,input")) gap();
			}
			for (let i = 0; i < node.data.length; i++) {
				if (SPACE.test(node.data[i]!)) { gap(); continue; }
				const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
				const box = r.getClientRects()[0];
				seq.push({ ch: node.data[i]!, top: box && box.width > 0 ? box.top : null, right: box?.right ?? 0, h: box?.height ?? 0 });
			}
		});
		if (!seq.some(c => c.top !== null && HANGUL.test(c.ch))) continue;
		measured++;

		let line = 0, lastTop: number | null = null;
		for (const c of seq) {
			if (c.top === null) continue;
			if (lastTop !== null && Math.abs(c.top - lastTop) > Math.max(4, c.h * 0.5)) line++;
			c.line = line; lastTop = c.top;
		}
		const lines: string[] = [];
		for (const c of seq) { if (c.line === undefined) { if (lines.length) lines[lines.length - 1] += " "; } else lines[c.line] = (lines[c.line] ?? "") + c.ch; }
		const text = lines.map(l => (l ?? "").replace(/\s+/g, " ").trim());
		const add = (o: { kind: string; word?: string; px?: number }) => found.push({ ...o, el: name(el), lines: text.slice(0, 4) });

		if (!el.closest(loose)) {
			// Split: neighbouring glyphs on different lines with no space between them.
			let a: Glyph | null = null, spaced = false;
			seq.forEach((c, i) => {
				if (c.ch === " ") spaced = true;
				if (c.line === undefined) return;
				if (a && !spaced && a.line !== c.line && WORD.test(a.ch) && WORD.test(c.ch) && (HANGUL.test(a.ch) || HANGUL.test(c.ch))) {
					let s = i - 1, e = i;
					while (s > 0 && seq[s - 1]!.ch !== " ") s--;
					while (e < seq.length - 1 && seq[e + 1]!.ch !== " ") e++;
					add({ kind: "split", word: `${seq.slice(s, i).map(x => x.ch).join("")}/${seq.slice(i, e + 1).map(x => x.ch).join("")}` });
				}
				a = c; spaced = false;
			});
			const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize) || 16, width = el.getBoundingClientRect().width;
			const narrow = width / fs < (/^(TD|TH)$/.test(el.tagName) ? 14 : 8);
			const last = (text[text.length - 1] ?? "").replace(/\s/g, "");
			if (text.length >= 2 && !narrow && last.length <= 2 && HANGUL.test(last)) add({ kind: "orphan", word: last });
		}
		// Measured on the glyphs, not scrollWidth: an icon hung outside the box (the chat's hidden quote button) is not text overflow.
		const over = Math.round(Math.max(...seq.map(c => c.right)) - el.getBoundingClientRect().right);
		if (el.clientWidth > 0 && over > 1 && !endsCut(el) && !inScroller(el)) add({ kind: "overflow", px: over });
	}
	const pageOver = document.documentElement.scrollWidth - window.innerWidth;
	if (pageOver > 1) found.push({ kind: "overflow", el: "html", px: pageOver, page: true, lines: [] });

	if (tapsToo) for (const el of scope.querySelectorAll<HTMLElement>("button,a[href],[role=button],input[type=submit],input[type=button],summary")) {
		if (!shown(el)) continue;
		const label = (el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
		if (!label) continue;
		const lines = [label.slice(0, 40)], box = el.getBoundingClientRect();
		// How far the button's own text reaches past its box; the line box may be taller than the button while the glyphs still fit.
		let over = 0;
		const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let n = texts.nextNode() as Text | null; n; n = texts.nextNode() as Text | null) {
			if (!n.data.trim() || endsCut(n.parentElement!)) continue;
			const r = document.createRange(); r.selectNodeContents(n);
			for (const q of r.getClientRects()) over = Math.max(over, Math.round(Math.max(q.right - box.right, box.left - q.left, q.bottom - box.bottom, box.top - q.top)));
		}
		if (el.clientWidth > 0 && over > 1) {
			const dup = found.findIndex(f => f.kind === "overflow" && f.el === name(el));   // the same box is one finding, the button one
			if (dup >= 0) found.splice(dup, 1);
			found.push({ kind: "clip", el: name(el), px: over, lines });
		}
		el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
		const r = el.getBoundingClientRect();
		// A link wrapped on two lines has an empty centre, so each line piece is tried and one hit is enough.
		const pieces = [...el.getClientRects()].filter(q => q.width > 0 && q.height > 0);
		const hits = pieces.map(q => document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2));
		if (r.width > 0 && r.height > 0 && !hits.some(h => h && (h === el || el.contains(h)))) found.push({ kind: "blocked", el: name(el), by: hits[0] ? name(hits[0]) : "off screen", lines });
	}
	return { measured, found };
}

type Measured = ReturnType<typeof measure>;
export type Run = { width: number; text: number };

// One width and text size each, on a fresh load, so an enlarged run starts from the page's own sizes.
export async function measureRuns(view: InstanceType<typeof Bun.WebView>, target: string, runs: Run[], scope = "body") {
	const report: (Run & Measured)[] = [];
	for (const { width, text } of runs) {
		await view.resize(width, 900);
		await view.navigate("about:blank");
		await view.navigate(target);
		await view.evaluate(`(${settle})()`);
		if (text > 100) { await view.evaluate(`(${scaleText})(${text / 100}), 0`); await view.evaluate(`(${settle})()`); }
		const page = JSON.parse(await view.evaluate(`JSON.stringify((${measure})(${JSON.stringify(scope)}, ${JSON.stringify(LOOSE)}, ${text > 100}))`) as string) as Measured;
		if (!page.measured) throw new Error(`no Korean text to measure at ${width}px in ${scope}`);
		report.push({ width, text, ...page });
	}
	const summary: Record<string, number> = { split: 0, overflow: 0, clip: 0, blocked: 0, orphan: 0 };
	for (const r of report) for (const f of r.found) summary[f.kind]!++;
	return { summary, report };
}

const fail = (why: string): never => { console.error(why); process.exit(2); };
const numbers = (s: string | undefined) => (s ?? "").split(",").filter(Boolean).map(Number);

if (import.meta.main) {
	const options = { scope: { type: "string", default: "body" }, text: { type: "string" }, json: { type: "boolean", default: false } } as const;
	const { values, positionals: [input, widthArg = "390,768,1280"] } = (() => {
		try { return parseArgs({ allowPositionals: true, options }); } catch (e) { return fail(String(e)); }
	})();
	if (!input) fail("usage: bun hub/hangul-measure.ts <url|file> [widths] [--scope selector] [--text 150,200] [--json]");
	const widths = numbers(widthArg), texts = numbers(values.text);
	if (![...widths, ...texts].every(n => n > 0)) fail(`bad widths or --text: ${widthArg} ${values.text ?? ""}`);

	const target = /^(https?|file):/.test(input!) ? input! : existsSync(input!) ? Bun.pathToFileURL(realpathSync(input!)).href : fail(`no such file: ${input}`);
	if (/^http/.test(target)) {
		const res = await fetch(target).catch(e => fail(`cannot open ${target}: ${e}`));
		if (!res.ok) fail(`cannot open ${target}: HTTP ${res.status}`);
	}

	const runs = widths.flatMap(width => [100, ...texts].map(text => ({ width, text })));
	setTimeout(() => fail(`no result within ${RUN_LIMIT_MS * runs.length} ms`), RUN_LIMIT_MS * runs.length);
	const { summary, report } = await (async () => {
		try { return await measureRuns(new Bun.WebView({ width: widths[0], height: 900 }), target, runs, values.scope); }
		catch (e) { return fail(`could not measure ${target}: ${e}`); }
	})();
	if (values.json) console.log(JSON.stringify({ target, summary, report }, null, 1));
	else {
		for (const r of report) {
			console.log(`\n${r.width}px${r.text > 100 ? ` text ${r.text}%` : ""}: ${r.measured} blocks, ${r.found.length} found`);
			for (const f of r.found) console.log(`  ${f.kind}${f.px ? ` ${f.px}px` : ""}${f.page ? " (page)" : ""}${f.word ? ` ${f.word}` : ""}${f.by ? ` under ${f.by}` : ""}  ${f.el}  ${f.lines[0] ?? ""}`);
		}
		console.log(`\n${Object.entries(summary).map(([k, n]) => `${k} ${n}`).join(", ")}`);
	}
	process.exit(summary.split! + summary.overflow! + summary.clip! + summary.blocked! ? 1 : 0);
}
