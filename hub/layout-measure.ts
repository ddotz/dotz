// Measures the spacing and alignment of the rendered web app: boxes whose text sits too close to their edge, a field and a button of
// different height in one row, an inner rounded box that is not concentric with its outer one, left edges that almost line up, an icon
// that is off the text's centre, and rows of one kind with different heights. Everything is read from the laid-out page (Range client
// rects and computed style), never guessed from CSS.
//   bun hub/layout-measure.ts [--screens a,b] [--widths 390,1280] [--json] [--out file] [--write-baseline]
// Data: the real page from hub/webapp.ts (current web/ CSS and JS) in a local Bun.serve, with site/demo/fixtures.js and
// site/demo/demo-api.js injected the way site/build-demo.ts wires them into site/demo/index.html, so every /api call and the event
// stream are answered by the demo. Nothing is built into site/demo, nothing is written anywhere but --out and the baseline.
// Output per check: the histogram of every measured value and the worst 15 with selector path and element name.
// Baseline: hub/layout-baseline.json holds the accepted item keys (check|screen|width|el); a run fails on a bad item whose key is not in
// it and on a key in it that no longer shows up (the list only shrinks). --write-baseline rewrites it from the run.
// Exit code: 0 clean, 1 problems, 2 could not run. Headless Bun.WebView with its default backend, the harness of hub/test-web.ts.
//
// The full screens run is a bun test (hub/layout-measure.test.ts) because it takes about 7 s.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { appAsset, indexPage } from "./webapp.ts";

/* ------------------------------------------------------------------ thresholds ------------------------------------------------------------------ */
// The one place the numbers live; the owner finalizes them from the distributions this tool prints.
export const THRESH = {
	crampedSide: 8,        // text closer than this to the left/right edge of its filled box
	crampedVert: 4,        // ... to the top/bottom edge
	crampedEdge: 8,        // running text closer than this to the viewport edge (phone widths only)
	crampedMinW: 100,      // only boxes larger than this are looked at
	crampedMinH: 30,
	phoneMax: 480,         // viewport widths up to this count as a phone
	fieldHeight: 0.5,      // a field and a button in one row may differ by this much (px)
	fieldGap: 16,          // ... and count as neighbours when no further apart than this
	radius: 2,             // inner radius vs max(outer radius - inset, 0)
	inset: 12,             // an inner box this close to a side of its outer box "touches" that side
	iconCenter: 1,         // icon centre vs text line centre
	rowHeight: 1,          // single-line sibling rows: max minus min height
	tangentMin: 1,         // two left start lines this far apart (px) are near-tangent ...
	tangentMax: 3,         // ... up to this far
	leftLines: 4,          // more row-start lines holding 2+ items than this in one container is bad; 4 is the maximum of the measured distribution (harness@390), so drift above today is caught
};
export type Thresh = typeof THRESH;

export const CHECKS = ["cramped", "field-height", "concentric", "left-edges", "left-edges-tangent", "icon-center", "row-height"] as const;
export type Check = (typeof CHECKS)[number];
// check: left-edges has one item per container (value = start lines holding 2+ items), left-edges-tangent one item per near-tangent pair (value = px apart).
export type Item = { check: Check; screen: string; width: number; el: string; value: number; detail: string; path: string; bad: boolean };
export type Ctx = { screen: string; width: number; scope: string };

/* ------------------------------------------------------------------ page-side code ------------------------------------------------------------------ */
// Everything between here and "harness" runs inside the page (Function.toString), so it uses no outer names. helpers() builds the
// shared tools once per page; each measure takes (cfg, ctx, H) and returns Item[] (without screen/width, which the runner stamps on).
/* eslint-disable @typescript-eslint/no-explicit-any */
function helpers(): any {
	const csCache = new Map<Element, CSSStyleDeclaration>();
	const cs = (el: Element) => { let c = csCache.get(el); if (!c) { c = getComputedStyle(el); csCache.set(el, c); } return c; };
	const px = (v: string) => parseFloat(v) || 0;
	// "rgba(0, 0, 0, 0)", "rgb(1 2 3 / 0.5)", "color(srgb 1 1 1 / 0)", "transparent": the alpha of a computed colour.
	const alpha = (c: string) => {
		if (!c || c === "transparent") return 0;
		const slash = /\/\s*([\d.]+)(%?)/.exec(c);
		if (slash) return parseFloat(slash[1]!) / (slash[2] ? 100 : 1);
		const m = /^rgba\(([^)]*)\)/.exec(c);
		if (m) { const p = m[1]!.split(",").map(s => s.trim()); return p.length > 3 ? parseFloat(p[3]!) : 1; }
		return 1;
	};
	const filled = (c: CSSStyleDeclaration) => alpha(c.backgroundColor) > 0.02 || (c.backgroundImage !== "none" && c.backgroundImage !== "");
	const side = (c: CSSStyleDeclaration, s: "Top" | "Right" | "Bottom" | "Left") => px((c as any)[`border${s}Width`]) > 0 && (c as any)[`border${s}Style`] !== "none" && alpha((c as any)[`border${s}Color`]) > 0.02;
	// A border makes a box when it is on a left or right side (a callout's accent) or on top and bottom both; a lone top or bottom line is a separator.
	const bordered = (c: CSSStyleDeclaration) => side(c, "Left") || side(c, "Right") || (side(c, "Top") && side(c, "Bottom"));
	const painted = (c: CSSStyleDeclaration) => filled(c) || bordered(c);
	// One corner radius in px, capped at half the shorter side (a 999px pill is half its height); the horizontal radius of "12px 8px" and % of the width.
	const corner = (el: Element, c: CSSStyleDeclaration, r: DOMRect, which: string) => {
		const first = String((c as any)[`border${which}Radius`] || "0").split(" ")[0]!;
		const v = first.endsWith("%") ? parseFloat(first) * r.width / 100 : px(first);
		return Math.min(v, Math.min(r.width, r.height) / 2);
	};
	const classes = (el: Element) => (typeof (el as any).className === "string" ? (el as any).className.trim().split(/\s+/).filter(Boolean) : []) as string[];
	const name = (el: Element) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + classes(el).slice(0, 2).map(c => `.${c}`).join("");
	// The key part of an element: its own name and two ancestors, no index and no text, so it does not move with data or pixels.
	const key = (el: Element) => { const out: string[] = []; for (let x: Element | null = el; x && out.length < 3 && x !== document.body; x = x.parentElement) out.push(name(x)); return out.join(" < "); };
	const path = (el: Element) => { const out: string[] = []; for (let x: Element | null = el; x && x !== document.body && out.length < 6; x = x.parentElement) { const sib = x.parentElement ? [...x.parentElement.children].filter(c => c.tagName === x!.tagName) : []; out.unshift(name(x) + (sib.length > 1 ? `:nth-of-type(${sib.indexOf(x) + 1})` : "")); if (x.id) break; } return out.join(" > "); };
	// WebKit still gives boxes to what a closed <details> folds away, so only its summary counts as shown.
	const folded = (el: Element) => { const d = el.closest("details:not([open])"); return !!d && !d.querySelector(":scope > summary")?.contains(el); };
	const faded = (el: Element) => { for (let x: Element | null = el; x && x !== document.documentElement; x = x.parentElement) if (cs(x).opacity === "0") return true; return false; };
	const shown = (el: Element) => { const c = cs(el); return c.visibility !== "hidden" && c.display !== "none" && el.getClientRects().length > 0 && !folded(el) && !faded(el); };
	// A box that scrolls or clips sideways: what lies past its edge is not "too close", it is cut or reachable by scrolling.
	const scrolls = (c: CSSStyleDeclaration) => /auto|scroll|hidden|clip/.test(c.overflowX);
	const scroller = (el: Element) => { const c = cs(el); return /auto|scroll/.test(c.overflowX) && el.scrollWidth > el.clientWidth + 1; };
	const inScroller = (el: Element | null, stop?: Element) => { for (let x = el; x && x !== stop && x !== document.documentElement; x = x.parentElement) if (scroller(x)) return true; return false; };
	const roots = (scope: string) => [...document.querySelectorAll(scope)].filter(shown);
	const all = (scope: string) => roots(scope).flatMap(r => [r, ...r.querySelectorAll("*")]).filter((e, i, a) => a.indexOf(e) === i && shown(e) && !/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD)$/.test(e.tagName));
	const textNodes = (root: Element) => {
		const out: Text[] = [];
		const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
			const p = n.parentElement;
			if (!n.data.trim() || !p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|OPTION)$/.test(p.tagName) || !shown(p)) continue;
			out.push(n);
		}
		return out;
	};
	// The line boxes of a text node (Range client rects). Their height is the font's content area (ascent + descent), not the line-height box.
	// Cut sideways at every ancestor that clips or scrolls, so an ellipsized or scrolled-away tail does not count as text that is there.
	const lines = (n: Node): DOMRect[] => {
		const r = document.createRange();
		r.selectNodeContents(n);
		const clips: DOMRect[] = [];
		for (let x = n.parentElement; x && x !== document.documentElement; x = x.parentElement) if (/hidden|clip|auto|scroll/.test(cs(x).overflowX)) clips.push(x.getBoundingClientRect());
		const out: DOMRect[] = [];
		for (const q of r.getClientRects()) {
			let l = q.left, rt = q.right;
			for (const c of clips) { l = Math.max(l, c.left); rt = Math.min(rt, c.right); }
			if (rt - l > 0 && q.height > 0) out.push(new DOMRect(l, q.top, rt - l, q.height));
		}
		return out;
	};
	// Distinct text lines of a set of rects (rects whose vertical centres fall within half a line of each other are one line).
	const lineCount = (rs: DOMRect[]) => { const cys = rs.map(q => q.top + q.height / 2).sort((a, b) => a - b); let n = 0, last = -1e9; const hs = rs.map(q => q.height); const h = hs.length ? Math.min(...hs) / 2 : 0; for (const y of cys) if (y - last > h) { n++; last = y; } return n; };
	const round = (v: number, k = 10) => Math.round(v * k) / k;
	return { cs, px, alpha, filled, bordered, side, painted, corner, classes, name, key, path, shown, scrolls, scroller, inScroller, roots, all, textNodes, lines, lineCount, round, reset: () => csCache.clear() };
}

// 1. cramped: a filled or bordered box over 100x30 whose own text sits close to its edge; running text close to the viewport edge on a phone.
// "Own text" is the text whose nearest painted ancestor is this box (a card inside a card owns its text, the outer card does not),
// measured from Range client rects, not from the element box. Text behind a clipping scroller and the page-level bars are exempt.
function cramped(cfg: any, ctx: any, H: any) {
	const items: any[] = [];
	const rootEls = H.roots(ctx.scope);
	const owned = new Map<Element, DOMRect[]>();
	const edge: Map<Element, { l: number; r: number }> = new Map();
	for (const root of rootEls) for (const n of H.textNodes(root)) {
		const rs: DOMRect[] = H.lines(n);
		if (!rs.length) continue;
		let clipped = false, box: Element | null = null;
		for (let x: Element | null = n.parentElement; x && x !== document.documentElement; x = x.parentElement) {
			const c = H.cs(x);
			if (H.painted(c)) { box = x; break; }
			if (H.scrolls(c) && x !== root && H.scroller(x)) clipped = true;
		}
		if (box && !clipped && !(H.scrolls(H.cs(box)) && H.scroller(box))) owned.set(box, [...(owned.get(box) ?? []), ...rs]);
		const t = n.data.trim();
		if (innerWidth <= cfg.phoneMax && t.length >= 12 && /\s/.test(t) && !H.inScroller(n.parentElement)) {
			const l = Math.min(...rs.map(q => q.left)), r = innerWidth - Math.max(...rs.map(q => q.right));
			if (Math.min(l, r) < 16) { const p = n.parentElement!; const o = edge.get(p); edge.set(p, { l: Math.min(l, o?.l ?? 1e9), r: Math.min(r, o?.r ?? 1e9) }); }
		}
	}
	for (const [box, rs] of owned) {
		const b = box.getBoundingClientRect(), c = H.cs(box);
		if (b.width <= cfg.crampedMinW || b.height <= cfg.crampedMinH) continue;
		// Bars and page chrome: fixed/sticky, full-bleed, a landmark, or something that holds the scope itself.
		if (/^(HTML|BODY|HEADER|NAV|FOOTER)$/.test(box.tagName) || c.position === "fixed" || c.position === "sticky" || b.width >= innerWidth - 1 || rootEls.some((r: Element) => box.contains(r))) continue;
		const L = Math.min(...rs.map(q => q.left)) - b.left, R = b.right - Math.max(...rs.map(q => q.right));
		const T = Math.min(...rs.map(q => q.top)) - b.top, B = b.bottom - Math.max(...rs.map(q => q.bottom));
		const bad = L < cfg.crampedSide || R < cfg.crampedSide || T < cfg.crampedVert || B < cfg.crampedVert;
		items.push({ check: "cramped", el: H.key(box), path: H.path(box), value: H.round(Math.min(L, R, T, B)), bad, detail: `box ${Math.round(b.width)}x${Math.round(b.height)} gaps L${H.round(L)} R${H.round(R)} T${H.round(T)} B${H.round(B)}` });
	}
	for (const [p, e] of edge) {
		const v = Math.min(e.l, e.r);
		items.push({ check: "cramped", el: `${H.key(p)} @edge`, path: H.path(p), value: H.round(v), bad: v < cfg.crampedEdge, detail: `running text to viewport edge L${H.round(e.l)} R${H.round(e.r)}` });
	}
	return items;
}

// 2. field-height: a single-line field and a button in one row (they overlap vertically and sit within 16px of each other, under a
// common ancestor at most two levels up): the difference of their heights.
function fieldHeight(cfg: any, ctx: any, H: any) {
	const items: any[] = [];
	const els: Element[] = H.all(ctx.scope);
	// a one-row textarea (the chat composer) is a single-line field; a button.sel (a select drawn as a button) is a button beside a field, not a field
	const oneRow = (t: Element) => { const c = H.cs(t), lh = H.px(c.lineHeight) || H.px(c.fontSize) * 1.2; return t.clientHeight - H.px(c.paddingTop) - H.px(c.paddingBottom) <= lh * 1.5; };
	const isField = (e: Element) => e.matches("textarea") ? oneRow(e) : e.matches('input:not([type=checkbox],[type=radio],[type=hidden],[type=range],[type=file],[type=color],[type=button],[type=submit]), select, .fi, .sel:not(button)') && !e.querySelector("textarea");
	const isButton = (e: Element) => e.matches('button, .btn, [role=button], input[type=button], input[type=submit]');
	// outermost only: an input inside a .fi wrapper is the wrapper's business
	const fields = els.filter(e => isField(e) && !e.parentElement?.closest('.fi, .sel, select'));
	const buttons = els.filter(e => isButton(e) && !fields.some(f => f.contains(e)) && !e.parentElement?.closest('button, .btn'));
	const up = (e: Element, n: number) => { let x: Element | null = e; for (let i = 0; i < n && x; i++) x = x.parentElement; return x; };
	const seen = new Set<string>();
	for (const f of fields) {
		const fr = f.getBoundingClientRect();
		if (fr.height <= 0) continue;
		for (const b of buttons) {
			const br = b.getBoundingClientRect();
			if (br.height <= 0) continue;
			const near = [0, 1, 2].some(i => [0, 1, 2].some(j => up(f, i) && up(f, i) === up(b, j)));
			const overlap = Math.min(fr.bottom, br.bottom) - Math.max(fr.top, br.top);
			const gap = Math.max(br.left - fr.right, fr.left - br.right, 0);
			if (!near || overlap < Math.min(fr.height, br.height) * 0.5 || gap > cfg.fieldGap || f.contains(b) || b.contains(f)) continue;
			const k = `${H.key(f)}|${H.key(b)}`;
			if (seen.has(k + Math.round(fr.top))) continue;
			seen.add(k + Math.round(fr.top));
			const d = Math.abs(fr.height - br.height);
			items.push({ check: "field-height", el: `${H.key(f)} + ${H.name(b)}`, path: H.path(f), value: H.round(d, 100), bad: d > cfg.fieldHeight, detail: `${H.name(f)} ${H.round(fr.height)} vs ${H.name(b)} ${H.round(br.height)}` });
		}
	}
	return items;
}

// 3. concentric: an inner painted box (own fill or border, a selection fill like .on, or a ::before/::after that gets a box) inside the
// nearest painted rounded outer box. For each corner where both neighbouring sides are inset by 12px or less, the inner radius is
// compared with max(outer radius - inset, 0) where inset is the mean of the two sides. A pseudo-element only gets a box here when it is
// positioned (absolute/fixed) with a plain px size and no transform; static or transformed ones cannot be placed from computed style.
function concentric(cfg: any, ctx: any, H: any) {
	const items: any[] = [];
	const CORNERS = [["TopLeft", "top", "left"], ["TopRight", "top", "right"], ["BottomRight", "bottom", "right"], ["BottomLeft", "bottom", "left"]] as const;
	type Box = { el: Element; label: string; pseudo?: boolean; rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }; r: Record<string, number> };
	const boxOf = (el: Element): Box | null => {
		const c = H.cs(el), b = el.getBoundingClientRect();
		if (b.width < 4 || b.height < 4) return null;
		const rect = { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
		return { el, label: H.name(el), rect, r: Object.fromEntries(CORNERS.map(([k]) => [k, H.corner(el, c, b, k)])) };
	};
	const pseudoOf = (el: Element, which: "::before" | "::after"): Box | null => {
		const c = getComputedStyle(el, which);
		if (c.content === "none" || c.content === "normal" || c.display === "none" || c.visibility === "hidden" || !H.painted(c)) return null;
		if (!/absolute|fixed/.test(c.position) || c.transform !== "none") return null;
		const w = H.px(c.width), h = H.px(c.height);
		if (!(w >= 4 && h >= 4) || /auto/.test(c.left + c.top)) return null;
		let cb: Element | null = el;
		while (cb && cb !== document.documentElement && H.cs(cb).position === "static") cb = cb.parentElement;
		const o = cb && cb !== document.documentElement ? cb : null, ob = o ? o.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight), oc = o ? H.cs(o) : null;
		const left = ob.left + (oc ? H.px(oc.borderLeftWidth) : 0) + H.px(c.left), top = ob.top + (oc ? H.px(oc.borderTopWidth) : 0) + H.px(c.top);
		const rect = { left, top, right: left + w, bottom: top + h, width: w, height: h };
		const fake = { width: w, height: h } as DOMRect;
		return { el, label: `${H.name(el)}${which}`, pseudo: true, rect, r: Object.fromEntries(CORNERS.map(([k]) => [k, H.corner(el, c, fake, k)])) };
	};
	// the nearest painted ancestor with a radius (a painted ancestor without one is not a rounded outer box)
	const outerOf = (el: Element, root: Element): Box | null => {
		for (let x = el.parentElement; x && x !== document.documentElement; x = x.parentElement) {
			const c = H.cs(x);
			if (!H.painted(c)) continue;
			if (x === document.body || x === root) return null;
			const b = boxOf(x);
			return b && Math.max(...Object.values(b.r)) > 0 ? b : null;
		}
		return null;
	};
	const rootEls: Element[] = H.roots(ctx.scope);
	const seen = new Set<string>();
	for (const el of H.all(ctx.scope) as Element[]) {
		if (!rootEls.length) break;
		const root = rootEls.find((r: Element) => r.contains(el)) ?? rootEls[0]!;
		const cands: Box[] = [];
		const c = H.cs(el);
		if (H.painted(c) && el !== root) { const b = boxOf(el); if (b) cands.push(b); }
		for (const w of ["::before", "::after"] as const) { const p = pseudoOf(el, w); if (p) cands.push(p); }
		for (const inner of cands) {
			// a circle (a round send button, a status dot, an avatar) has no concentric shape to keep; a fully round pill wider than tall is still judged
			if (Math.abs(inner.rect.width - inner.rect.height) <= 2 && Math.min(...Object.values(inner.r)) >= Math.min(inner.rect.width, inner.rect.height) / 2 - 0.01) continue;
			// a pseudo-element sits inside its own element when that is a rounded painted box, else inside the nearest one around it
			const own = inner.pseudo && H.painted(c) && el !== root ? boxOf(el) : null;
			const outer = own && Math.max(...Object.values(own.r)) > 0 ? own : outerOf(el, root);
			if (!outer) continue;
			const ir = inner.rect, or = outer.rect;
			if (ir.left < or.left - 0.5 || ir.top < or.top - 0.5 || ir.right > or.right + 0.5 || ir.bottom > or.bottom + 0.5) continue;
			const ins = { top: ir.top - or.top, bottom: or.bottom - ir.bottom, left: ir.left - or.left, right: or.right - ir.right } as Record<string, number>;
			let worst = -1, detail = "";
			for (const [k, a, b2] of CORNERS) {
				const ia = ins[a!]!, ib = ins[b2!]!;
				if (ia > cfg.inset || ib > cfg.inset) continue;
				// flush against a corner of an outer box that clips its content: the outer curve already cuts it
				if (ia < 0.5 && ib < 0.5 && /hidden|clip/.test(H.cs(outer.el).overflowX + H.cs(outer.el).overflowY)) continue;
				const inset = Math.max((ia + ib) / 2, 0), want = Math.max(outer.r[k]! - inset, 0), have = inner.r[k]!;
				// an inner box as big as its outer one takes the outer radius; the clamp above already applies
				const d = Math.abs(have - want);
				if (d > worst) { worst = d; detail = `${k} inner ${H.round(have)} vs max(outer ${H.round(outer.r[k]!)} - inset ${H.round(inset)}, 0) = ${H.round(want)}; in ${outer.label}`; }
			}
			if (worst < 0) continue;
			const k = `${H.key(el)}${inner.label.endsWith("::before") ? "::before" : inner.label.endsWith("::after") ? "::after" : ""} in ${H.name(outer.el)}`;
			const dup = k + Math.round(ir.top) + ":" + Math.round(ir.left);
			if (seen.has(dup)) continue;
			seen.add(dup);
			items.push({ check: "concentric", el: k, path: H.path(el), value: H.round(worst), bad: worst > cfg.radius, detail });
		}
	}
	return items;
}

// 4. left-edges: the left start lines of visible text and control content, per container (the nearest painted box, a pane (overflow-y
// auto/scroll or an <aside>), or the screen's main view), so indentation inside a card is that card's business and does not add to the
// screen's count. Items: a text block (its leftmost text), an input (where its text starts), an img/svg. Centred and right-aligned text is
// not on a start line and is left out; so is an item with another item of its container to its left that overlaps it vertically (a
// timestamp or value beside a title is a column of that row, not a start line).
// Lines are clustered to 1px from the first of a cluster. Per container: how many lines hold 2 or more items; and every pair of lines
// 1 to 3px apart (near-tangent), reported as its own item under "left-edges-tangent".
function leftEdges(cfg: any, ctx: any, H: any) {
	const items: any[] = [];
	const rootEls: Element[] = H.roots(ctx.scope);
	type Box = { right: number; top: number; bottom: number };
	const group = new Map<Element, { x: number; w: string; right: number; top: number; bottom: number }[]>();
	const containerOf = (el: Element, root: Element) => {
		for (let x = el.parentElement; x && x !== root && x !== document.body; x = x.parentElement) {
			const b = x.getBoundingClientRect();
			if ((H.painted(H.cs(x)) || x.tagName === "ASIDE" || /auto|scroll/.test(H.cs(x).overflowY)) && b.width > 24 && b.height > 24) return x;
		}
		return root;
	};
	const blockOf = (n: Node, root: Element) => { let x = n.parentElement; while (x && x !== root && /^(inline|contents)$/.test(H.cs(x).display)) x = x.parentElement; return x; };
	const add = (el: Element, root: Element, x: number, what: string, box: Box) => {
		const cont = containerOf(el, root), cb = cont.getBoundingClientRect(), eb = el.getBoundingClientRect();
		// right-aligned (a timestamp, a count): the item ends near where its container ends but starts well inside it; its start line moves with its text
		if (Math.abs(eb.right - cb.right) <= 24 && eb.left > cb.left + cb.width * 0.4) return;
		group.set(cont, [...(group.get(cont) ?? []), { x, w: what, right: box.right, top: box.top, bottom: box.bottom }]);
	};
	for (const root of rootEls) {
		const byBlock = new Map<Element, { x: number } & Box>();
		for (const n of H.textNodes(root)) {
			const b = blockOf(n, root);
			if (!b) continue;
			const ta = H.cs(b).textAlign;
			if (/center|right|end/.test(ta)) continue;
			const rs: DOMRect[] = H.lines(n);
			if (rs.length) { const o = byBlock.get(b); byBlock.set(b, { x: Math.min(o?.x ?? 1e9, ...rs.map(q => q.left)), right: Math.max(o?.right ?? -1e9, ...rs.map(q => q.right)), top: Math.min(o?.top ?? 1e9, ...rs.map(q => q.top)), bottom: Math.max(o?.bottom ?? -1e9, ...rs.map(q => q.bottom)) }); }
		}
		for (const [b, o] of byBlock) add(b, root, o.x, "text", o);
		for (const e of H.all(ctx.scope) as Element[]) {
			if (!root.contains(e) || e === root) continue;
			const r = e.getBoundingClientRect();
			if (e.matches("input:not([type=hidden]), select, textarea")) { const c = H.cs(e); add(e, root, r.left + H.px(c.borderLeftWidth) + H.px(c.paddingLeft), "field", r); }
			else if (e.matches("img, svg") && !e.closest("svg:not(:scope)") && r.width >= 10 && r.height >= 10) add(e, root, r.left, "icon", r);
		}
	}
	for (const [cont, all] of group) {
		// row starts only: drop an item that has another item of the container entirely to its left and overlapping it vertically by over half
		const list = all.filter(i => !all.some(j => j !== i && j.right <= i.x + 1 && Math.min(i.bottom, j.bottom) - Math.max(i.top, j.top) > Math.min(i.bottom - i.top, j.bottom - j.top) / 2));
		if (list.length < 2) continue;
		const xs = list.map(i => i.x).sort((a, b) => a - b);
		const clusters: { x: number; n: number; sum: number }[] = [];
		for (const x of xs) { const last = clusters[clusters.length - 1]; if (last && x - last.x <= 1) { last.n++; last.sum += x; } else clusters.push({ x, n: 1, sum: x }); }
		const at = clusters.map(c => ({ x: c.sum / c.n, n: c.n }));
		const multi = at.filter(c => c.n >= 2).length;
		const isRoot = rootEls.includes(cont);
		const label = isRoot ? `${H.key(cont)} (screen)` : H.key(cont);
		items.push({ check: "left-edges", el: label, path: H.path(cont), value: multi, bad: multi > cfg.leftLines, detail: `${list.length} row starts of ${all.length} items, ${at.length} lines, ${multi} with 2+: ${at.map(c => `${H.round(c.x)}x${c.n}`).join(" ")}` });
		for (let i = 1; i < at.length; i++) {
			const d = at[i]!.x - at[i - 1]!.x;
			if (d >= cfg.tangentMin && d <= cfg.tangentMax) items.push({ check: "left-edges-tangent", el: label, path: H.path(cont), value: H.round(d), bad: true, detail: `x ${H.round(at[i - 1]!.x)} (${at[i - 1]!.n}) and ${H.round(at[i]!.x)} (${at[i]!.n})` });
		}
	}
	return items;
}

// 5. icon-center: an svg/img up to 32px, or a small round filled dot, with text on the same line: |icon vertical centre - text line vertical centre|.
// The text centre is the middle of the Range client rect of the line, i.e. of the font's content area (ascent + descent), not of the
// line-height box and not of the ink. For Hangul that is the number to compare with: syllables are drawn on a square body that sits
// about centred in that area (within roughly half a pixel at 13-16px for Pretendard / Apple SD Gothic Neo), so an icon centred on the rect
// also looks centred on a Korean label. Latin lowercase letters sit lower in the same rect (the x-height middle is below its centre), so a
// Latin-only label can look about a pixel high next to an icon that this check calls centred.
function iconCenter(cfg: any, ctx: any, H: any) {
	const items: any[] = [];
	const els: Element[] = H.all(ctx.scope);
	const isIcon = (e: Element) => {
		const r = e.getBoundingClientRect();
		if (e.matches("svg, img")) return r.width > 0 && r.width <= 32 && r.height <= 32 && !e.parentElement?.closest("svg");
		if (e.children.length || (e.textContent ?? "").trim()) return false;
		const c = H.cs(e);
		return r.width >= 3 && r.width <= 14 && r.height >= 3 && r.height <= 14 && H.filled(c) && H.corner(e, c, r, "TopLeft") >= Math.min(r.width, r.height) / 2 - 0.5;
	};
	for (const icon of els.filter(isIcon)) {
		const ib = icon.getBoundingClientRect();
		let best: { q: DOMRect; gap: number; text: string } | null = null, multi = false;
		for (let p = icon.parentElement, up = 0; p && up < 3 && !best && !multi; p = p.parentElement, up++) {
			for (const n of H.textNodes(p)) {
				if (icon.contains(n) || n.parentElement?.closest("svg")) continue;
				for (const q of H.lines(n) as DOMRect[]) {
					if (q.top >= ib.bottom || q.bottom <= ib.top) continue;
					const gap = Math.max(q.left - ib.right, ib.left - q.right);
					if (gap < -1 || gap > 24) continue;
					// the neighbour is the child of p that holds this text: when it has more than one line the icon sits against a block, not a line
					let unit: Node = n;
					while (unit.parentNode && unit.parentNode !== p) unit = unit.parentNode;
					const rs: DOMRect[] = [];
					if (unit.nodeType === 1) for (const t of H.textNodes(unit as Element)) rs.push(...H.lines(t)); else rs.push(...H.lines(unit));
					if (H.lineCount(rs) > 1) { multi = true; continue; }
					if (!best || gap < best.gap) best = { q, gap, text: n.data.trim().slice(0, 24) };
				}
			}
		}
		if (!best) continue;
		const d = Math.abs(ib.top + ib.height / 2 - (best.q.top + best.q.height / 2));
		items.push({ check: "icon-center", el: H.key(icon), path: H.path(icon), value: H.round(d, 100), bad: d > cfg.iconCenter, detail: `icon cy ${H.round(ib.top + ib.height / 2, 100)} vs text cy ${H.round(best.q.top + best.q.height / 2, 100)} "${best.text}"` });
	}
	return items;
}

// 6. row-height: siblings of the same kind (tag + sorted class list), 3 or more in one parent, stacked vertically, single-line ones only
// (the line count comes from Range rects; a row with two lines of text is left out): max minus min height.
function rowHeight(cfg: any, ctx: any, H: any) {
	const items: any[] = [];
	const done = new Set<Element>();
	for (const parent of H.all(ctx.scope) as Element[]) {
		if (done.has(parent)) continue;
		done.add(parent);
		const groups = new Map<string, Element[]>();
		for (const ch of [...parent.children]) {
			if (!H.shown(ch) || /^(SCRIPT|STYLE|TEMPLATE)$/.test(ch.tagName)) continue;
			const k = ch.tagName + "." + H.classes(ch).sort().join(".");
			groups.set(k, [...(groups.get(k) ?? []), ch]);
		}
		for (const rows of groups.values()) {
			if (rows.length < 3) continue;
			const single = rows.filter(r => {
				const rs: DOMRect[] = [];
				for (const n of H.textNodes(r)) rs.push(...H.lines(n));
				return rs.length > 0 && H.lineCount(rs) === 1;
			});
			if (single.length < 3) continue;
			const rects = single.map(r => r.getBoundingClientRect()).sort((a, b) => a.top - b.top);
			// stacked: each starts at or below the previous one's bottom (chips side by side in a flex row are not rows)
			if (!rects.every((q, i) => i === 0 || q.top >= rects[i - 1]!.bottom - 1)) continue;
			const hs = rects.map(q => q.height), d = Math.max(...hs) - Math.min(...hs);
			items.push({ check: "row-height", el: `${H.key(single[0]!)} x${single.length}`, path: H.path(single[0]!), value: H.round(d, 100), bad: d > cfg.rowHeight, detail: `${single.length} of ${rows.length} rows single-line, heights ${[...new Set(hs.map(h => H.round(h)))].join("/")}` });
		}
	}
	return items;
}

// The page-side entry: installed once per page, called per screen. A measure that throws is reported with its name, never skipped.
function installPage(cfg: any, src: { helpers: string; fns: Record<string, string> }) {
	const w = window as any;
	const H = (0, eval)(`(${src.helpers})()`);
	const fns: Record<string, any> = {};
	for (const [k, s] of Object.entries(src.fns)) fns[k] = (0, eval)(`(${s})`);
	w.__LM = {
		run(ctx: any, which: string[]) {
			H.reset();
			const out: any[] = [], errors: string[] = [];
			for (const k of which) {
				try { out.push(...fns[k](cfg, ctx, H)); } catch (e: any) { errors.push(`${k}: ${e && e.stack ? e.stack : e}`); }
			}
			H.reset();
			return JSON.stringify({ items: out, errors });
		},
	};
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const MEASURES: Record<string, (...a: never[]) => unknown> = { cramped, "field-height": fieldHeight, concentric, "left-edges": leftEdges, "icon-center": iconCenter, "row-height": rowHeight };
// left-edges produces both of its checks, so a request for either runs it once
const PAGE_FN: Record<string, string> = { cramped: "cramped", "field-height": "field-height", concentric: "concentric", "left-edges": "left-edges", "left-edges-tangent": "left-edges", "icon-center": "icon-center", "row-height": "row-height" };

/* ------------------------------------------------------------------ harness ------------------------------------------------------------------ */
export type View = InstanceType<typeof Bun.WebView>;
const ROOT = join(import.meta.dir, "..");
const DEMO = join(ROOT, "site", "demo");

// The real page and bundles from hub/webapp.ts with the demo's two scripts injected first thing in <head>, before the page's own early
// fetches, so window.fetch and EventSource are the demo's. /custom.js (appended by 99-boot.js) is empty, as in site/build-demo.ts.
export function startDemoServer() {
	process.env.DOTZ_WEB_LIVE = "1";   // current web/ files, not the committed snapshot (hub/runtime/test-setup.ts does the same for tests)
	const stray: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url), p = url.pathname;
			if (p === "/") {
				const html = await (await indexPage(new Request(req.url))).text();
				const inject = '<script src="/__demo/fixtures.js"></script><script src="/__demo/demo-api.js"></script>';
				return new Response(html.replace(/<head[^>]*>/i, m => `${m}${inject}`), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
			}
			if (p === "/__demo/fixtures.js" || p === "/__demo/demo-api.js") return new Response(Bun.file(join(DEMO, p.slice("/__demo/".length))), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
			if (p === "/custom.js") return new Response("/* layout-measure: no custom layer */\n", { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
			const asset = appAsset(req, p);
			if (asset) return asset;
			// the demo answers /api/* in the page; one that reaches the server is a leak, reported by the runner
			if (p.startsWith("/api/")) { stray.push(`${req.method} ${p}`); return Response.json({}, { status: 599 }); }
			return new Response("not found", { status: 404 });
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, stray, stop: () => server.stop(true) };
}
export type DemoServer = ReturnType<typeof startDemoServer>;

// Resolves when the page-side expression is truthy, re-checked every animation frame (page timers, so the test preload's replaced setTimeout does not matter).
export const waitFor = (v: View, expr: string, ms = 20_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);

// Fonts loaded, images complete, entrance animations done (an infinite pulse is not waited for), and the layout of the shown view unchanged
// over 4 frames in a row (height, width and the number of elements), then two more frames.
export const painted = (v: View, ms = 20_000) => v.evaluate(`new Promise((res, rej) => {
	const t = setTimeout(() => rej(new Error("not painted within ${ms} ms")), ${ms});
	const still = () => document.getAnimations().every(a => a.playState !== "running" || (a.effect && a.effect.getTiming().iterations === Infinity));
	const sig = () => { const vs = document.querySelectorAll("#views > .view:not([hidden])"); return [...vs].map(e => e.scrollHeight + "x" + e.scrollWidth + "/" + e.getElementsByTagName("*").length).join(",") + "|" + document.documentElement.scrollWidth; };
	let last = "", same = 0;
	const tick = () => {
		const s = sig();
		same = s === last ? same + 1 : 0; last = s;
		if (document.fonts.status === "loaded" && [...document.images].every(i => i.complete) && still() && same >= 4) { clearTimeout(t); requestAnimationFrame(() => requestAnimationFrame(() => res(true))); }
		else requestAnimationFrame(tick);
	};
	document.fonts.ready.then(tick);
})`);

const RUNTIME = `typeof S !== "undefined" && S && typeof target === "string" && CV.loaded && NT.loaded`;

// open: a second step after the screen is ready (opens a dialog or an inline form), with its own ready; close: undoes it before the next screen.
// scope: where the checks look (default: the shown view), e.g. the dialog.
const SHOWN_ADD = `[...document.querySelectorAll(".dr-rc-add")].find(b => b.getBoundingClientRect().width > 0)`;
export type Screen = { name: string; call: string; view: string; ready: string; scope?: string; open?: { call: string; ready: string }; close?: string };
// How each screen is reached: go(view, target) as the page's own links do (web/js/05-command-palette.js), so the address follows.
//   chat      go("chat","list"): the phone's chat list; on a wide screen the chat itself (list + conversation side by side)
//   chat-open go("chat","main"): an open conversation on every width
//   mail      go("monitoring","i:mail"), kakao go("monitoring","i:kakao"): the monitoring item (30-monitoring.js MON.sel "i:<integration>")
//   project   go("project","ch:5"): the demo's first project (site/demo/demo-api.js); wide screens show it beside the project list
//   projects  go("projects"): the project list; a wide screen turns it into the first project's page (go() does that itself), so either view counts
export const SCREENS: Screen[] = [
	{ name: "home", call: `go("home")`, view: "home", ready: `!!document.querySelector("#home-cards > *")` },
	{ name: "chat", call: `go("chat", "list")`, view: "chat", ready: `CV.loaded` },
	{ name: "chat-open", call: `go("chat", "main")`, view: "chat", ready: `target === "main" && CV.placed && tl.querySelectorAll(".um, .bm, .cv-sys").length >= 1` },
	{ name: "projects", call: `go("projects")`, view: "projects,project", ready: `!!document.querySelector("#v-projects > *, #v-project > *")` },
	{ name: "project", call: `go("project", "ch:5")`, view: "project", ready: `!!document.querySelector("#v-project > *")` },
	// project-goal: the project's 단계 editor, a full-screen dialog (fs-card) with the milestone field + 추가 button
	{ name: "project-goal", call: `go("project", "ch:5")`, view: "project", ready: `!!document.querySelector("button[data-k=goal]")`, scope: "section.fs-card",
		open: { call: `document.querySelector("button[data-k=goal]").click()`, ready: `!!document.querySelector("section.fs-card .pmv-add")` }, close: `document.querySelector("section.fs-card .pdv-back")?.click()` },
	{ name: "monitoring", call: `go("monitoring")`, view: "monitoring", ready: `NM.loaded` },
	{ name: "mail", call: `go("monitoring", "i:mail")`, view: "monitoring", ready: `NM.loaded && MON.sel === "i:mail"` },
	// mail-recipient: the draft card's 받는 사람 추가 opened, an address field + 확인 button in the row
	{ name: "mail-recipient", call: `go("monitoring", "i:mail")`, view: "monitoring", ready: `NM.loaded && MON.sel === "i:mail" && ${SHOWN_ADD}`,
		open: { call: `${SHOWN_ADD}.click()`, ready: `!!document.querySelector(".dr-rc-edit .dr-rc-in")` }, close: `document.querySelectorAll(".dr-rc-edit .btn.text:not(.dr-rc-go)").forEach(b => b.click())` },
	{ name: "notices", call: `go("notices")`, view: "notices", ready: `NT.loaded && !!document.querySelector("#v-notices > *")` },
	{ name: "settings", call: `go("settings")`, view: "settings", ready: `!!document.querySelector("#settings > *")` },
	{ name: "kakao", call: `go("monitoring", "i:kakao")`, view: "monitoring", ready: `NM.loaded && MON.sel === "i:kakao" && KK.loaded` },
	// harness: the search field + the 형식 select button
	{ name: "harness", call: `go("harness")`, view: "harness", ready: `!!document.querySelector("#v-harness .fi")` },
];
export const SCREEN_SCOPE = "#views > .view:not([hidden])";
export const WIDTHS = [390, 1280];

export type Page = { view: View; width: number; theme: string; origin: string };

// One headless view at a width and theme, on the demo page, with the measures installed.
export async function openPage(server: DemoServer, opts: { width: number; theme?: "light" | "dark"; height?: number }): Promise<Page> {
	const theme = opts.theme ?? "light";
	const view = new Bun.WebView({ width: opts.width, height: opts.height ?? (opts.width < 600 ? 844 : 900) });
	await view.navigate(`${server.origin}/?lm=${Math.random().toString(36).slice(2)}#home`);
	await waitFor(view, RUNTIME);
	await view.evaluate(`(() => { localStorage.setItem("dotz-theme", ${JSON.stringify(theme)}); document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return 0; })()`);
	await installMeasures(view);
	return { view, width: opts.width, theme, origin: server.origin };
}

// Goes to a named screen and waits until it is painted. Throws "unreachable: ..." when the page does not end up showing that screen.
export async function goScreen(page: Page | View, name: string): Promise<Screen> {
	const view = "view" in page ? page.view : page;
	const s = SCREENS.find(x => x.name === name);
	if (!s) throw new Error(`unknown screen ${name}`);
	await view.evaluate(`(${s.call}, 0)`);
	try {
		await waitFor(view, `${JSON.stringify(s.view.split(","))}.includes(current) && !document.querySelector("#v-" + current).hidden && (${s.ready})`, 10_000);
	} catch (e) {
		const now = await view.evaluate(`JSON.stringify({ current, hash: location.hash, shown: [...document.querySelectorAll("#views > .view:not([hidden])")].map(e => e.id) })`);
		throw new Error(`unreachable: ${name}: ${now} (${e instanceof Error ? e.message : e})`);
	}
	await painted(view);
	if (s.open) {
		await view.evaluate(`(${s.open.call}, 0)`);
		await waitFor(view, s.open.ready, 10_000).catch(e => { throw new Error(`unreachable: ${name}: opening step (${e instanceof Error ? e.message : e})`); });
		await painted(view);
	}
	return s;
}

export async function installMeasures(view: View, cfg: Thresh = THRESH): Promise<void> {
	const fns = Object.fromEntries(Object.entries(MEASURES).map(([k, f]) => [k, String(f)]));
	await view.evaluate(`(${installPage})(${JSON.stringify(cfg)}, ${JSON.stringify({ helpers: String(helpers), fns })}), 0`);
}

// Runs the given checks (default all) on what the page shows now; `scope` is a selector (default: the shown screen view).
export async function runChecks(view: View, ctx: Partial<Ctx> & { screen: string; width: number }, checks: readonly Check[] = CHECKS): Promise<Item[]> {
	const full: Ctx = { scope: SCREEN_SCOPE, ...ctx };
	const which = [...new Set(checks.map(c => PAGE_FN[c]!))];
	const res = JSON.parse(await view.evaluate(`__LM.run(${JSON.stringify(full)}, ${JSON.stringify(which)})`) as string) as { items: Omit<Item, "screen" | "width">[]; errors: string[] };
	if (res.errors.length) throw new Error(`measure failed on ${full.screen}@${full.width}:\n${res.errors.join("\n")}`);
	return res.items.filter(i => checks.includes(i.check)).map(i => ({ ...i, screen: full.screen, width: full.width }));
}

/* ------------------------------------------------------------------ report ------------------------------------------------------------------ */
export const itemKey = (i: Pick<Item, "check" | "screen" | "width" | "el">) => `${i.check}|${i.screen}|${i.width}|${i.el}`;
const STEP: Record<Check, number> = { cramped: 1, "field-height": 0.5, concentric: 1, "left-edges": 1, "left-edges-tangent": 0.5, "icon-center": 0.5, "row-height": 1 };

export function summarize(items: Item[]) {
	const out: Record<string, { n: number; bad: number; histogram: Record<string, number>; worst: Item[] }> = {};
	for (const c of CHECKS) {
		const mine = items.filter(i => i.check === c);
		const histogram: Record<string, number> = {};
		for (const i of mine) { const b = (Math.floor(i.value / STEP[c] + 1e-9) * STEP[c]).toFixed(STEP[c] < 1 ? 1 : 0); histogram[b] = (histogram[b] ?? 0) + 1; }
		// worst: bad first; the more a value is out of bounds the worse. cramped is "small is bad", the others "large is bad".
		const small = c === "cramped";
		const worst = mine.slice().sort((a, b) => Number(b.bad) - Number(a.bad) || (small ? a.value - b.value : b.value - a.value)).slice(0, 15);
		out[c] = { n: mine.length, bad: mine.filter(i => i.bad).length, histogram: Object.fromEntries(Object.entries(histogram).sort((a, b) => Number(a[0]) - Number(b[0]))), worst };
	}
	return out;
}

export function readBaseline(file: string): string[] {
	if (!existsSync(file)) return [];
	const j = JSON.parse(readFileSync(file, "utf8")) as { keys?: string[] };
	return j.keys ?? [];
}
// New = bad keys not in the baseline. Stale = baseline keys of the screens and widths that ran which no longer show up bad.
export function compareBaseline(items: Item[], baseline: string[], ran: { screens: string[]; widths: number[]; unreached?: { screen: string; width: number }[] }) {
	const bad = new Set(items.filter(i => i.bad).map(itemKey)), known = new Set(baseline);
	const inRun = (k: string) => { const [, s, w] = k.split("|"); return ran.screens.includes(s!) && ran.widths.includes(Number(w)) && !ran.unreached?.some(u => u.screen === s && u.width === Number(w)); };
	return { added: [...bad].filter(k => !known.has(k)).sort(), stale: baseline.filter(k => inRun(k) && !bad.has(k)).sort() };
}
export const BASELINE_FILE = join(import.meta.dir, "layout-baseline.json");

// The whole run: one server, one page per width, every screen visited in turn. A screen the page cannot show is listed in unreached, not skipped silently.
export async function measureScreens(names: string[], widths: number[]) {
	const server = startDemoServer();
	const items: Item[] = [], unreached: { screen: string; width: number; reason: string }[] = [], perScreen: Record<string, number> = {};
	try {
		for (const width of widths) {
			const page = await openPage(server, { width });
			try {
				for (const name of names) {
					const t0 = performance.now();
					try { await goScreen(page, name); } catch (e) {
						const m = e instanceof Error ? e.message : String(e);
						if (!m.startsWith("unreachable")) throw e;
						unreached.push({ screen: name, width, reason: m });
						continue;
					}
					const scope = SCREENS.find(x => x.name === name)!.scope;
					items.push(...await runChecks(page.view, { screen: name, width, ...(scope ? { scope } : {}) }));
					const close = SCREENS.find(x => x.name === name)!.close;
					if (close) await page.view.evaluate(`(${close}, 0)`);
					perScreen[`${name}@${width}`] = Math.round(performance.now() - t0);
				}
			} finally { page.view.close(); }
		}
	} finally { server.stop(); }
	return { items, unreached, stray: [...new Set(server.stray)], perScreen };
}

/* ------------------------------------------------------------------ CLI ------------------------------------------------------------------ */
const fail = (why: string): never => { console.error(why); process.exit(2); };

if (import.meta.main) {
	const started = performance.now();
	const { values } = (() => { try { return parseArgs({ options: { screens: { type: "string" }, widths: { type: "string" }, json: { type: "boolean", default: false }, out: { type: "string" }, "write-baseline": { type: "boolean", default: false } } }); } catch (e) { return fail(String(e)); } })();
	const names = values.screens ? values.screens.split(",").filter(Boolean) : SCREENS.map(s => s.name);
	const widths = values.widths ? values.widths.split(",").filter(Boolean).map(Number) : WIDTHS;
	for (const n of names) if (!SCREENS.some(s => s.name === n)) fail(`unknown screen ${n}; known: ${SCREENS.map(s => s.name).join(", ")}`);
	if (!widths.length || !widths.every(w => w > 0)) fail(`bad --widths ${values.widths}`);

	const watchdog = setTimeout(() => fail("no result within 240 s"), 240_000);
	const { items, unreached, stray, perScreen } = await measureScreens(names, widths).catch(e => fail(`could not measure: ${e instanceof Error ? e.stack : e}`));
	clearTimeout(watchdog);

	const summary = summarize(items);
	// a screen that could not be reached must not make its baseline keys look stale
	const ran = { screens: names, widths, unreached };
	const baseline = readBaseline(BASELINE_FILE);
	const cmp = compareBaseline(items, baseline, ran);
	const ms = Math.round(performance.now() - started);
	const badKeys = [...new Set(items.filter(i => i.bad).map(itemKey))].sort();
	if (values["write-baseline"]) {
		const keep = baseline.filter(k => { const [, s, w] = k.split("|"); return !(names.includes(s!) && widths.includes(Number(w))) || unreached.some(u => u.screen === s && u.width === Number(w)); });
		mkdirSync(dirname(BASELINE_FILE), { recursive: true });
		writeFileSync(BASELINE_FILE, `${JSON.stringify({ note: "accepted layout-measure items (check|screen|width|el); the list only shrinks", keys: [...new Set([...keep, ...badKeys])].sort() }, null, 1)}\n`);
		console.error(`baseline written: ${BASELINE_FILE} (${badKeys.length} keys from this run)`);
	}
	const report = { elapsedMs: ms, widths, screens: names, unreached, stray, thresholds: THRESH, perScreenMs: perScreen, checks: summary, items: items.filter(i => i.bad), baseline: { added: cmp.added, stale: cmp.stale } };
	if (values.out) { mkdirSync(dirname(values.out), { recursive: true }); writeFileSync(values.out, `${JSON.stringify(report, null, 1)}\n`); }
	if (values.json) console.log(JSON.stringify(report, null, 1));
	else {
		for (const c of CHECKS) {
			const s = summary[c]!;
			console.log(`\n== ${c}: ${s.n} measured, ${s.bad} bad`);
			const peak = Math.max(1, ...Object.values(s.histogram));
			for (const [b, n] of Object.entries(s.histogram)) console.log(`  ${b.padStart(6)}  ${String(n).padStart(4)}  ${"#".repeat(Math.max(1, Math.round((n / peak) * 30)))}`);
			console.log("  worst:");
			for (const i of s.worst) console.log(`   ${i.bad ? "!" : " "} ${i.value}  ${i.screen}@${i.width}  ${i.el}  [${i.detail}]\n        ${i.path}`);
		}
		if (unreached.length) console.log(`\nunreached screens:\n${unreached.map(u => `  ${u.screen}@${u.width}: ${u.reason}`).join("\n")}`);
		if (stray.length) console.log(`\n/api calls that reached the server instead of the demo: ${stray.join(", ")}`);
		console.log(`\nbaseline: ${cmp.added.length} new, ${cmp.stale.length} stale; ${badKeys.length} bad keys; ${ms} ms`);
		for (const k of cmp.added) console.log(`  new   ${k}`);
		for (const k of cmp.stale) console.log(`  stale ${k}`);
	}
	process.exit(cmp.added.length || cmp.stale.length ? 1 : 0);
}
