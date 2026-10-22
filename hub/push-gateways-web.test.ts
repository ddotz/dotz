import { afterAll, expect, test } from "bun:test";
import { pushRoute, setRelayPeers } from "./push.ts";
import { appAsset, indexPage } from "./webapp.ts";

// Settings -> 앱 · 알림 for a device that has the app, at 390px: the real page and assets, served by this gateway (B) with its real /api/push routes;
// A is a fake gateway that keeps the device's switch the way hub/push.ts does. One row per gateway; the switch for A is set ON A (not by a browser
// subscription on A's origin); no description lines are drawn; the page never subscribes this origin's browser.
const SNAP = "/tmp/dotz-push-gateways-test";
const aOff = new Set<string>();
const aCalls: string[] = [];
const hubA = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname !== "/api/push/device") return new Response("no", { status: 404 });
		if (req.method === "GET") return Response.json({ on: !aOff.has(url.searchParams.get("did") ?? ""), app: true });
		const b = (await req.json()) as { did: string; on?: boolean };
		aCalls.push(`${req.method} on=${b.on}`);
		if (b.on === false) aOff.add(b.did);
		if (b.on === true) aOff.delete(b.did);
		return Response.json({ ok: true });
	},
});
const A = { name: "맥미니", url: `http://127.0.0.1:${hubA.port}` };
const posts: string[] = [];
let listReads = 0;
const hubB = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/state") return Response.json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/notices") return Response.json({ items: [], unread: 0 });
		if (url.pathname === "/api/peers") return Response.json([{ name: "맥북", url: `http://127.0.0.1:${hubB.port}`, self: true, online: true }, { ...A, self: false, online: true }]);
		if (url.pathname.startsWith("/api/push")) {
			if (req.method !== "GET") posts.push(`${req.method} ${url.pathname}`);
			if (req.method === "GET" && url.pathname === "/api/push/gateways") listReads++;
			return (await pushRoute(req, url)) ?? new Response("no", { status: 404 });
		}
		return url.pathname.startsWith("/api/") ? Response.json({ error: "not in this test" }, { status: 503 }) : new Response("not found", { status: 404 });
	},
});
setRelayPeers(async () => [{ name: "맥북", url: `http://127.0.0.1:${hubB.port}`, self: true }, { ...A, self: false }]);
const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { view.close(); hubA.stop(true); hubB.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const done = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); o.disconnect(); res(true); } }; const o = new MutationObserver(done); o.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }); done(); })`);

test("a device with the app sees one switch per gateway; flipping the other gateway's sets it there, and nothing subscribes this origin's browser", async () => {
	await Bun.$`mkdir -p ${SNAP}`.quiet();
	await view.navigate(`http://127.0.0.1:${hubB.port}/#settings`);
	await waitFor(`typeof pushLoad === "function" && typeof renderSettings === "function"`);
	await view.evaluate(`pushLoad()`);
	await waitFor(`PWA.gw && PWA.gw.gateways.length === 2`);
	await view.evaluate(`go("settings")`);
	const rows = `[...document.querySelectorAll('[role=switch][aria-label$="알림"]')]`;
	await waitFor(`${rows}.length === 2`);
	expect(await view.evaluate(`${rows}.map(b => b.getAttribute("aria-label") + ":" + b.getAttribute("aria-checked")).join("|")`)).toBe("맥미니 알림:true|맥북 알림:true");
	// no description lines under the section's items, and no button that would subscribe this browser
	expect(await view.evaluate(`(() => { const s = [...document.querySelectorAll(".sec")].find(x => x.textContent === "앱 · 알림"); const l = s.nextElementSibling; return [l.querySelectorAll(".sup").length, s.parentElement.querySelectorAll(".note").length, l.textContent.includes("알림 켜기")].join("/"); })()`)).toBe("0/0/false");
	expect(await view.evaluate(`document.documentElement.scrollWidth`)).toBeLessThanOrEqual(390);
	await view.evaluate(`document.querySelector('[role=switch][aria-label$="알림"]').closest(".list").scrollIntoView({ block: "center" })`);
	await Bun.write(`${SNAP}/settings-390.png`, await view.screenshot());

	const did = (await view.evaluate(`DEVICE_ID`)) as string;
	const readsBefore = listReads;
	await view.evaluate(`${rows}.find(b => b.getAttribute("aria-label") === "맥미니 알림").click()`);
	while (listReads === readsBefore) await Bun.sleep(10);
	await waitFor(`${rows}.find(b => b.getAttribute("aria-label") === "맥미니 알림").getAttribute("aria-checked") === "false"`);
	expect([...aOff]).toEqual([did]);
	expect(aCalls).toEqual(["POST on=false"]);
	expect(await view.evaluate(`${rows}.map(b => b.getAttribute("aria-checked")).join("|")`)).toBe("false|true");   // after the re-read from A's own record
	await Bun.write(`${SNAP}/settings-off-390.png`, await view.screenshot());

	await view.evaluate(`${rows}.find(b => b.getAttribute("aria-label") === "맥미니 알림").click()`);
	while (aCalls.length < 2) await Bun.sleep(10);
	await waitFor(`${rows}.every(b => b.getAttribute("aria-checked") === "true")`);
	expect(aOff.size).toBe(0);
	expect(aCalls).toEqual(["POST on=false", "POST on=true"]);
	expect(posts.filter(p => /subscribe|prefs/.test(p) && !/unsubscribe/.test(p))).toEqual([]);   // this origin's browser was never subscribed
});
