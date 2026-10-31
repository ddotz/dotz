import { afterAll, expect, test } from "bun:test";
import { pushRoute, setRelayPeers } from "./push.ts";
import { fakeHub, inbox, json, on } from "./test-web.ts";

// Settings -> 앱 · 알림 for a device that has the app, at 390px: the real page and assets, served by this gateway (B) with its real /api/push routes;
// A is a fake gateway that keeps the device's switch the way hub/push.ts does. One row per gateway; the switch for A is set ON A (not by a browser
// subscription on A's origin); no description lines are drawn; the page never subscribes this origin's browser.
const aOff = new Set<string>();
const aCalls = inbox<string>();
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
const listReads = inbox<string>();
const hubB = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		if (url.pathname === "/api/peers") return json([{ name: "맥북", url: hubB.origin, self: true, online: true }, { ...A, self: false, online: true }]);
		if (url.pathname.startsWith("/api/push")) {
			if (req.method !== "GET") posts.push(`${req.method} ${url.pathname}`);
			if (req.method === "GET" && url.pathname === "/api/push/gateways") listReads.push(url.pathname);
			return (await pushRoute(req, url)) ?? new Response("no", { status: 404 });
		}
		if (url.pathname.startsWith("/api/") && url.pathname !== "/api/state" && url.pathname !== "/api/events") return json({ error: "not in this test" }, 503);
	},
});
setRelayPeers(async () => [{ name: "맥북", url: hubB.origin, self: true }, { ...A, self: false }]);
const view = await hubB.view({ width: 390, height: 844 });
afterAll(() => { hubA.stop(true); hubB.stop(); });
const { waitFor } = on(view);

test("a device with the app sees one switch per gateway; flipping the other gateway's sets it there, and nothing subscribes this origin's browser", async () => {
	await view.navigate(`${hubB.origin}/#settings`);
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

	const did = (await view.evaluate(`DEVICE_ID`)) as string;
	const readsBefore = listReads.length;
	await view.evaluate(`${rows}.find(b => b.getAttribute("aria-label") === "맥미니 알림").click()`);
	await listReads.until(r => r.length > readsBefore, 10_000, "list re-read");
	await waitFor(`${rows}.find(b => b.getAttribute("aria-label") === "맥미니 알림").getAttribute("aria-checked") === "false"`);
	expect([...aOff]).toEqual([did]);
	expect(aCalls).toEqual(["POST on=false"]);
	expect(await view.evaluate(`${rows}.map(b => b.getAttribute("aria-checked")).join("|")`)).toBe("false|true");   // after the re-read from A's own record

	await view.evaluate(`${rows}.find(b => b.getAttribute("aria-label") === "맥미니 알림").click()`);
	await aCalls.until(c => c.length >= 2, 10_000, "second POST");
	await waitFor(`${rows}.every(b => b.getAttribute("aria-checked") === "true")`);
	expect(aOff.size).toBe(0);
	expect(aCalls).toEqual(["POST on=false", "POST on=true"]);
	expect(posts.filter(p => /subscribe|prefs/.test(p) && !/unsubscribe/.test(p))).toEqual([]);   // this origin's browser was never subscribed
});
