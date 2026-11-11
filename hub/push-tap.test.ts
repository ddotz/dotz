// A tap on a phone notification must land on its item, or leave a line in the gateway log saying why not: which window the worker hands the tap to,
// what happens when that window never answers, the one-line records of a send and of a landing, and the page's side (web/js/23-installable-app-web.js).
import { afterAll, describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";
import { notify, pushRoute, setRelayPeers } from "./push.ts";
import { fakeHub, inbox, json, on } from "./test-web.ts";
import { b64u } from "./webpush.ts";

const ORIGIN = "https://dotz.test";
type Win = { url: string; focused?: boolean; visibilityState?: string; focus: () => Promise<void>; postMessage: (m: Record<string, unknown>, ports?: MessagePort[]) => void };

// web/sw.js as shipped with its platform stubbed and a fake clock: the timer the worker sets for a window's answer is fired by the test.
function worker(wins: Win[]) {
	const on: Record<string, (ev: unknown) => void> = {}, opened: string[] = [], kept: Array<Record<string, unknown>> = [];
	const timers: Array<() => void> = [];
	const self = {
		addEventListener: (k: string, f: (ev: unknown) => void) => void (on[k] = f),
		clients: { matchAll: async () => wins, openWindow: async (u: string) => void opened.push(u) },
		registration: { getNotifications: async () => [], pushManager: { getSubscription: async () => null } },
	};
	const caches = { open: async () => ({ put: async (_k: string, r: Response) => void kept.push(await r.json()) }) };
	const fakeSetTimeout = (fn: () => void) => timers.push(fn);
	new Function("self", "location", "caches", "setTimeout", "clearTimeout", readFileSync(join(import.meta.dir, "..", "web", "sw.js"), "utf8"))(self, new URL(ORIGIN), caches, fakeSetTimeout, () => {});
	return {
		opened,
		kept,
		// The tap on a notification; resolves when the worker is done with it. `ring` runs once the window has been handed the message.
		async tap(data: object, ring?: () => Promise<void> | void) {
			let done!: Promise<unknown>;
			on.notificationclick!({ notification: { close: () => {}, tag: "answer", data }, action: "", waitUntil: (p: Promise<unknown>) => void (done = p) });
			await ring?.();
			await done;
		},
		fire: () => void timers.splice(0).forEach(f => f()),
	};
}
// A window that records what it was handed and answers (or not) on the port that came with it.
function win(url: string, answers: boolean, extra: Partial<Win> = {}) {
	const got: Array<Record<string, unknown>> = [];
	let arrived!: () => void;
	const arrival = new Promise<void>(r => (arrived = r));
	const w: Win = { url, focus: async () => {}, postMessage: (m, ports) => { got.push(m); if (answers) ports?.[0]?.postMessage(1); arrived(); }, ...extra };
	return { w, got, arrival };
}
const data = { url: "/#chat/main", ts: "2026-10-20T01:00:05.000Z", nid: "n1" };
const COLD = `${ORIGIN}/?m=${encodeURIComponent(data.ts)}&i=n1#chat/main`;

describe("the worker hands a tap to the app's own window", () => {
	test("a user app's window of the same origin is not the app: the tap goes to the app window, or opens one", async () => {
		const userApp = win(`${ORIGIN}/apps/todo/`, true), app = win(`${ORIGIN}/#home`, true);
		const sw = worker([userApp.w, app.w]);
		await sw.tap(data);
		expect(userApp.got).toEqual([]);
		expect(app.got).toMatchObject([{ open: `${ORIGIN}/#chat/main`, ts: data.ts, nid: "n1", tap: { path: "open-window", tag: "answer" } }]);
		expect(sw.opened).toEqual([]);
		const only = worker([win(`${ORIGIN}/apps/todo/`, true).w]);
		await only.tap(data);
		expect(only.opened).toEqual([COLD]);
		expect(only.kept[0]).toMatchObject({ href: COLD, path: "new-window", why: "no-window", tag: "answer" });
	});

	test("a window that never answers is replaced by one opened at the item once the wait is over", async () => {
		const silent = win(`${ORIGIN}/#home`, false), sw = worker([silent.w]);
		await sw.tap(data, async () => {
			await silent.arrival;
			expect(sw.opened).toEqual([]);   // still waiting for it
			sw.fire();
		});
		expect(sw.opened).toEqual([COLD]);
		expect(sw.kept[0]).toMatchObject({ path: "new-window", why: "no-ack" });
	});

	test("a window that refuses focus is replaced too, and says why", async () => {
		const sw = worker([win(`${ORIGIN}/#home`, true, { focus: async () => { throw new TypeError("not allowed"); } }).w]);
		await sw.tap(data);
		expect(sw.kept[0]).toMatchObject({ path: "new-window", why: "focus-refused" });
	});
});

describe("the gateway log", () => {
	const lines = (tag: string) => readFileSync(paths.log, "utf8").split("\n").filter(l => l.includes(tag));

	test("a send leaves one line: tag, kind, address and how many devices, never the title or body", async () => {
		const ua = createECDH("prime256v1");
		ua.generateKeys();
		setRelayPeers(async () => []);
		const sub = { subscription: { endpoint: "https://push.example.net/tap-log", keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 9)) } } };
		await pushRoute(new Request("http://x/api/push/subscribe", { method: "POST", body: JSON.stringify(sub) }), new URL("http://x/api/push/subscribe"));
		const real = globalThis.fetch;
		globalThis.fetch = (async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
		try {
			await notify({ kind: "result", title: "비밀 제목", body: "비밀 내용", url: "/#chat/lane:a", tag: "lane:tap-log-a", ts: "2026-10-20T01:00:05.000Z", nid: "n9" });
		} finally {
			globalThis.fetch = real;
			await pushRoute(new Request("http://x/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.subscription.endpoint }) }), new URL("http://x/api/push/unsubscribe"));
		}
		const sent = lines("lane:tap-log-a");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/push: sent tag=lane:tap-log-a kind=result to=\/#chat\/lane:a ts=\S+ nid=n9 devices=[1-9]\d*$/);
		expect(readFileSync(paths.log, "utf8")).not.toContain("비밀");
	});

	test("a landing report leaves one line with the way in, the screen and the reason", async () => {
		const post = (b: object) => pushRoute(new Request("http://x/api/push/tap", { method: "POST", body: JSON.stringify(b) }), new URL("http://x/api/push/tap"));
		expect((await post({ tag: "answer:tap-log-b", path: "new-window", why: "no-ack", screen: "chat:main", reason: "no-message" }))!.status).toBe(200);
		expect((await post({ tag: "x", path: "elsewhere" }))!.status).toBe(400);
		const got = lines("answer:tap-log-b");
		expect(got).toHaveLength(1);
		expect(got[0]).toMatch(/push: tap tag=answer:tap-log-b path=new-window via=no-ack screen=chat:main reason=no-message$/);
	});
});

describe("the page", () => {
	const reports = inbox<Record<string, string>>();
	const hub = fakeHub({
		api: async (req, url) => {
			if (url.pathname === "/api/push/tap") { reports.push(await req.json()); return json({ ok: true }); }
			if (url.pathname === "/api/history") return json({ target: "main", events: [] });
		},
	});
	afterAll(() => hub.stop());
	const MISSING = "2026-10-20T01:00:09.000Z";

	test("a tap handed to an open page is answered on its port and reported with the screen it reached", async () => {
		const view = await hub.view({ width: 390, height: 844 }, "/#home");
		const { waitFor, run } = on(view);
		await waitFor(`typeof pushTapReport === "function" && current === "home"`);
		reports.length = 0;
		await run(`window.__got = false; const ch = new MessageChannel(); ch.port1.onmessage = () => { window.__got = true; };
			navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { open: location.origin + "/#settings", tap: { path: "open-window", tag: "alert" } }, ports: [ch.port2] }));`);
		await waitFor(`window.__got`);
		await reports.until(r => r.length === 1, 10_000, "landing report");
		expect(reports[0]).toMatchObject({ tag: "alert", path: "open-window", screen: "settings" });
	});

	test("a message the page cannot find is reported with the reason, not dropped", async () => {
		const view = await hub.view({ width: 390, height: 844 }, "/#home");
		const { waitFor, run } = on(view);
		await waitFor(`typeof pushTapReport === "function" && current === "home"`);
		reports.length = 0;
		await run(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { open: location.origin + "/#chat/main", ts: ${JSON.stringify(MISSING)}, tap: { path: "open-window", tag: "answer" } } }));`);
		await reports.until(r => r.length === 1, 10_000, "landing report");
		expect(reports[0]).toMatchObject({ tag: "answer", path: "open-window", screen: "chat:main" });
		expect(reports[0]!.reason).toMatch(/message/);
	});

	test("a page started by a tap reports it, also when the same address was tapped before", async () => {
		const href = `${hub.origin}/?m=${encodeURIComponent(MISSING)}#chat/main`;
		const view = await hub.view({ width: 390, height: 844 }, "/#home");
		const { waitFor, run } = on(view);
		await waitFor(`typeof pushTapReport === "function"`);
		const seed = () => run(`caches.open("dotz-share").then(c => c.put("/push/tap", new Response(JSON.stringify({ href: ${JSON.stringify(href)}, at: Date.now(), path: "new-window", why: "no-window", tag: "answer" }))));`);
		for (let i = 0; i < 2; i++) {
			reports.length = 0;
			await seed();
			await view.navigate(href);
			await reports.until(r => r.length >= 1, 10_000, `landing report ${i + 1}`);
			expect(reports[0]).toMatchObject({ tag: "answer", path: "new-window", why: "no-window" });
			expect(reports[0]!.reason).toMatch(/message/);
		}
	});
});
