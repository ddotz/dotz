import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { deskPage } from "./remote-desktop.ts";
import { ev, fakeHub, idleState, json, run, waitFor, type View } from "./test-web.ts";

// The web side of the remote desktop (web/js/37-remote-desktop.js, features/remote-desktop/DESIGN.md Opening in Chrome and Web) in a headless
// page against the real app bundle. Only S.desk, the three /api/desk routes and the web access mode are faked; navigator.userAgentData and
// window.open are replaced in the page, because the test browser is neither Chrome nor able to open tabs.
type Call = { method: string; path: string; body?: any };
const calls: Call[] = [];
let desk: Record<string, unknown> | undefined;
let openReply: Record<string, unknown> = { action: "here" };
let webAccess: Record<string, unknown> = { mode: "tailscale", hostname: "", team: "", aud: "", tunnel: { state: "off" }, cloudflared_found: true };
const status = () => ({ available: true, allow_public: false, rebuilding: false, ...desk });

// The parts of voxl's page the viewer meets: its viewport tag, a surface sized like its layout() for a 1600x1000 desktop, and its way of
// listening, on the surface. `?touch` makes the page a touch-first device.
const VOXL_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<script>if (location.search.includes("touch")) matchMedia = () => ({ matches: true });</script>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}body{display:flex;align-items:center;justify-content:center}#surface{position:relative;touch-action:none}</style></head>
<body><div id="surface"></div><div id="tools"><button id="fs-btn">x</button></div><script>
const s = document.getElementById("surface"), k = Math.min(innerWidth / 1600, innerHeight / 1000);
s.style.width = 1600 * k + "px"; s.style.height = 1000 * k + "px";
window.got = [];
for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) s.addEventListener(t, e => got.push(t.slice(7) + e.pointerId));
</script></body></html>`;

const hub = fakeHub({
	state: () => idleState(desk ? { desk } : {}),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/desk/") return new Response(deskPage(VOXL_PAGE), { headers: { "content-type": "text/html; charset=utf-8" } });
		if (p === "/desk/viewer.js") return new Response(Bun.file(new URL("../features/remote-desktop/viewer.js", import.meta.url).pathname));
		if (p === "/api/web-access") return json(webAccess);
		if (!p.startsWith("/api/desk/") && p !== "/api/command") return undefined;
		const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
		calls.push({ method: req.method, path: p, body });
		if (p === "/api/desk/open") return json(openReply);
		if (p === "/api/desk/settings") { desk = { ...desk, ...body }; return json(status()); }
		if (p === "/api/desk/status") return json(status());
		return undefined;
	},
});
afterAll(() => hub.stop());
beforeEach(() => { calls.length = 0; openReply = { action: "here" }; desk = undefined; webAccess = { ...webAccess, mode: "tailscale" }; });

const ON = { on: true, running: false, viewers: [] };
const WATCHER = { who: "owner", device: "맥미니", since: "2026-11-04T01:00:00Z" };

const chromeUA = { brands: [{ brand: "Not.A/Brand", version: "99" }, { brand: "Chromium", version: "142" }, { brand: "Google Chrome", version: "142" }], mobile: false };
const asideUA = { brands: [{ brand: "Not.A/Brand", version: "99" }, { brand: "Chromium", version: "142" }], mobile: false };
const edgeUA = { brands: [{ brand: "Chromium", version: "142" }, { brand: "Microsoft Edge", version: "142" }], mobile: false };
const androidUA = { brands: [{ brand: "Chromium", version: "142" }, { brand: "Google Chrome", version: "142" }], mobile: true };

// A page with the real app loaded; `ua` replaces navigator.userAgentData (null = the browser has none, like Safari), and window.open records
// each call as __opens[] with a tab object whose close() and location.href the test reads back.
async function page(ua: object | null, state?: Record<string, unknown>): Promise<View> {
	desk = state;
	const v = await hub.view({ width: 1280, height: 800 });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, "S && S.name");
	if (state) await waitFor(v, "S.desk");
	await run(v, `Object.defineProperty(navigator, "userAgentData", { value: ${ua ? JSON.stringify(ua) : "undefined"}, configurable: true });
		window.__opens = []; window.__block = false;
		window.open = (u, t) => { const tab = { u, t, closed: false, href: "", opener: 1, location: { set href(x) { tab.href = x; } }, close() { this.closed = true; } }; window.__opens.push(tab); return window.__block ? null : tab; };`);
	return v;
}
const parse = async <T>(v: View, expr: string) => JSON.parse((await v.evaluate(expr)) as string) as T;

describe("deskIsChrome: real desktop Chrome by its brand", () => {
	test.each([
		["Chrome", chromeUA, true],
		["Aside (Chromium only)", asideUA, false],
		["Edge", edgeUA, false],
		["Safari (no userAgentData)", null, false],
		["Android Chrome", androidUA, false],
	] as const)("%s", async (_name, ua, want) => {
		const v = await page(ua);
		expect(await parse(v, `JSON.stringify(deskIsChrome())`)).toBe(want);
	});

	test("navigator.keyboard is not the test", async () => {
		const v = await page(asideUA);
		await run(v, `Object.defineProperty(navigator, "keyboard", { value: { lock() {} }, configurable: true });`);
		expect(await parse(v, `JSON.stringify([deskIsChrome(), !!navigator.keyboard.lock])`)).toEqual([false, true]);
	});

	test("a phone is told apart by the mobile flag", async () => {
		const v = await page(androidUA);
		expect(await parse(v, `JSON.stringify([deskIsPhone(), deskIsChrome()])`)).toEqual([true, false]);
		const d = await page(chromeUA);
		expect(await parse(d, `JSON.stringify(deskIsPhone())`)).toBe(false);
	});
});

type Outcome = { sync: number; opens: { u: string; t: string; closed: boolean; href: string }[]; snack: "" | "ok" | "bad" };
// Runs openScreen() the way a click does: `sync` is how many windows were opened before the answer came.
const click = (v: View) => parse<Outcome>(v, `(async () => {
	const p = openScreen(); const sync = window.__opens.length; await p;
	const s = document.querySelector(".snack");
	return JSON.stringify({ sync, opens: window.__opens.map(t => ({ u: t.u, t: t.t, closed: t.closed, href: t.href })), snack: s ? (s.classList.contains("bad") ? "bad" : "ok") : "" });
})()`);
const sentOpen = () => calls.filter(c => c.path === "/api/desk/open").map(c => c.body);

describe("openScreen", () => {
	test("another computer's one-time ticket goes into the tab, so the screen opens at once", async () => {
		openReply = { action: "here", go: "a".repeat(64) };
		const v = await page(null, ON);
		const r = await parse<Outcome>(v, `(async () => { await openScreen({ self: false, url: "https://mini.example", name: "맥미니" }); return JSON.stringify({ opens: window.__opens.map(t => ({ href: t.href })) }); })()`);
		expect(r.opens).toEqual([{ href: `https://mini.example/desk/?go=${"a".repeat(64)}` }] as Outcome["opens"]);
	});

	test("real Chrome waits for the answer, then opens /desk/ in a new tab", async () => {
		const v = await page(chromeUA, ON);
		const r = await click(v);
		expect(sentOpen()).toEqual([{ chrome: true, phone: false }]);
		expect(r.sync).toBe(0);
		expect(r.opens).toEqual([{ u: "/desk/", t: "_blank", closed: false, href: "" }]);
		expect(r.snack).toBe("");
	});

	test("real Chrome with a note on the answer opens and says the note", async () => {
		openReply = { action: "here", note: "단축키는 이 컴퓨터로 가요" };
		const v = await page(chromeUA, ON);
		const r = await click(v);
		expect(r.opens.map(o => o.u)).toEqual(["/desk/"]);
		expect(r.snack).toBe("ok");
	});

	test("real Chrome with a blocked answer opens nothing and says why", async () => {
		openReply = { action: "blocked", reason: "x" };
		const v = await page(chromeUA, ON);
		const r = await click(v);
		expect(r.opens).toEqual([]);
		expect(r.snack).toBe("bad");
	});

	test.each([["Aside", asideUA], ["Edge", edgeUA], ["Safari", null]] as const)("%s opens a blank tab inside the click and points it at /desk/ after the answer", async (_n, ua) => {
		const v = await page(ua, ON);
		const r = await click(v);
		expect(sentOpen()).toEqual([{ chrome: false, phone: false }]);
		expect(r.sync).toBe(1);
		expect(r.opens).toEqual([{ u: "", t: "_blank", closed: false, href: "/desk/" }]);
	});

	test("a blocked answer closes the blank tab", async () => {
		openReply = { action: "blocked", reason: "x" };
		const v = await page(asideUA, ON);
		const r = await click(v);
		expect(r.sync).toBe(1);
		expect(r.opens).toEqual([{ u: "", t: "_blank", closed: true, href: "" }]);
		expect(r.snack).toBe("bad");
	});

	test("an answer that the viewer's own Chrome opened closes the blank tab and confirms", async () => {
		openReply = { action: "opened", name: "맥북" };
		const v = await page(asideUA, ON);
		const r = await click(v);
		expect(r.opens).toEqual([{ u: "", t: "_blank", closed: true, href: "" }]);
		expect(r.snack).toBe("ok");
	});

	test("a failed request closes the blank tab", async () => {
		const v = await page(asideUA, ON);
		await run(v, `window.api = async () => { throw new Error("offline"); };`);
		const r = await click(v);
		expect(r.opens).toEqual([{ u: "", t: "_blank", closed: true, href: "" }]);
		expect(r.snack).toBe("bad");
	});

	test("a phone sends the phone flag", async () => {
		const v = await page(androidUA, ON);
		await click(v);
		expect(sentOpen()).toEqual([{ chrome: false, phone: true }]);
	});

	test("a browser that blocked the blank tab tries /desk/ itself and says so when that is blocked too", async () => {
		const v = await page(asideUA, ON);
		await run(v, `window.__block = true;`);
		const r = await click(v);
		expect(r.opens.map(o => o.u)).toEqual(["", "/desk/"]);
		expect(r.snack).toBe("bad");
	});

	test("a second click while one is in flight sends nothing more", async () => {
		const v = await page(chromeUA, ON);
		await run(v, `window.__two = Promise.all([openScreen(), openScreen()]);`);
		await v.evaluate(`window.__two.then(() => 1)`);
		expect(sentOpen().length).toBe(1);
	});
});

describe("entry points follow S.desk", () => {
	const typeInPalette = (v: View, q: string) => run(v, `openPalette(); const i = document.querySelector(".pal-in"); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input"));`);

	test("the palette lists the screen next to the terminal and it opens the screen", async () => {
		const v = await page(chromeUA, ON);
		await run(v, `window.__hit = []; openScreen = () => window.__hit.push("screen"); openShell = () => window.__hit.push("shell");`);
		await typeInPalette(v, "screen");
		expect(await parse(v, `JSON.stringify(document.querySelectorAll(".pal-list .pal-i").length)`)).toBe(1);
		await run(v, `document.querySelector(".pal-list .pal-i").click();`);
		expect(await parse(v, `JSON.stringify(window.__hit)`)).toEqual(["screen"]);
	});

	test("without S.desk the palette has no such entry", async () => {
		const v = await page(chromeUA);
		expect(await parse(v, `JSON.stringify(!!S.desk)`)).toBe(false);
		await typeInPalette(v, "screen");
		expect(await parse(v, `JSON.stringify(document.querySelectorAll(".pal-list .pal-i").length)`)).toBe(0);
	});

	test("/screen opens the screen and sends nothing to the gateway", async () => {
		const v = await page(chromeUA, ON);
		await run(v, `ta.value = "/screen"; sendChat();`);
		await waitFor(v, `window.__opens.length === 1`);
		await v.evaluate(`fetch("/api/state").then(r => r.status)`);
		expect(sentOpen().length).toBe(1);
		expect(calls.filter(c => c.path === "/api/command")).toEqual([]);
		expect(await parse(v, `JSON.stringify(ta.value)`)).toBe("");
	});

	test("/screen is in the composer menu only with S.desk", async () => {
		const hints = `Object.defineProperty(document, "activeElement", { get: () => ta, configurable: true }); ta.value = "/scr"; updateHints();`;
		const listed = `JSON.stringify(SL.items.map(i => i.x && i.x.c))`;
		const withDesk = await page(chromeUA, ON);
		await run(withDesk, hints);
		expect(await parse(withDesk, listed)).toEqual(["/screen"]);
		const without = await page(chromeUA);
		await run(without, hints);
		expect(await parse(without, listed)).toEqual([]);
	});

	test("/screen without S.desk is kept in the box and goes nowhere", async () => {
		const v = await page(chromeUA);
		await run(v, `ta.value = "/screen"; sendChat();`);
		await v.evaluate(`fetch("/api/state").then(r => r.status)`);
		expect(calls).toEqual([]);
		expect(await parse(v, `JSON.stringify([ta.value, window.__opens.length, !!document.querySelector(".snack.bad")])`)).toEqual(["/screen", 0, true]);
	});

	const SELF = { name: "맥미니", url: "https://mini.test", self: true, online: true };
	const OTHER = { name: "맥북", url: "https://book.test", self: false, online: true };
	const OFFLINE = { name: "서재", url: "https://den.test", self: false, online: false };
	const JANDI = { name: "work", url: "/#chat/relay:jandi:work", self: false, online: true, via: "jandi" };
	const sheet = async (v: View, list: object[]) => {
		await run(v, `PR.list = ${JSON.stringify(list)}; prOpen(); prLoad = () => {};`);
		await waitFor(v, `document.querySelector(".pr-sheet .pr-list")`);
	};
	const buttons = (v: View) => parse<(string | null)[]>(v, `JSON.stringify([...document.querySelectorAll(".pr-desk")].map(b => b.getAttribute("aria-label")))`);

	test("the computer list has one button per computer that can show a screen", async () => {
		const v = await page(chromeUA, ON);
		await sheet(v, [SELF, OTHER, OFFLINE, JANDI]);
		expect(await buttons(v)).toEqual(["맥미니 화면 보기", "맥북 화면 보기"]);
		await run(v, `window.__hit = []; openScreen = p => { window.__hit.push(p.name); }; document.querySelectorAll(".pr-desk")[1].click();`);
		expect(await parse(v, `JSON.stringify(window.__hit)`)).toEqual(["맥북"]);
	});

	test("a gateway without the feature still opens another computer's screen", async () => {
		const v = await page(chromeUA);
		await sheet(v, [SELF, OTHER]);
		expect(await buttons(v)).toEqual(["맥북 화면 보기"]);
	});

	test("another computer: the page asks its own gateway and opens that computer's address", async () => {
		const v = await page(asideUA);
		await run(v, `openScreen(${JSON.stringify(OTHER)});`);
		await waitFor(v, `window.__opens.length && window.__opens[0].href`);
		expect(calls.find(c => c.path === "/api/desk/open")?.body).toEqual({ chrome: false, phone: false, peer: OTHER.url });
		expect(await parse(v, `JSON.stringify(window.__opens[0].href)`)).toBe("https://book.test/desk/");
	});

	test("another computer that is off: the reason and the way there", async () => {
		const v = await page(chromeUA);
		openReply = { action: "blocked", reason: "맥북 설정에서 화면 공유를 켜 주세요", to: "#settings" };
		await run(v, `openScreen(${JSON.stringify(OTHER)});`);
		await waitFor(v, `document.querySelector(".snack.bad")`);
		expect(await parse(v, `JSON.stringify([document.querySelector(".snack.bad button").textContent, window.__opens.length])`)).toEqual(["맥북 열기", 0]);
	});

	test("this computer off: the button says so and the same tap turns it on", async () => {
		const v = await page(chromeUA, { ...ON, on: false });
		await run(v, `go("settings");`);
		await waitFor(v, `document.querySelector("[data-dsk=open] .btn")`);
		expect(await parse(v, `JSON.stringify(document.querySelector("[data-dsk=open] .btn").textContent)`)).toBe("켜고 보기");
		await run(v, `document.querySelector("[data-dsk=open] .btn").click();`);
		await waitFor(v, `window.__opens.length`);
		expect(calls.find(c => c.path === "/api/desk/open")?.body).toEqual({ chrome: true, phone: false, on: true });
		expect(await parse(v, `JSON.stringify(window.__opens[0].u)`)).toBe("/desk/");
	});
});

describe("app-bar pill", () => {
	const shown = (v: View) => parse<{ hidden: boolean; text: string }>(v, `JSON.stringify({ hidden: document.querySelector("#dsk-pill").hidden, text: document.querySelector("#dsk-pill").textContent })`);

	test("absent without viewers, and without S.desk", async () => {
		expect((await shown(await page(chromeUA, ON))).hidden).toBe(true);
		expect((await shown(await page(chromeUA))).hidden).toBe(true);
	});

	test("one viewer shows its device, several show the count, none removes it again", async () => {
		const v = await page(chromeUA, { ...ON, running: true, viewers: [WATCHER] });
		await waitFor(v, `!document.querySelector("#dsk-pill").hidden`);
		const one = await shown(v);
		expect(one.text).toContain(WATCHER.device);
		expect(await parse(v, `JSON.stringify(document.querySelector("#dsk-pill").classList.contains("pri"))`)).toBe(true);

		desk = { ...ON, running: true, viewers: [WATCHER, { who: "owner", device: "맥북", since: WATCHER.since }] };
		await run(v, `refreshState();`);
		await waitFor(v, `document.querySelector("#dsk-pill").textContent.includes("2")`);
		expect((await shown(v)).text).not.toContain(WATCHER.device);

		desk = { ...ON, viewers: [] };
		await run(v, `refreshState();`);
		await waitFor(v, `document.querySelector("#dsk-pill").hidden`);
	});

	test("a viewer without a device name shows who", async () => {
		const v = await page(chromeUA, { ...ON, viewers: [{ who: "owner@example.test", since: WATCHER.since }] });
		await waitFor(v, `!document.querySelector("#dsk-pill").hidden`);
		expect((await shown(v)).text).toContain("owner@example.test");
	});
});

describe("settings section", () => {
	const rows = (v: View) => parse<string[]>(v, `JSON.stringify([...document.querySelectorAll("[data-dsk]")].map(n => n.dataset.dsk))`);
	const openSettings = async (v: View) => { await run(v, `go("settings");`); await waitFor(v, `document.querySelector("#v-settings, .view:not([hidden]) .list")`); };

	test("absent without S.desk: no row and no section", async () => {
		const v = await page(chromeUA);
		await openSettings(v);
		await waitFor(v, `document.querySelector(".li.tap")`);
		expect(await rows(v)).toEqual([]);
	});

	test("on: the switch row alone while sharing is off", async () => {
		const v = await page(chromeUA, { ...ON, on: false });
		await openSettings(v);
		await waitFor(v, `document.querySelector("[data-dsk=on]")`);
		expect(await rows(v)).toEqual(["open", "on"]);
	});

	test("on: the button and the switch, nothing about viewers or control; the public address stays out unless web access is cloudflare", async () => {
		const v = await page(chromeUA, { ...ON, viewers: [WATCHER] });
		await openSettings(v);
		await waitFor(v, `document.querySelector("[data-dsk=on]")`);
		expect(await rows(v)).toEqual(["open", "on"]);
		expect(calls.filter(c => c.path === "/api/desk/status")).toEqual([]);
	});

	test("the public address row shows with cloudflare and flips allow_public", async () => {
		webAccess = { ...webAccess, mode: "cloudflare" };
		const v = await page(chromeUA, ON);
		await openSettings(v);
		await waitFor(v, `document.querySelector("[data-dsk=allow_public]")`);
		expect(await rows(v)).toEqual(["open", "on", "allow_public"]);
		await run(v, `document.querySelector("[data-dsk=allow_public] .hs-sw").click();`);
		await waitFor(v, `document.querySelector("[data-dsk=allow_public] .hs-sw").getAttribute("aria-checked") === "true"`);
		expect(calls.filter(c => c.path === "/api/desk/settings").map(c => [c.method, c.body])).toEqual([["PUT", { allow_public: true }]]);
	});

	test("the switch sends exactly its own field and follows the answer", async () => {
		const v = await page(chromeUA, ON);
		await openSettings(v);
		await waitFor(v, `document.querySelector("[data-dsk=on] .hs-sw")`);
		await run(v, `document.querySelector("[data-dsk=on] .hs-sw").click();`);
		await waitFor(v, `document.querySelector("[data-dsk=on] .hs-sw").getAttribute("aria-checked") === "false"`);
		expect(calls.filter(c => c.path === "/api/desk/settings").map(c => c.body)).toEqual([{ on: false }]);
		expect(await rows(v)).toEqual(["open", "on"]);
		expect(await parse(v, `JSON.stringify(S.desk.on)`)).toBe(false);
	});
});

describe("the viewer in voxl's page", () => {
	type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
	const rect = (v: View) => ev<Rect>(v, `document.getElementById("surface").getBoundingClientRect()`);
	const viewer = async (width: number, height: number, query = "") => {
		const v = await hub.view({ width, height }, `/desk/${query}`);
		await waitFor(v, `document.getElementById("surface").style.transform`);
		await run(v, `window.touch = (type, id, x, y, on) => (on || document.getElementById("surface")).dispatchEvent(new PointerEvent("pointer" + type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, cancelable: true }));`);
		return v;
	};
	const touch = (v: View, ...moves: [string, number, number, number][]) => run(v, moves.map(m => `touch(${m.map(x => JSON.stringify(x)).join(",")});`).join(""));
	const got = (v: View) => ev<string[]>(v, "got");

	test("the page allows zoom and reaches under the notch", async () => {
		const v = await viewer(412, 915);
		expect(await v.evaluate(`document.querySelector("meta[name=viewport]").content`)).toBe("width=device-width,initial-scale=1,viewport-fit=cover");
	});

	test("the one-time ticket leaves the address bar", async () => {
		const v = await viewer(412, 915, "?go=abc&touch=1");
		expect(await v.evaluate("location.search")).toBe("?touch=1");
	});

	test.each([[412, 915], [915, 412]])("a touch screen of %ix%i is filled, nothing black, and the shape stays", async (w, h) => {
		const v = await viewer(w, h, "?touch");
		const r = await rect(v);
		expect(r.left).toBeLessThanOrEqual(0.1);
		expect(r.top).toBeLessThanOrEqual(0.1);
		expect(r.right).toBeGreaterThanOrEqual(w - 0.1);
		expect(r.bottom).toBeGreaterThanOrEqual(h - 0.1);
		expect(r.width / r.height).toBeCloseTo(1.6, 1);
		expect(r.left + r.right).toBeCloseTo(w, 0);
		expect(r.top + r.bottom).toBeCloseTo(h, 0);
	});

	test("a mouse gets the whole screen: it has no way to pan", async () => {
		const v = await viewer(1280, 700);
		const r = await rect(v);
		expect(r.height).toBeCloseTo(700, 0);
		expect(r.left).toBeCloseTo((1280 - r.width) / 2, 0);
		expect(r.top).toBeCloseTo(0, 0);
	});

	test("two fingers zoom and pan the view; voxl sees the first finger cancelled and nothing else", async () => {
		const v = await viewer(412, 915, "?touch");
		const was = await rect(v);
		await touch(v, ["down", 1, 150, 400], ["down", 2, 250, 400], ["move", 1, 100, 400], ["move", 2, 300, 400]);
		const big = await rect(v);
		expect(big.width / was.width).toBeCloseTo(2, 1);
		expect((200 - big.left) / big.width).toBeCloseTo((200 - was.left) / was.width, 1);
		await touch(v, ["move", 1, 40, 400], ["move", 2, 240, 400]);
		expect((await rect(v)).left).toBeCloseTo(big.left - 60, 0);
		await touch(v, ["up", 1, 40, 400], ["up", 2, 240, 400]);
		expect(await got(v)).toEqual(["down1", "cancel1"]);
	});

	test("a pinch out ends at the whole screen, and the edges stop the pan", async () => {
		const v = await viewer(412, 915, "?touch");
		await touch(v, ["down", 1, 100, 400], ["down", 2, 300, 400], ["move", 1, 195, 400], ["move", 2, 205, 400], ["move", 1, 199, 400], ["move", 2, 201, 400]);
		const r = await rect(v);
		expect(r.width).toBeCloseTo(412, 0);
		expect(r.top).toBeCloseTo((915 - r.height) / 2, 0);
		const f = await viewer(412, 915, "?touch");
		await touch(f, ["down", 1, 100, 400], ["down", 2, 200, 400], ["move", 1, 9100, 400], ["move", 2, 9200, 400]);
		expect((await rect(f)).left).toBe(0);
	});

	test("one finger stays voxl's, also right after a pinch", async () => {
		const v = await viewer(412, 915, "?touch");
		const before = await rect(v);
		await touch(v, ["down", 1, 100, 400], ["move", 1, 120, 400], ["up", 1, 120, 400]);
		expect(await got(v)).toEqual(["down1", "move1", "up1"]);
		expect(await rect(v)).toEqual(before);
		await touch(v, ["down", 1, 100, 400], ["down", 2, 200, 400], ["up", 1, 100, 400], ["up", 2, 200, 400], ["down", 3, 50, 50], ["up", 3, 50, 50]);
		expect((await got(v)).slice(-4)).toEqual(["down1", "cancel1", "down3", "up3"]);
	});

	test("the toolbar is not a finger on the screen", async () => {
		const v = await viewer(412, 915, "?touch");
		await run(v, `window.b = document.getElementById("fs-btn"); touch("down", 1, 400, 900, b); touch("down", 2, 200, 400); touch("up", 1, 400, 900, b); touch("up", 2, 200, 400);`);
		expect(await got(v)).toEqual(["down2", "up2"]);
	});

	test("the first touch asks for fullscreen once; a refusal is quiet", async () => {
		const v = await viewer(412, 915, "?touch");
		await run(v, `window.asked = 0; window.bad = 0; addEventListener("unhandledrejection", () => bad++); document.documentElement.requestFullscreen = () => (asked++, Promise.reject(new TypeError("refused")));`);
		await run(v, `touch("up", 9, 400, 900, document.getElementById("fs-btn"));`);
		expect(await ev(v, "asked")).toBe(0);
		await touch(v, ["down", 1, 100, 400], ["up", 1, 100, 400], ["down", 1, 100, 400], ["up", 1, 100, 400]);
		expect(await ev(v, "asked")).toBe(1);
		await v.evaluate("new Promise(r => setTimeout(r))");
		expect(await ev(v, "bad")).toBe(0);
	});

	test("a browser without fullscreen (iPhone Safari) carries on", async () => {
		const v = await viewer(412, 915, "?touch");
		await run(v, `document.documentElement.requestFullscreen = undefined;`);
		await touch(v, ["down", 1, 100, 400], ["up", 1, 100, 400]);
		expect(await got(v)).toEqual(["down1", "up1"]);
	});
});
