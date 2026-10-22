import { afterAll, expect, test } from "bun:test";
import { emit, sseResponse } from "./events.ts";
import { startPeerStreams } from "./peer-stream.ts";
import { advance } from "./runtime/test-clock.ts";
import { appAsset, indexPage } from "./webapp.ts";

// Two simulated hubs and one page at 390px: the page is served by B (the real web assets and the real event stream); A is a fake gateway whose
// stream B's hub follows. A new notice on A must toast in B's page once, named for A, update A's numbers on the computer chip, and a tap must hand
// the page over to A's origin at the item (?n=).
const SNAP = "/tmp/dotz-peer-toast-test";
const aStreams = new Set<ReadableStreamDefaultController<string>>();
let aList: { unread: number; items: object[] } = { unread: 0, items: [] };
const sendA = (e: object) => { for (const c of aStreams) c.enqueue(`data: ${JSON.stringify(e)}\n\n`); };
const hubA = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === "/api/notices") return Response.json(aList);
		if (pathname === "/") return new Response("<!doctype html><title>A home</title>", { headers: { "Content-Type": "text/html" } });
		if (pathname !== "/api/events") return new Response("no", { status: 404 });
		let ctl!: ReadableStreamDefaultController<string>;
		return new Response(new ReadableStream<string>({
			start(c) { ctl = c; aStreams.add(c); c.enqueue("event: reset\ndata: {}\n\n"); },
			cancel() { aStreams.delete(ctl); },
		}), { headers: { "Content-Type": "text/event-stream" } });
	},
});
const A = { name: "맥미니", url: `http://127.0.0.1:${hubA.port}`, self: false };

const json = (v: unknown) => Response.json(v);
const hubB = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		if (url.pathname === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${hubB.port}`, self: true, online: true }, { name: A.name, url: A.url, self: false, online: true, unread: 0, need: 0 }]);
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

let pumping = true;
void (async () => { while (pumping) { await Bun.sleep(10); await advance(25); } })();
const stop = startPeerStreams({ computers: async () => [A], countsDebounceMs: 10, backoffMs: [20] });
const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { pumping = false; stop(); view.close(); hubA.stop(true); hubB.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const done = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); o.disconnect(); res(true); } }; const o = new MutationObserver(done); o.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }); done(); })`);
const decision = (id: string) => ({ id, kind: "decision", tone: "ask", title: "배포할까요?", read: false, at: `at-${id}`, decision: { state: "open", reply_to: `at-${id}`, to: "main", options: [] } });

test("a notice on the other computer toasts once on this page, labeled with it; the chip counts follow; the tap opens the item on that computer", async () => {
	await Bun.$`mkdir -p ${SNAP}`.quiet();
	await view.navigate(`http://127.0.0.1:${hubB.port}/`);
	await waitFor(`!document.querySelector("#pchip").hidden`);
	while (aStreams.size < 1) await Bun.sleep(10);

	aList = { unread: 1, items: [decision("d1")] };
	sendA({ kind: "notice", item: decision("d1"), unread: 1 });
	await waitFor(`document.querySelector(".snack")`);
	sendA({ kind: "notice", item: decision("d1"), unread: 1 });
	sendA({ kind: "notice", item: { id: "t1", kind: "alert", tone: "ask", title: "배포할까요?", read: false, at: "at-d1" }, unread: 2 });
	await waitFor(`PR.list.find(p => !p.self).need === 1 && document.querySelector(".pc-d.need")`);
	await Bun.sleep(150);
	expect(await view.evaluate(`document.querySelectorAll(".snack").length`)).toBe(1);
	const text = (await view.evaluate(`document.querySelector(".snack").textContent`)) as string;
	expect(text).toContain("맥미니");
	expect(text).toContain("답변이 필요해요");
	expect(await view.evaluate(`JSON.stringify(PR.list.find(p => !p.self))`)).toContain('"unread":1');
	expect(await view.evaluate(`document.documentElement.scrollWidth`)).toBeLessThanOrEqual(390);
	await Bun.write(`${SNAP}/toast-390.png`, await view.screenshot());

	aList = { unread: 0, items: [] };
	sendA({ kind: "notice_read", ids: ["d1", "t1"], unread: 0 });
	await waitFor(`PR.list.find(p => !p.self).need === 0 && !document.querySelector(".pc-d")`);

	await view.evaluate(`document.querySelector(".snack .sa").click()`);
	for (let i = 0; i < 300 && !view.url.startsWith(A.url); i++) await Bun.sleep(20);
	const to = new URL(view.url);
	expect(to.origin).toBe(A.url);
	expect(to.searchParams.get("n")).toBe("d1");
	expect(to.searchParams.get("did")).toBeTruthy();
});
