import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on } from "./test-web.ts";

const server = { subscribed: false, subscribeCalls: 0, did: "" };
const hub = fakeHub({
	state: idleState(),
	api: async (req, url) => {
		if (url.pathname === "/api/push" && req.method === "GET") return json({ publicKey: "", kinds: [], subscribed: server.subscribed, prefs: {}, app: server.subscribed, did: server.did });
		if (url.pathname === "/api/push/gateways") return json({ app: false, gateways: [{ name: "", url: "", self: true, on: true, online: true }] });
		if (url.pathname === "/api/push/subscribe") { server.subscribed = true; server.subscribeCalls++; server.did = ((await req.json()) as { did: string }).did; return json({ ok: true }); }
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		return undefined;
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);

const ROW = `document.querySelector("#home-now [data-push-off]")`;
const boot = async (standalone: boolean, permission: "denied" | "default" | "granted") => {
	server.subscribed = false;
	server.subscribeCalls = 0;
	server.did = "";
	await view.navigate("about:blank");
	await view.navigate(`${hub.origin}/#home`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && S && current === "home" && $("#home-now").children.length`);
	await view.evaluate(`(Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true }), Object.defineProperty(navigator, "standalone", { value: ${standalone}, configurable: true }), Object.defineProperty(Notification, "permission", { get: () => window.__perm, configurable: true }), window.__perm = ${JSON.stringify(permission)}, localStorage.removeItem(PUSH_OFF), PWA.sub = null, PWA.info = null, PWA.reg = { pushManager: { subscribe: async () => ({ endpoint: "https://push.example/e1", toJSON() { return { endpoint: this.endpoint }; }, unsubscribe: async () => true }) } }, pushLoad(), 0)`);
	await waitFor(`PWA.info`);
};
const rowKind = () => view.evaluate(`(${ROW} || {}).dataset ? ${ROW}.dataset.pushOff : ""`);

describe("home push-off line", () => {

	test("installed app with notifications blocked: the line names it and its button opens the alert settings", async () => {
		await boot(true, "denied");
		await waitFor(`${ROW}`);
		expect(await rowKind()).toBe("blocked");
		expect(await view.evaluate(`${ROW} ? ${ROW}.textContent : ""`)).toContain("알림이 막혀 있어서");
		await view.evaluate(`${ROW}.querySelector("button").click()`);
		await waitFor(`current === "notifications"`);
	});

	test("installed app that was never asked: the button asks, and the line goes when the subscription is made", async () => {
		await boot(true, "default");
		await waitFor(`${ROW}`);
		expect(await rowKind()).toBe("ask");
		expect(await view.evaluate(`${ROW} ? ${ROW}.textContent : ""`)).toContain("알림 켜기");
		await view.evaluate(`(Notification.requestPermission = async () => (window.__perm = "granted"), PWA.info = { ...PWA.info, publicKey: "AAAA" }, ${ROW}.querySelector("button").click(), 0)`);
		await waitFor(`!${ROW} && PWA.sub && PWA.info.subscribed`);
		expect(server.subscribeCalls).toBe(1);
		expect(await view.evaluate(`current`)).toBe("home");
	});

	test("installed app with permission but no subscription: the line is there, and it goes once the subscription is back", async () => {
		await boot(true, "granted");
		await waitFor(`${ROW}`);
		expect(await rowKind()).toBe("resub");
		server.subscribed = true;
		await view.evaluate(`(PWA.sub = { endpoint: "https://push.example/e2", toJSON() { return { endpoint: this.endpoint }; } }, pushLoad(), 0)`);
		await waitFor(`!${ROW}`);
	});

	test("a browser tab (not installed) never shows it", async () => {
		await boot(false, "denied");
		expect(await rowKind()).toBe("");
		await view.evaluate(`(window.__perm = "default", renderHome(), 0)`);
		expect(await rowKind()).toBe("");
	});

	test("alerts the owner turned off in settings do not make the line", async () => {
		await boot(true, "granted");
		await waitFor(`${ROW}`);
		await view.evaluate(`(localStorage.setItem(PUSH_OFF, "1"), renderHome(), 0)`);
		expect(await rowKind()).toBe("");
	});
});
