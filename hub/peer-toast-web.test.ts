import { afterAll, expect, test } from "bun:test";
import { fakeHub, inbox, json, on } from "./test-web.ts";
import { startPeerStreams } from "./peer-stream.ts";
import { advance } from "./runtime/test-clock.ts";

// Two simulated hubs and one page at 390px: the page is served by B (the real web assets and the real event stream); A is a fake gateway whose
// stream B's hub follows. A new notice on A must toast in B's page once, named for A, update A's numbers on the computer chip, and a tap must hand
// the page over to A's origin at the item (?n=).
const aOpen = inbox<string>();
const aRoot = inbox<string>();
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
		if (pathname === "/") return new Response("<!doctype html><title>A home</title><script>fetch(\"/loaded\")</script>", { headers: { "Content-Type": "text/html" } });
		if (pathname === "/loaded") { aRoot.push(pathname); return new Response("ok"); }
		if (pathname !== "/api/events") return new Response("no", { status: 404 });
		let ctl!: ReadableStreamDefaultController<string>;
		return new Response(new ReadableStream<string>({
			start(c) { ctl = c; aStreams.add(c); c.enqueue("event: reset\ndata: {}\n\n"); aOpen.push(pathname); },
			cancel() { aStreams.delete(ctl); },
		}), { headers: { "Content-Type": "text/event-stream" } });
	},
});
const A = { name: "맥미니", url: `http://127.0.0.1:${hubA.port}`, self: false };

const hubB = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		if (url.pathname === "/api/peers") return json([{ name: "맥북", url: hubB.origin, self: true, online: true }, { name: A.name, url: A.url, self: false, online: true, unread: 0, need: 0 }]);
	},
});

let pumping = true;
// the peer stream's debounce and backoff timers run on the fake clock: move it on every turn of the event loop
void (async () => { while (pumping) { await new Promise<void>(r => setImmediate(r)); await advance(25); } })();
const stop = startPeerStreams({ computers: async () => [A], countsDebounceMs: 10, backoffMs: [20] });
const view = await hubB.view({ width: 390, height: 844 });
afterAll(() => { pumping = false; stop(); hubA.stop(true); hubB.stop(); });
const { waitFor } = on(view);

const decision = (id: string) => ({ id, kind: "decision", tone: "ask", title: "배포할까요?", read: false, at: `at-${id}`, decision: { state: "open", reply_to: `at-${id}`, to: "main", options: [] } });

test("in 모니터링 a notice on the other computer toasts once on this page, labeled with it; the chip counts follow; the tap opens the item on that computer", async () => {
	const pageStream = hubB.nextStream();
	await view.navigate(`${hubB.origin}/`);
	await waitFor(`!document.querySelector("#pchip").hidden`);
	await pageStream;   // the page hears this hub's stream before anything is sent
	await view.evaluate(`(go("monitoring"), 0)`);   // outside 모니터링 only the chip's dot speaks for the other computer
	await aOpen.until(o => o.length >= 1, 10_000, "A stream opened");

	aList = { unread: 1, items: [decision("d1")] };
	sendA({ kind: "notice", item: decision("d1"), unread: 1 });
	await waitFor(`document.querySelector(".snack")`);
	sendA({ kind: "notice", item: decision("d1"), unread: 1 });
	sendA({ kind: "notice", item: { id: "t1", kind: "alert", tone: "ask", title: "배포할까요?", read: false, at: "at-d1" }, unread: 2 });
	await waitFor(`PR.list.find(p => !p.self).need === 1 && document.querySelector(".pc-d.need")`);
	expect(await view.evaluate(`document.querySelectorAll(".snack").length`)).toBe(1);
	const text = (await view.evaluate(`document.querySelector(".snack").textContent`)) as string;
	expect(text).toContain("맥미니");
	expect(text).toContain("답변이 필요해요");
	expect(await view.evaluate(`JSON.stringify(PR.list.find(p => !p.self))`)).toContain('"unread":1');
	expect(await view.evaluate(`document.documentElement.scrollWidth`)).toBeLessThanOrEqual(390);

	await view.evaluate(`document.querySelector(".snack .sa").click()`);
	await aRoot.until(r => r.length >= 1, 10_000, "page opened A");
	const to = new URL(view.url);
	expect(to.origin).toBe(A.url);
	expect(to.searchParams.get("n")).toBe("d1");
	expect(to.searchParams.get("did")).toBeTruthy();
}, 20_000);

test("answered over there, its toast here goes away; a conversation this page just acted in does not toast (frames as hub/peer-stream.ts forwards them)", async () => {
	const pageStream = hubB.nextStream();
	await view.navigate(`${hubB.origin}/`);
	await waitFor(`!document.querySelector("#pchip").hidden`);
	await pageStream;
	const frame = (id: string, to: string) => JSON.stringify({ kind: "peer_notice", peer: { name: A.name, url: A.url }, id, key: `at-${id}`, notice: "decision", tone: "ask", title: `보낼까요 ${id}`, to });
	await view.evaluate(`(() => { window.__toasts = []; const real = toast; toast = (m, ...a) => { window.__toasts.push(m); return real(m, ...a); }; })(), 0`);
	// 홈 (any tab but 모니터링) is this computer's alone: the other computer's question does not toast there
	await view.evaluate(`(go("home"), prLive(${frame("d1h", "main")}), 0)`);
	expect(await view.evaluate(`window.__toasts.some(m => m.includes("보낼까요 d1h"))`)).toBe(false);
	await view.evaluate(`(go("monitoring"), 0)`);
	await view.evaluate(`(prLive(${frame("d2", "mail:k9")}), 0)`);
	await waitFor(`[...document.querySelectorAll(".snack")].some(s => s.dataset.peerNid === "d2")`);
	await view.evaluate(`(prLive({ kind: "peer_notice_done", url: ${JSON.stringify(A.url)}, ids: ["d2"] }), 0)`);
	await waitFor(`![...document.querySelectorAll(".snack")].some(s => s.dataset.peerNid === "d2")`);

	await view.evaluate(`(prActed("mail:k8"), prLive(${frame("d3", "mail:k8")}), prLive(${frame("d4", "mail:k7")}), 0)`);
	await waitFor(`window.__toasts.some(m => m.includes("보낼까요 d4"))`);
	expect(await view.evaluate(`window.__toasts.some(m => m.includes("보낼까요 d3"))`)).toBe(false);
}, 20_000);
