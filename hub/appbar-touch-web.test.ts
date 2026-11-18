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

// The title's letters sit on the bar's middle line with the icons beside it, one line or two (a 2-line chat title is clamped, 16-result-card.css).
// Measured on the text itself: a title box of tap height with its one line pinned to the top looks like a title with an empty line under it.
// Each text run (the title, the computer beside it on a mail screen) is either fully inside the clip box or fully past it (a clamped third line,
// the computer wrapped to a second row); one cut by the clip edge shows only half its letters.
const TITLE_OFF = `(() => {
	const t = document.querySelector("#title"), b = document.querySelector("#bell").getBoundingClientRect(), h = t.getBoundingClientRect();
	const top0 = h.top + t.clientTop, bot = top0 + t.clientHeight, all = [], w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
	for (let n = w.nextNode(); n; n = w.nextNode()) { const r = document.createRange(); r.selectNodeContents(n); all.push(...[...r.getClientRects()].filter(q => q.height > 0)); }
	const cut = all.filter(q => q.top < bot - 0.5 && (q.bottom > bot + 0.5 || q.top < top0 - 0.5)).length;
	const ls = all.filter(q => q.bottom <= bot + 0.5 && q.top >= top0 - 0.5);
	if (!h.height || !ls.length) return [99, 0, cut];
	const top = Math.min(...ls.map(q => q.top)), end = Math.max(...ls.map(q => q.bottom));
	return [Math.round(Math.abs((top + end) / 2 - (b.top + b.height / 2))), Math.round(end - top), cut];
})()`;

test("the app bar title is centred on the icon row at 412, with one line or two, and no letter is cut", async () => {
	const p = await openPage(server, { width: 412, height: 915 });
	try {
		const off = async () => JSON.parse(await p.view.evaluate(`JSON.stringify(${TITLE_OFF})`)) as [number, number, number];
		const bad: string[] = [];
		for (const name of ["home", "chat-open", "project", "monitoring", "mail", "kakao", "settings"]) {
			await goScreen(p, name);
			const o = await off();
			if (o[0] > 1) bad.push(`${name}: ${o[0]}px`);
			if (o[2]) bad.push(`${name}: ${o[2]} cut`);
		}
		// the mail screen names the computer beside its title (.mon-pc); a long name wraps to a second row the bar hides
		await goScreen(p, "mail");
		expect(await p.view.evaluate(`!!document.querySelector("#title > .mon-pc")`)).toBe(true);
		await p.view.evaluate(`(document.querySelector("#title > .mon-pc").textContent = "${"긴 컴퓨터 이름 ".repeat(6)}", 0)`);
		const wrap = await off();
		if (wrap[0] > 1 || wrap[2]) bad.push(`mail long computer: ${wrap[0]}px, ${wrap[2]} cut`);
		await goScreen(p, "chat-open");
		await p.view.evaluate(`($("#title").textContent = "${"긴 대화 제목 ".repeat(12)}", 0)`);
		const two = await off();
		expect(two[1]).toBeGreaterThan(30);   // clamped to two lines, not one
		if (two[0] > 1 || two[2]) bad.push(`chat-open 2 lines: ${two[0]}px, ${two[2]} cut`);
		expect(bad).toEqual([]);
	} finally { p.view.close(); }
});
