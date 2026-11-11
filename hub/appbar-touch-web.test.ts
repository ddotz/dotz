// Every control in the app bar answers a tap over 44x44 on a phone (docs/ui-spec.md 버튼, 공통 줄): the page at 390 with the coarse-pointer
// rules switched on (Bun.WebView reports a fine pointer, hub/layout-measure.ts keeps the demo page), elementFromPoint walked out from the center of
// each visible control along both axes. Two neighbours whose 44px areas overlap fail here: the one later in the bar wins the shared strip.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { goScreen, openPage, SCREENS, startDemoServer, type Page } from "./layout-measure.ts";

setDefaultTimeout(60_000);   // a WebView start takes seconds under parallel load
const server = startDemoServer({ now: 1_760_000_000_000 });
let page: Page | undefined;
afterAll(() => { page?.view.close(); server.stop(true); });

// A phone has a coarse pointer, the headless view does not: copy the rules of every coarse/no-hover media query into a plain <style>.
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
// Visible app bar controls and the size of the area that answers a tap on each.
const APPBAR_HITS = `(() => {
	return [...document.querySelectorAll("#appbar button, #appbar a[href], #appbar input")].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).map(e => {
		const b = e.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
		const reach = (dx, dy) => { let n = 0; while (n < 60 && e.contains(document.elementFromPoint(cx + dx * (n + 1), cy + dy * (n + 1)))) n++; return n; };
		return [e.id || e.className, reach(-1, 0) + reach(1, 0) + 1, reach(0, -1) + reach(0, 1) + 1];
	});
})()`;

test("every app bar control answers a tap over 44x44 at 390 with a coarse pointer", async () => {
	page = await openPage(server, { width: 390 });
	expect(await page.view.evaluate(COARSE)).toBeGreaterThan(0);
	const seen = new Set<string>(), small: string[] = [];
	const hitsOf = async () => JSON.parse(await page!.view.evaluate(`JSON.stringify(${APPBAR_HITS})`)) as [string, number, number][];
	for (const { name } of SCREENS) {
		if (name === "mail-recipient") continue;   // the same app bar as mail
		await goScreen(page, name);
		for (const [id, w, h] of await hitsOf()) {
			seen.add(id);
			if (w < 44 || h < 44) small.push(`${name}: ${id} ${w}x${h}`);
		}
	}
	// the offline pill hides itself online: show it on the home bar (alone, it would push a longer bar past the screen edge)
	await goScreen(page, "home");
	await page.view.evaluate(`(document.querySelector("#conn").hidden = false, 0)`);
	for (const [id, w, h] of (await hitsOf()).filter(([id]) => id === "conn")) {
		seen.add(id);
		if (w < 44 || h < 44) small.push(`home: ${id} ${w}x${h}`);
	}
	// the list above is only worth something if the controls it names were on a screen
	for (const id of ["back", "cmdk", "bell", "ustrip", "conn", "as-bar", "as-more-bar"]) expect(seen.has(id), id).toBe(true);
	expect(small).toEqual([]);
});
