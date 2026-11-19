import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { advance, flush } from "./runtime/test-clock.ts";
import { fakeHub, idleState, inbox, json, on } from "./test-web.ts";
import { i18nPrelude } from "./web-i18n.ts";

const WEB = join(import.meta.dir, "..", "web", "js");
const peers = readFileSync(join(WEB, "33-peers.js"), "utf8");
const app = readFileSync(join(WEB, "23-installable-app-web.js"), "utf8");
const hand = peers.slice(peers.indexOf("function prOrder"), peers.indexOf("// Frames this gateway forwards"));
const land = app.slice(app.indexOf("function pushAddr"), app.indexOf('if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", ev => {\n  const d = ev.data'));

type Peer = { name: string; url: string; self: boolean; online: boolean; public?: boolean };
type Addr = { pc: string; hash: string; at: string; nid: string; dec: string };
type Hop = { reason: string; href?: string };
const SELF: Peer = { name: "맥북", url: "https://mac:8443", self: true, online: true };
const MINI: Peer = { name: "맥미니", url: "https://mini:8445", self: false, online: true };
const AT = "2026-10-22T01:02:03.004Z";
const ADDR: Addr = { pc: MINI.url, hash: "#chat/lane:x", at: AT, nid: "n-1", dec: "d-7" };
const HOP = `https://mini:8445/?did=phone-device-0001&m=${encodeURIComponent(AT)}&i=n-1&n=d-7&hop=1#chat/lane:x`;

function peerPage(stored: Peer[], reachable = true) {
	const toasts: string[] = [], address: string[] = [], probes: string[] = [];
	let answer: (list: Peer[]) => void = () => {};
	const env: Record<string, unknown> = {
		lsJson: () => stored,
		localStorage: { setItem: () => {} },
		api: () => { const next = Promise.withResolvers<Peer[]>(); answer = next.resolve; return next.promise; },
		prPaint: () => {},
		DEVICE_ID: "phone-device-0001",
		toast: (m: string) => toasts.push(m),
		location: { href: "https://mac:8443/", pathname: "/", hash: "#home" },
		history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => address.push(url) },
		fetch: async (url: string) => { probes.push(url); if (!reachable) throw new TypeError("offline"); return {}; },
	};
	const api = new Function(...Object.keys(env), `${i18nPrelude()}${hand}\nreturn { prHandOver, prLoad };`)(...Object.values(env)) as { prHandOver: (a: Addr) => Promise<Hop>; prLoad: () => Promise<void> };
	return { ...api, toasts, address, probes, arrive: (list: Peer[]) => answer(list) };
}
const settled = async (p: Promise<unknown>) => { let done = false; void p.then(() => { done = true; }, () => { done = true; }); await flush(); return done; };

describe("a relayed tap hands over to the computer that owns the item", () => {
	test("a computer the stored list marks offline waits for the fresh list, then is handed the whole address", async () => {
		const page = peerPage([SELF, { ...MINI, online: false }]);
		const out = page.prHandOver(ADDR);
		void page.prLoad();
		expect(await settled(out)).toBe(false);
		expect(page.toasts).toEqual([]);
		page.arrive([SELF, MINI]);
		expect(await out).toEqual({ reason: "handed-over", href: HOP });
		expect(page.toasts).toEqual([]);
		expect(page.address).toEqual(["/#home"]);
	});

	test("a computer missing from the stored list is found in the fresh one", async () => {
		const page = peerPage([SELF]);
		const out = page.prHandOver(ADDR);
		void page.prLoad();
		page.arrive([SELF, MINI]);
		expect((await out).reason).toBe("handed-over");
	});

	test("a switch the owner pressed (a peer toast's 열기) is handed the address without the hop mark, so the other computer logs no push tap", async () => {
		const page = peerPage([SELF, MINI]);
		const out = page.prHandOver(ADDR, true);
		void page.prLoad();
		page.arrive([SELF, MINI]);
		expect(await out).toEqual({ reason: "handed-over", href: HOP.replace("&hop=1", "") });
	});

	test("a computer the fresh list still marks offline is tried first; one that does not answer is refused with a toast", async () => {
		const down = { ...MINI, online: false };
		const up = peerPage([SELF, down]);
		const opened = up.prHandOver(ADDR);
		void up.prLoad();
		up.arrive([SELF, down]);
		expect(await opened).toEqual({ reason: "handed-over", href: HOP });
		expect(up.probes).toEqual(["https://mini:8445/api/peer-info"]);

		const gone = peerPage([SELF, down], false);
		const refused = gone.prHandOver(ADDR);
		void gone.prLoad();
		gone.arrive([SELF, down]);
		expect(await refused).toEqual({ reason: "refused" });
		expect(gone.toasts).toEqual(["맥미니에 연결할 수 없어요"]);
		expect(gone.address).toEqual(["/#home"]);
	});

	test("an origin that is not one of this owner's computers is never followed", async () => {
		const page = peerPage([SELF, MINI]);
		const out = page.prHandOver({ ...ADDR, pc: "https://evil.example" });
		void page.prLoad();
		page.arrive([SELF, MINI]);
		expect(await out).toEqual({ reason: "unknown-computer" });
		expect(page.toasts).toEqual(["그 컴퓨터를 찾지 못했어요"]);
	});

	test("a public computer gets no device id, and a list that never arrives is decided on what was stored", async () => {
		const open = { ...MINI, url: "https://pub.example", public: true };
		const page = peerPage([SELF, open]);
		const out = page.prHandOver({ ...ADDR, pc: open.url, nid: "", dec: "" });
		expect(await settled(out)).toBe(false);
		await advance(8000);
		expect(await out).toEqual({ reason: "handed-over", href: `https://pub.example/?m=${encodeURIComponent(AT)}&hop=1#chat/lane:x` });
	});
});

function tapPage(origin: string) {
	const log: string[] = [];
	const env: Record<string, unknown> = {
		location: { href: `${origin}/`, origin, hash: "#home" },
		pushTapReport: (tap: { tag: string }, reason: string) => log.push(`report ${tap.tag} ${reason}`),
		pushTapCold: async (landing: Promise<string>) => void log.push(`cold ${await landing}`),
		prHandOver: async (a: Addr): Promise<Hop> => (a.pc === MINI.url ? { reason: "handed-over", href: "https://mini:8445/" } : { reason: "unknown-computer" }),
		prGo: (href: string) => log.push(`go ${href}`),
		noticeOpenId: async (id: string, quiet: boolean) => `decision ${id} ${quiet ? "quiet" : "tap"}`,
		pushOpen: async (_hash: string, at: string, nid: string) => `message ${at} ${nid}`,
		ovCloseAll: () => {},
		prFrameClose: () => {},
		parseHash: () => ({ view: "chat", t: "main" }),
		go: () => {},
	};
	const api = new Function(...Object.keys(env), `${land}\nreturn { pushAddr, pushLand };`)(...Object.values(env)) as { pushAddr: (href: string, m?: object) => Addr; pushLand: (a: Addr, via?: object) => Promise<string> };
	return { ...api, log };
}

describe("one receiver lands a tap, however it came", () => {
	test("the address reads the same from an own push's message and from a relayed push's link", () => {
		const { pushAddr } = tapPage("https://mac:8443");
		expect(pushAddr("https://mac:8443/#chat/main", { ts: AT, nid: "n-1", notice: "d-7" })).toEqual({ pc: "", hash: "#chat/main", at: AT, nid: "n-1", dec: "d-7" });
		expect(pushAddr(`/?pc=${encodeURIComponent(MINI.url)}&m=${encodeURIComponent(AT)}&i=n-1&n=d-7#chat/main`)).toEqual({ pc: MINI.url, hash: "#chat/main", at: AT, nid: "n-1", dec: "d-7" });
	});

	test("a tap for another computer reports what became of it before the page leaves, once; a refused one stays here", async () => {
		const away = tapPage("https://mac:8443");
		expect(await away.pushLand(ADDR, { tap: { tag: "mini:ask" } })).toBe("handed-over");
		expect(away.log).toEqual(["report mini:ask handed-over", "go https://mini:8445/"]);
		const unknown = tapPage("https://mac:8443");
		expect(await unknown.pushLand({ ...ADDR, pc: "https://evil.example" }, { tap: { tag: "mini:ask" } })).toBe("unknown-computer");
		expect(unknown.log).toEqual(["report mini:ask unknown-computer"]);
	});

	test("a decision id opens the decision, otherwise the message at its time", async () => {
		const here = tapPage("https://mac:8443");
		expect(await here.pushLand({ ...ADDR, pc: "" }, { tap: { tag: "t" } })).toBe("decision d-7 tap");
		expect(await here.pushLand({ ...ADDR, pc: "", dec: "" }, { tap: { tag: "t" } })).toBe(`message ${AT} n-1`);
		expect(here.log).toEqual(["report t decision d-7 tap", `report t message ${AT} n-1`]);
		const cold = tapPage("https://mac:8443");
		await cold.pushLand({ ...ADDR, pc: "", dec: "" }, { cold: true });
		expect(cold.log).toEqual([`cold message ${AT} n-1`]);
	});
});

const AT_ITEM = new Date(Date.UTC(2026, 9, 22, 1, 0, 30)).toISOString();
const ts = (i: number) => new Date(Date.UTC(2026, 9, 22, 1, 0, i)).toISOString();
const MAIN = Array.from({ length: 60 }, (_, i) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` }));
const NOTICES = [{ id: "n-30", kind: "message", cls: "conv", tone: "", read: false, title: "땃쥐", text: "내용", open: "main", src: "main", ts: ts(59), updated: ts(59), at: ts(59) }];
const taps = { mac: inbox<Record<string, string>>(), mini: inbox<Record<string, string>>() };
const second = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/push/tap") { taps.mini.push(await req.json() as Record<string, string>); return json({ ok: true }); }
		if (url.pathname === "/api/history") return json({ target: "main", events: MAIN.slice(-(Number(url.searchParams.get("limit")) || 60)) });
		if (url.pathname === "/api/notices") return json({ unread: 1, items: NOTICES });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
	},
});
const first = fakeHub({
	state: () => idleState(),
	api: async (req, url) => {
		if (url.pathname === "/api/push/tap") { taps.mac.push(await req.json() as Record<string, string>); return json({ ok: true }); }
		if (url.pathname === "/api/peers") return json([{ name: "맥북", url: first.origin, self: true, online: true }, { name: "맥미니", url: second.origin, self: false, online: false }, { name: "꺼진 컴퓨터", url: "http://127.0.0.1:1", self: false, online: false }]);
	},
});
afterAll(() => { first.stop(); second.stop(); });
beforeEach(() => { taps.mac.length = 0; taps.mini.length = 0; });

describe("the app starts on one computer at a relayed push's address", () => {
	test("it lands on that notice on the other computer, which reports where it landed once", async () => {
		const cold = `${first.origin}/?pc=${encodeURIComponent(second.origin)}&m=${encodeURIComponent(AT_ITEM)}&i=n-30#chat/main`;
		const view = await first.view({ width: 390, height: 844 }, "/");
		await on(view).waitFor(`PR.fresh`);
		await view.evaluate(`caches.open("dotz-share").then(c => c.put("/push/tap", new Response(JSON.stringify({ href: ${JSON.stringify(cold)}, at: Date.now(), path: "new-window", tag: "mini:ask", why: "no-window" }))))`);
		await view.navigate(cold);
		await taps.mini.until(l => l.length >= 1, 10_000, "the computer the tap landed on reports");
		expect(await on(view).ev(`[location.origin, target, tl.querySelector(".nt-hl").closest("[data-ts]").dataset.ts, PUSH_REPORTED]`)).toEqual([second.origin, "main", AT_ITEM, true]);
		expect(taps.mini).toEqual([{ tag: "", path: "open-window", why: "follow", screen: "chat:main", reason: "" }]);
		expect(taps.mac).toEqual([{ tag: "mini:ask", path: "new-window", why: "no-window", screen: "home", reason: "handed-over" }]);
		expect(await on(view).ev(`location.search`)).toBe("");
	});

	test.each([
		["a computer this owner does not have", "https://evil.example", "unknown-computer", "그 컴퓨터를 찾지 못했어요"],
		["a computer that is marked offline and does not answer", "http://127.0.0.1:1", "refused", "꺼진 컴퓨터에 연결할 수 없어요"],
	])("%s: the page stays on its own home with a clean address, says why, and reports it", async (_name, pc, reason, toast) => {
		const cold = `${first.origin}/?pc=${encodeURIComponent(pc)}&m=${encodeURIComponent(AT_ITEM)}&i=n-30#chat/lane:elsewhere`;
		const view = await first.view({ width: 390, height: 844 }, "/");
		await on(view).waitFor(`PR.fresh`);
		await view.evaluate(`caches.open("dotz-share").then(c => c.put("/push/tap", new Response(JSON.stringify({ href: ${JSON.stringify(cold)}, at: Date.now(), path: "new-window", tag: "mini:ask", why: "no-window" }))))`);
		await view.navigate(cold);
		await taps.mac.until(l => l.length >= 1, 10_000, "the page reports what became of the tap");
		await on(view).waitFor(`$(".snack")`);
		expect(await on(view).ev(`[current, location.search, location.hash, $(".snack").textContent]`)).toEqual(["home", "", "#home", toast]);
		expect(taps.mac).toEqual([{ tag: "mini:ask", path: "new-window", why: "no-window", screen: "home", reason }]);
	});
});

describe("the other computer's view in the installed app", () => {
	test("a hand-over adds no history entry and closes with its x button; a switch the owner pressed still takes one", async () => {
		const view = await first.view({ width: 390, height: 844 }, "/");
		const { run, waitFor, ev } = on(view);
		await run(`dispatchEvent(new Event("pointerup"));`);
		await waitFor(`PR.fresh && history.state && history.state.dz`);
		await run(`Object.defineProperty(navigator, "standalone", { value: true }); window.__len = history.length;`);
		await run(`prGo("about:blank", true);`);
		expect(await ev(`[history.length === window.__len, OV.length, !!document.querySelector(".pr-frame .pr-frame-x")]`)).toEqual([true, 0, true]);
		await run(`document.querySelector(".pr-frame-x").click();`);
		await waitFor(`!document.querySelector(".pr-frame")`);
		expect(await ev(`[history.length === window.__len, OV.length]`)).toEqual([true, 0]);
		await run(`prGo("about:blank");`);
		expect(await ev(`[history.length - window.__len, OV.length, !!document.querySelector(".pr-frame-x")]`)).toEqual([1, 1, false]);
	});

	test("the page answers the service worker's display-mode probe, so a tap is shown in the installed app's window", async () => {
		const view = await first.view({ width: 390, height: 844 }, "/");
		const { run, waitFor, ev } = on(view);
		await waitFor(`PR.fresh`);
		await run(`Object.defineProperty(navigator, "standalone", { value: true }); const c = new MessageChannel(); c.port1.onmessage = e => { window.__probe = e.data; }; navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { probe: "display-mode" }, ports: [c.port2] }));`);
		await waitFor(`window.__probe`);
		expect(await ev(`window.__probe`)).toEqual({ standalone: true });
	});
});
