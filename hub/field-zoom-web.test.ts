// iOS zooms the page when a field under 16px takes focus, so on a phone every text field of the app is 16px or more (docs/ui-spec.md 입력창). Bun.WebView
// reports a fine pointer, so the page's own app.css is swapped for a copy whose `(pointer: coarse)` conditions always apply: the rules keep their place in the
// cascade, which is what decides a phone's size when a later `.sendrow textarea { font-size: 15px }` meets the coarse 16px written before it.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { goScreen, openPage, SCREENS, startDemoServer, waitFor, type Page } from "./layout-measure.ts";

setDefaultTimeout(120_000);   // a WebView start takes seconds under parallel load, and every screen is walked
const server = startDemoServer({ now: 1_760_000_000_000 });
let page: Page | undefined;
afterAll(() => { page?.view.close(); server.stop(true); });

const TOUCH = `(async () => {
	const link = document.querySelector('link[href^="/app.css"]'), css = await (await fetch("/app.css")).text(), st = document.createElement("style");
	st.textContent = css.replace(/\\(pointer:\\s*coarse\\)/g, "(min-width: 0px)");
	link.replaceWith(st);
	return css.includes("(pointer: coarse)");
})()`;
// Every text field in the page, shown or not: a closed screen's field still has its size when the screen opens.
const FIELDS = `JSON.stringify([...document.querySelectorAll("input, textarea, select, [contenteditable]")]
	.filter(e => !/^(checkbox|radio|range|file|hidden|button|submit|reset|color|image)$/.test(e.type) && e.getAttribute("contenteditable") !== "false")
	.map(e => ({ name: e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + [...e.classList].map(c => "." + c).join(""), size: parseFloat(getComputedStyle(e).fontSize) })))`;

test("every text field is 16px or more on a phone, so focusing it does not zoom the page", async () => {
	page = await openPage(server, { width: 390 });
	const view = page.view;
	expect(await view.evaluate(TOUCH)).toBe(true);
	const seen = new Set<string>(), small = new Set<string>();
	const scan = async (where: string) => {
		for (const f of JSON.parse(await view.evaluate(FIELDS)) as { name: string; size: number }[]) {
			seen.add(f.name);
			if (f.size < 16) small.add(`${where}: ${f.name} ${f.size}px`);
		}
	};
	for (const { name } of SCREENS) { await goScreen(page, name); await scan(name); }

	// fields that only exist once something is opened: the palette, the mail compose sheet, the draft question, a decision card's reason
	await goScreen(page, "mail");
	await view.evaluate(`(openPalette(), 0)`);
	await waitFor(view, `!!document.querySelector("dialog.pal .pal-in")`);
	await scan("palette");
	await view.evaluate(`(document.querySelector("dialog.pal").close(), 0)`);
	await view.evaluate(`(mbCompose({}), 0)`);
	await waitFor(view, `!!document.querySelector(".mbox-ta")`);
	await scan("mail-compose");
	await view.evaluate(`(mailDraftDialog([...MAILS.keys()][0], null), 0)`);
	await waitFor(view, `!!document.querySelector(".md-ask textarea")`);
	await scan("draft-ask");
	await goScreen(page, "notices");
	await view.evaluate(`(() => { const n = ntById("n-demo-1"); ntSheetShow(String(n.id), null, null); NS.edit = { id: String(n.id), opt: n.decision.options[1], text: "", fresh: true }; ntSheetPaint(); return 0; })()`);
	await waitFor(view, `!!document.querySelector(".dc-note")`);
	await scan("decision-reason");

	// the screens above must really have shown these, or an empty list would pass
	// (the draft question's textarea gets .md-ask only from its parent, so its name cannot show it; the waitFor above already proved it was shown)
	for (const must of ["textarea#text", ".pal-in", ".mbox-ta", ".dc-note", "#pl-q", ".dr-rc-in"]) {
		expect([...seen].some(n => n.includes(must)), must).toBe(true);
	}
	expect([...small]).toEqual([]);
});
