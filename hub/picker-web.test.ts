// The element picker (web/js/15-picker.js) in the 앱 frame (web/js/30-apps.js), as shipped, in a headless Bun.WebView: no pick button,
// a hint in the app header, Cmd held outlines the element under the mouse, Cmd+click picks it (the element's own handler does not run),
// releasing Cmd hides the outline, a plain click stays the app's, and on a phone a long press picks while a short tap does not.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.T7_SHOTS ?? join(tmpdir(), "dotz-shots", "picker");
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown) => Response.json(v);
const items = [
	{ id: "mydocs", label: "문서 도구", kind: "tool", source: "manifest", icon: "file", status: "running", off: false, health: "/", watches: [], settings: {}, web: { url: "http://127.0.0.1:4417", path: "/", mode: "rewrite", href: "/apps/mydocs/" } },
];
const PAGE = `<!doctype html><html><head><title>fake docs tool</title><style>body{font:15px/1.5 sans-serif;margin:24px}button,a{display:inline-block;margin:8px 0;padding:10px 14px}</style></head><body>
<h1>가짜 문서 앱</h1><p id="intro">문서를 고르고 저장해요.</p><button id="save" onclick="window.saved=(window.saved||0)+1">저장</button>
<a id="help" href="/apps/mydocs/help" target="_blank" onclick="window.helped=(window.helped||0)+1">도움말</a></body></html>`;
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/apps") return json({ items, errors: [] });
		if (url.pathname === "/apps/mydocs/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {} });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
		if (url.pathname === "/api/monitors") return json({ items: [] });
		if (url.pathname === "/api/integrations") return json({ items: [], available: [] });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitOn = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const get = async (v: InstanceType<typeof Bun.WebView>, body: string) => JSON.parse(await v.evaluate(`JSON.stringify((() => { ${body} })())`) as string);
// The frame's document and a point inside one of its elements, in the frame's own coordinates.
const FD = `const f = document.querySelector("#apps-pane .apps-frame"), d = f.contentDocument, w = d.defaultView;`;
const AT = `const at = id => { const r = d.getElementById(id).getBoundingClientRect(); return { clientX: r.left + 8, clientY: r.top + 8, bubbles: true, cancelable: true, composed: true }; };`;

// touch: the page reports a phone (no hover, a coarse pointer) before the header is drawn.
async function open(width: number, height: number, touch = false) {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitOn(v, `typeof APPS !== "undefined" && APPS.loaded && S`);
	if (touch) await v.evaluate(`(() => { const mm = matchMedia.bind(window); window.matchMedia = q => /hover: none|pointer: coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q); return 0; })()`);
	await v.evaluate(`(APPS_ON = true, go("apps", "mydocs"), 0)`);
	await waitOn(v, `(() => { try { const d = document.querySelector("#apps-pane .apps-frame").contentDocument; return d.body.innerText.includes("가짜 문서 앱") && d.__pkBound; } catch { return false; } })()`);
	return v;
}

// The chips sit in the conversation's composer (the 채팅 screen), ready to go with the next message; the markers stay with the app.
async function chipsInChat(v: InstanceType<typeof Bun.WebView>, shot: string) {
	await v.evaluate(`(go("chat"), 0)`);
	await waitOn(v, `current === "chat" && $("#atray").getClientRects().length > 0 && !document.querySelector("#pick-marks .pk-mark:not([hidden])") && document.querySelector("#pick-box").hidden`);
	await Bun.write(join(SHOTS, shot), await v.screenshot());
	return get(v, `return [...document.querySelectorAll("#atray .pk-chip")].map(c => c.querySelector(".pk-n").textContent + " " + c.querySelector(".fi-n").textContent);`);
}

describe("element picker at 1280px", () => {
	test("Cmd held outlines, Cmd+click picks without the element's handler, Cmd up hides, a plain click is the app's", async () => {
		const v = await open(1280, 900);
		const head = await get(v, `return { hint: $("#apps-pane .pk-hint").textContent, button: document.querySelectorAll(".pk-toggle, #pick-pill, [aria-label='요소 고르기']").length };`);
		expect(head).toEqual({ hint: "⌘+클릭으로 요소 고르기", button: 0 });

		// Cmd down with the mouse over 저장: the outline sits on 저장 and says what it is.
		const held = await get(v, `${FD} ${AT}
			d.getElementById("save").dispatchEvent(new PointerEvent("pointermove", { ...at("save"), pointerType: "mouse" }));
			const before = !document.querySelector("#pick-box").hidden;
			w.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }));
			const box = document.querySelector("#pick-box"), b = box.getBoundingClientRect(), s = d.getElementById("save").getBoundingClientRect(), fr = f.getBoundingClientRect();
			return { before, shown: !box.hidden, label: box.textContent, on: Math.abs(b.left - (s.left + fr.left)) < 2 && Math.abs(b.top - (s.top + fr.top)) < 2 };`);
		expect(held).toEqual({ before: false, shown: true, label: "button · 저장", on: true });
		await Bun.write(join(SHOTS, "picker-cmd-hover-1280.png"), await v.screenshot());

		// Two Cmd+clicks: 저장 and the 도움말 link. Neither handler runs, the link's default (a new tab) is cancelled.
		const picked = await get(v, `${FD} ${AT}
			const click = id => { const el = d.getElementById(id), o = { ...at(id), metaKey: true };
				el.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerType: "mouse" })); el.dispatchEvent(new MouseEvent("mousedown", o));
				el.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerType: "mouse" })); el.dispatchEvent(new MouseEvent("mouseup", o));
				return el.dispatchEvent(new MouseEvent("click", o)); };
			const a = click("save"), b = click("help");
			return { notCancelled: [a, b], saved: w.saved || 0, helped: w.helped || 0, picks: pkItems().map(p => [p.n, p.tag, p.text, p.view]) };`);
		expect(picked).toEqual({ notCancelled: [false, false], saved: 0, helped: 0, picks: [[1, "button", "저장", "app:mydocs /apps/mydocs/"], [2, "a", "도움말", "app:mydocs /apps/mydocs/"]] });
		await waitOn(v, `document.querySelectorAll("#pick-marks .pk-mark:not([hidden])").length === 2 && document.querySelectorAll("#atray .pk-chip").length === 2`);
		const ui = await get(v, `return { marks: [...document.querySelectorAll("#pick-marks .pk-mark:not([hidden])")].map(m => m.textContent), chips: [...document.querySelectorAll("#atray .pk-chip .fi-n")].map(c => c.textContent) };`);
		expect(ui).toEqual({ marks: ["1", "2"], chips: ["저장", "도움말"] });
		await Bun.write(join(SHOTS, "picker-two-picks-1280.png"), await v.screenshot());
		expect(await chipsInChat(v, "picker-chips-1280.png")).toEqual(["1 저장", "2 도움말"]);
		await v.evaluate(`(go("apps", "mydocs"), 0)`);
		await waitOn(v, `document.querySelectorAll("#pick-marks .pk-mark:not([hidden])").length === 2`);

		// Cmd up hides the outline; a plain click then runs the app's own handler and picks nothing.
		const after = await get(v, `${FD} ${AT}
			w.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
			const hidden = document.querySelector("#pick-box").hidden;
			d.getElementById("save").dispatchEvent(new MouseEvent("click", at("save")));
			return { hidden, saved: w.saved || 0, picks: pkItems().length };`);
		expect(after).toEqual({ hidden: true, saved: 1, picks: 2 });
	}, 30_000);
});

describe("element picker at 390px (a phone)", () => {
	test("the hint says the long press; a short tap is the app's, a long press picks", async () => {
		const v = await open(390, 844, true);
		const head = await get(v, `const h = $("#apps-pane .pk-hint"), r = h.getBoundingClientRect(); return { hint: h.textContent, inView: r.width > 0 && r.right <= innerWidth && r.left >= 0, cut: h.scrollWidth > h.clientWidth + 1, button: document.querySelectorAll(".pk-toggle, #pick-pill").length };`);
		expect(head).toEqual({ hint: "길게 눌러 요소 고르기", inView: true, cut: false, button: 0 });
		await Bun.write(join(SHOTS, "picker-hint-390.png"), await v.screenshot());

		const touch = `${FD} ${AT}
			const tev = (type, id, list) => { const e = new Event(type, { bubbles: true, cancelable: true }); const p = at(id); Object.defineProperty(e, "touches", { value: list ? [p] : [] }); Object.defineProperty(e, "changedTouches", { value: [p] }); d.getElementById(id).dispatchEvent(e); return e.defaultPrevented; };`;
		// A short tap: touchstart, touchend at once. No pick.
		await v.evaluate(`(() => { ${touch} tev("touchstart", "intro", true); tev("touchend", "intro", false); return 0; })()`);
		await v.evaluate(`new Promise(r => setTimeout(r, 700))`);
		expect(await v.evaluate(`pkItems().length`)).toBe(0);
		// A long press on 저장: picked after the hold, and the end of the touch is cancelled so no click reaches 저장.
		await v.evaluate(`(() => { ${touch} tev("touchstart", "save", true); return 0; })()`);
		await waitOn(v, `pkItems().length === 1`, 2_000);
		const end = await get(v, `${touch} return { cancelled: tev("touchend", "save", false), saved: w.saved || 0, picks: pkItems().map(p => [p.n, p.tag, p.text]) };`);
		expect(end).toEqual({ cancelled: true, saved: 0, picks: [[1, "button", "저장"]] });
		await waitOn(v, `document.querySelectorAll("#pick-marks .pk-mark:not([hidden])").length === 1 && document.querySelectorAll("#atray .pk-chip").length === 1`);
		await Bun.write(join(SHOTS, "picker-long-press-390.png"), await v.screenshot());
		expect(await chipsInChat(v, "picker-chips-390.png")).toEqual(["1 저장"]);
	}, 30_000);
});
