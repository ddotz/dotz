// The mail compose sheet is the whole screen on a phone. With the keyboard up it must end where the keyboard begins and be as tall as what
// is still visible, as the composer does: the body's end and the send row stay above the keyboard. The viewport is the page's own
// web/js/34-composer-viewport.js fed a stubbed visualViewport (Bun.WebView has no on-screen keyboard), as in hub/composer-stable-web.test.ts.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { goScreen, openPage, startDemoServer, waitFor, type Page } from "./layout-measure.ts";

setDefaultTimeout(120_000);   // a WebView start takes seconds under parallel load
const server = startDemoServer({ now: 1_760_000_000_000 });
let page: Page | undefined;
afterAll(() => { page?.view.close(); server.stop(true); });

type Box = { top: number; bottom: number };
type Shot = { kb: string; sheet: Box; body: Box; send: Box };

test("the phone mail sheet ends where the keyboard begins, so the body's end and the send row stay above it, the body whole above the send row", async () => {
	page = await openPage(server, { width: 390, height: 699 });
	const view = page.view;
	await goScreen(page, "mail");
	await view.evaluate(`(mbCompose({}), 0)`);
	await waitFor(view, `!!document.querySelector(".mbox-sheet .mbox-ta")`);
	await view.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))).then(() => 0)`);
	const src = await Bun.file(new URL("../web/js/34-composer-viewport.js", import.meta.url)).text();
	const keyboard = async (height: number, offsetTop: number) => JSON.parse(String(await view.evaluate(`(async () => {
		const vv = Object.assign(new EventTarget(), { height: ${height}, offsetTop: ${offsetTop}, scale: 1 });
		Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
		(0, eval)(${JSON.stringify(src)});
		vv.dispatchEvent(new Event("resize"));
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
		const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
		return JSON.stringify({ kb: document.documentElement.style.getPropertyValue("--kb"), sheet: box(".mbox-sheet"), body: box(".mbox-ta"), send: box(".mbox-sf") });
	})()`))) as Shot;

	// no pan (a browser that neither pans nor shrinks the page): the keyboard covers everything under 369
	const flat = await keyboard(369, 0);
	expect(flat.kb).toBe("330px");
	expect(flat.sheet).toEqual({ top: 0, bottom: 369 });
	expect(flat.body.bottom).toBeLessThanOrEqual(369);
	expect(flat.send.bottom).toBeLessThanOrEqual(369);
	// the body shrinks to the room between the subject and the send row: its whole focus border shows, nothing runs under the row
	expect(flat.body.bottom).toBeLessThanOrEqual(flat.send.top);

	// iOS Safari pans the visible area down by 259: the sheet is that area exactly, its top under the status bar and its end at the keyboard
	const pan = await keyboard(369, 259);
	expect(pan.kb).toBe("71px");
	expect(pan.sheet).toEqual({ top: 259, bottom: 628 });
	expect(pan.send.bottom).toBeLessThanOrEqual(628);
	expect(pan.body.bottom).toBeLessThanOrEqual(628);
	expect(pan.body.bottom).toBeLessThanOrEqual(pan.send.top);

	// the keyboard goes down: the whole screen again
	expect((await keyboard(699, 0)).sheet).toEqual({ top: 0, bottom: 699 });
});
