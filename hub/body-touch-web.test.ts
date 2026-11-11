// Every control in the page body answers a tap over 44x44 on a phone, 40 inside a list row (docs/ui-spec.md 버튼, 공통 줄), the same way hub/appbar-touch-web.test.ts
// measures the app bar: the page at 390 with the coarse-pointer rules switched on (Bun.WebView reports a fine pointer, hub/layout-measure.ts keeps the demo
// page), elementFromPoint walked out from the center of each visible control along both axes. Two neighbours whose areas overlap fail here: the one
// later in the document wins the shared strip, so the earlier one reads short.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { goScreen, openPage, SCREENS, startDemoServer, type Page } from "./layout-measure.ts";

setDefaultTimeout(120_000);   // a WebView start takes seconds under parallel load, and every screen is walked
const server = startDemoServer({ now: 1_760_000_000_000 });
let page: Page | undefined;
afterAll(() => { page?.view.close(); server.stop(true); });

const COARSE = `(() => {
	const out = [], walk = (rules) => {
		for (const r of rules) {
			if (r.type === CSSRule.MEDIA_RULE) {
				const c = r.conditionText || r.media.mediaText;
				if (/pointer:\\s*coarse|hover:\\s*none/.test(c) && !/\\bnot\\b/.test(c)) out.push(Array.from(r.cssRules, x => x.cssText).join("\\n"));
				else walk(r.cssRules);
			} else if (r.cssRules && r.type !== CSSRule.KEYFRAMES_RULE) walk(r.cssRules);
		}
	};
	for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch {} }
	const st = document.createElement("style"); st.textContent = out.join("\\n"); document.head.append(st);
	return out.length;
})()`;
// Visible controls of the shown view (the app bar has its own test) and the size of the area that answers a tap on each.
const INT = `button,a[href],[role="button"],input:not([type="hidden"]),select,textarea,summary`;
const ROW = `.row,.li,li,.mlist-row,.rc-row,.cv-row,.fitem,.rq-r,.nsc-r,.pal-i,.subrow,.hc-row,.rt-row,tr`;
// Left as drawn, each for a reason: a field has no ::after and its height is the field token; the buttons of a segmented control and of a recipient chip sit
// in a box that clips (overflow: hidden) and 2px or 6px from the next one, so a 44px area would take over its neighbours.
const LEFT = `input,textarea,.seg button,.dr-chip button`;
const BODY_HITS = `(() => {
	const name = e => (e.parentElement ? e.parentElement.tagName.toLowerCase() + (e.parentElement.classList[0] ? "." + e.parentElement.classList[0] : "") + ">" : "") + e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + [...e.classList].map(c => "." + c).join("");
	const out = [], nav = document.querySelector("#nav").getBoundingClientRect(), navTop = nav.height > 0 ? nav.top : Infinity;
	for (const e of document.querySelectorAll("#views > .view:not([hidden]) *")) {
		if (!e.matches(${JSON.stringify(INT)}) || e.matches(":disabled,[aria-disabled='true']") || e.matches(${JSON.stringify(LEFT)})) continue;
		const b = e.getBoundingClientRect();
		if (b.width <= 0 || b.height <= 0) continue;
		const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
		if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight || b.bottom > navTop) continue;
		const hit = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === e || e.contains(t)); };
		if (!hit(cx, cy)) continue;
		const reach = (dx, dy) => { let n = 0; while (n < 60 && hit(cx + dx * (n + 1), cy + dy * (n + 1))) n++; return n; };
		const w = reach(-1, 0) + reach(1, 0) + 1, h = reach(0, -1) + reach(0, 1) + 1, need = e.closest(${JSON.stringify(ROW)}) ? 40 : 44;
		if (w < need || h < need) out.push(name(e) + " " + w + "x" + h + "<" + need);
	}
	return out;
})()`;

test("every control in the page body answers a tap over 44x44 (40 in a list row) at 390 with a coarse pointer", async () => {
	page = await openPage(server, { width: 390 });
	expect(await page.view.evaluate(COARSE)).toBeGreaterThan(0);
	const small = new Set<string>();
	for (const { name } of SCREENS) {
		await goScreen(page, name);
		for (const s of JSON.parse(await page.view.evaluate(`JSON.stringify(${BODY_HITS})`)) as string[]) small.add(`${name}: ${s}`);
	}
	expect([...small]).toEqual([]);
});
