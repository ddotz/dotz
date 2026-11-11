// ui F7 (fable-review): controls drawn under 44px keep their size and answer a tap over a 44x44 box on a phone, by extending the hit area (padding or ::after).
// The page at 390 (below 640px the touch rules apply, no coarse pointer needed): for each control F7 names, elementFromPoint walked out from its center
// (the way hub/body-touch-web.test.ts does) must land on the control over 44px each way. Two neighbours that share a strip fail here too: the later one wins it.
// The fixed app bar and tab bar cover what a control scrolled under them would reach: that is chrome, not a neighbour.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { goScreen, openPage, startDemoServer, type Page } from "./layout-measure.ts";

setDefaultTimeout(120_000);   // a WebView start takes seconds under parallel load
const server = startDemoServer({ now: 1_760_000_000_000 });
let page: Page | undefined;
afterAll(() => { page?.view.close(); server.stop(true); });

// screen → controls F7 lists as under 44px there
const NAMED: Record<string, string[]> = {
	home: ["#title", ".hgreet-more"],
	"chat-open": ["#title", ".td-bar"],
	projects: ["#title"],
	monitoring: ["#title"],
	mail: ["#title", ".mr-f", ".rq-og", ".rq-recv"],
	notices: ["#title", ".nsc-x", ".nsc-fold"],
	settings: ["#title"],
};

// For every visible match with an area under 44px either way: its name and size.
const MISSES = (selectors: string[]) => `(() => {
	const nav = document.querySelector("#nav").getBoundingClientRect(), navTop = nav.height > 0 ? nav.top : Infinity;
	const name = e => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + [...e.classList].map(c => "." + c).join("");
	const seen = {}, out = [];
	for (const sel of ${JSON.stringify(selectors)}) for (const e of document.querySelectorAll(sel)) {
		const b = e.getBoundingClientRect();
		if (!e.checkVisibility() || b.width <= 0 || b.height <= 0) continue;
		const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
		if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight || b.bottom > navTop) continue;
		seen[sel] = (seen[sel] || 0) + 1;
		const hit = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === e || e.contains(t) || (!e.closest("#appbar, #nav") && !!t.closest("#appbar, #nav"))); };
		const reach = (dx, dy) => { let n = 0; while (n < 60 && hit(cx + dx * (n + 1), cy + dy * (n + 1))) n++; return n; };
		const w = reach(-1, 0) + reach(1, 0) + 1, h = reach(0, -1) + reach(0, 1) + 1;
		if (w < 44 || h < 44) out.push(name(e) + " " + Math.round(b.width) + "x" + Math.round(b.height) + " hit " + w + "x" + h);
	}
	return { seen, out };
})()`;

test("the controls F7 names answer a tap over 44x44 at 390", async () => {
	page = await openPage(server, { width: 390 });
	const missed: string[] = [], seenAll = new Set<string>();
	for (const [screen, sels] of Object.entries(NAMED)) {
		await goScreen(page, screen);
		const r = JSON.parse(await page.view.evaluate(`JSON.stringify(${MISSES(sels)})`)) as { seen: Record<string, number>; out: string[] };
		for (const k of Object.keys(r.seen)) seenAll.add(`${screen} ${k}`);
		for (const s of r.out) missed.push(`${screen}: ${s}`);
	}
	// the list is only worth something if every control it names was on its screen
	for (const [screen, sels] of Object.entries(NAMED)) for (const sel of sels) expect(seenAll.has(`${screen} ${sel}`), `${screen} ${sel}`).toBe(true);
	expect(missed).toEqual([]);
});
