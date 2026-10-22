import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appAsset, indexPage, webBuild } from "./webapp.ts";

// Swipe a message sideways (touch) or press its hover button to reply to it: a quoted bar sits above the composer (x cancels it) and the send
// carries the quoted message (hub/intake.ts parseReply). Touch is driven with synthetic pointer events; a real finger is a phone check.
const enc = new TextEncoder();
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const send = (e: object) => { for (const c of streams) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); };
const posted: Record<string, any>[] = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === "/") return indexPage(req);
		if (pathname === "/sw.js") return new Response("no", { status: 404 });
		const asset = appAsset(req, pathname);
		if (asset) return asset;
		if (pathname === "/api/state") return Response.json({ name: "dotz", web_build: webBuild(), orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (pathname === "/api/message") { posted.push(await req.json()); return Response.json({ ok: true }); }
		if (pathname === "/api/events") {
			let ctl!: ReadableStreamDefaultController<Uint8Array>;
			return new Response(new ReadableStream<Uint8Array>({
				start(c) { ctl = c; streams.add(c); c.enqueue(enc.encode("event: reset\ndata: {}\n\n")); },
				cancel() { streams.delete(ctl); },
			}), { headers: { "Content-Type": "text/event-stream" } });
		}
		return pathname.startsWith("/api/") ? Response.json({}) : new Response("not found", { status: 404 });
	},
});
const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { view.close(); server.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else setTimeout(tick, 20); }; tick(); })`);
const ev = async <T>(expr: string) => JSON.parse((await view.evaluate(`JSON.stringify(${expr})`)) as string) as T;

const OWNER = { kind: "message", source: "web", channel: "web", mid: "m-owner-1", author: "me", text: "배포는 언제 해요?" };
const BOT = { kind: "out", target: "web", source: "orchestrator", text: "내일 오전에 배포할게요" };
const BOT_TS = "2026-10-22T01:00:01.000Z";

beforeEach(async () => {
	posted.length = 0;
	await view.resize(390, 844);
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`typeof S === "object" && S && S.web_build`);
	while (streams.size < 1) await Bun.sleep(10);
	await view.evaluate(`go("chat", "main")`);
	await waitFor(`!document.querySelector("#v-chat").hidden`);
	send({ ...OWNER, ts: "2026-10-22T01:00:00.000Z" });
	send({ ...BOT, ts: BOT_TS });
	await waitFor(`document.querySelector('#tl [data-rid="m-owner-1"]') && document.querySelector('#tl [data-rid="${BOT_TS}"]')`);
});

// One touch drag on a message row: pointerdown at its centre (or at startX), then the moves, then the end event.
const drag = (rid: string, moves: [number, number][], opts: { end?: "pointerup" | "pointercancel"; startX?: number } = {}) =>
	view.evaluate(`(() => {
		const row = document.querySelector('#tl [data-rid="${rid}"]'), r = row.getBoundingClientRect();
		const x0 = ${opts.startX ?? "null"} ?? r.left + 20, y0 = r.top + r.height / 2;
		const fire = (type, x, y) => row.dispatchEvent(new PointerEvent(type, { pointerType: "touch", isPrimary: true, pointerId: 7, clientX: x, clientY: y, bubbles: true, cancelable: true }));
		fire("pointerdown", x0, y0);
		for (const [dx, dy] of ${JSON.stringify(moves)}) fire("pointermove", x0 + dx, y0 + dy);
		window.__row = row; window.__fire = fire; window.__end = [x0, y0, ${JSON.stringify(moves.at(-1) ?? [0, 0])}];
		if (${JSON.stringify(opts.end ?? "")}) fire(${JSON.stringify(opts.end ?? "")}, x0 + window.__end[2][0], y0 + window.__end[2][1]);
	})()`);
const endDrag = () => view.evaluate(`window.__fire("pointerup", window.__end[0] + window.__end[2][0], window.__end[1] + window.__end[2][1])`);
const bar = () => ev<{ hidden: boolean; au: string; ct: string } | null>(`(() => { const b = document.querySelector("#replybar"); return b ? { hidden: b.hidden, au: b.querySelector(".rp-au").textContent, ct: b.querySelector(".rp-ct").textContent } : null; })()`);

describe("swipe to reply on a phone", () => {
	test("a swipe past the threshold shows the quoted bar above the composer; the row follows the finger and snaps back", async () => {
		await drag(BOT_TS, [[20, 2], [50, 3], [75, 3]]);
		expect(await ev(`(() => { const r = window.__row; return { pull: r.classList.contains("rp-pull"), hit: r.classList.contains("rp-hit"), x: r.style.getPropertyValue("--rp-x"), ind: !!r.querySelector(".rp-ind") }; })()`)).toMatchObject({ pull: true, hit: true, ind: true });
		await endDrag();
		expect(await ev(`(() => { const r = window.__row; return { pull: r.classList.contains("rp-pull"), snap: r.classList.contains("rp-snap"), x: r.style.getPropertyValue("--rp-x"), ind: !!r.querySelector(".rp-ind") }; })()`)).toEqual({ pull: false, snap: true, x: "", ind: false });
		expect(await bar()).toEqual({ hidden: false, au: "dotz", ct: "내일 오전에 배포할게요" });
		expect(await ev(`document.activeElement === document.querySelector("#text")`)).toBe(true);
		expect(await ev(`(() => { const b = document.querySelector("#replybar").getBoundingClientRect(), s = document.querySelector("#send").getBoundingClientRect(); return b.bottom <= s.top + 1 && b.width > 200; })()`)).toBe(true);
	});

	test("under 60px, a vertical scroll, an edge start and a cancelled touch do not start a reply", async () => {
		await drag(OWNER.mid, [[30, 1], [50, 2]], { end: "pointerup" });
		expect(await bar()).toBeNull();
		await drag(OWNER.mid, [[3, 20], [6, 60], [90, 70]], { end: "pointerup" });
		expect(await ev(`window.__row.classList.contains("rp-pull")`)).toBe(false);
		expect(await bar()).toBeNull();
		await drag(OWNER.mid, [[40, 2], [90, 2]], { end: "pointerup", startX: 10 });
		expect(await bar()).toBeNull();
		await drag(OWNER.mid, [[40, 2], [90, 2]], { end: "pointercancel" });
		expect(await bar()).toBeNull();
		expect(await ev(`window.__row.style.getPropertyValue("--rp-x")`)).toBe("");
	});

	test("the x cancels the reply and the bar goes away", async () => {
		await drag(OWNER.mid, [[30, 1], [80, 2]], { end: "pointerup" });
		expect(await bar()).toEqual({ hidden: false, au: "나", ct: "배포는 언제 해요?" });
		await view.click("#replybar .rp-x");
		expect((await bar())?.hidden).toBe(true);
		await view.type("그냥 보낼게요");
		await view.evaluate(`document.querySelector("#send-btn").click()`);
		while (!posted.length) await Bun.sleep(10);
		expect(posted[0].text).toBe("그냥 보낼게요");
		expect(posted[0].reply).toBeUndefined();
	});

	test("sending carries the quoted message (id, author, text), clears the bar, and the sent bubble shows the quote", async () => {
		await drag(BOT_TS, [[30, 1], [80, 2]], { end: "pointerup" });
		await view.type("그럼 오늘은 테스트만요");
		await view.evaluate(`document.querySelector("#send-btn").click()`);
		while (!posted.length) await Bun.sleep(10);
		expect(posted[0]).toMatchObject({ text: "그럼 오늘은 테스트만요", reply: { id: BOT_TS, author: "dotz", content: "내일 오전에 배포할게요" } });
		expect((await bar())?.hidden).toBe(true);
		await view.evaluate(`document.querySelector("#text").value = "다음 메시지"`);
		await view.evaluate(`document.querySelector("#send-btn").click()`);
		while (posted.length < 2) await Bun.sleep(10);
		expect(posted[1].reply).toBeUndefined();
		send({ kind: "message", source: "web", channel: "web", mid: "m-owner-2", author: "me", text: "그럼 오늘은 테스트만요", ts: "2026-10-22T01:00:05.000Z", reply: { id: BOT_TS, author: "dotz", content: "내일 오전에 배포할게요" } });
		await waitFor(`document.querySelector('#tl [data-rid="m-owner-2"] .rpq')`);
		expect(await ev(`document.querySelector('#tl [data-rid="m-owner-2"] .rpq-ct').textContent`)).toBe("내일 오전에 배포할게요");
	});
});

describe("reply button on desktop", () => {
	test("the hover button on a message starts the same reply, and the bar follows the page layout", async () => {
		await view.resize(1280, 800);
		expect(await ev(`document.querySelectorAll("#tl [data-rid] > .rp-btn").length`)).toBe(2);
		await view.evaluate(`document.querySelector('#tl [data-rid="m-owner-1"] > .rp-btn').click()`);
		expect(await bar()).toEqual({ hidden: false, au: "나", ct: "배포는 언제 해요?" });
		await view.type("네 알겠어요");
		await view.evaluate(`document.querySelector("#send-btn").click()`);
		while (!posted.length) await Bun.sleep(10);
		expect(posted[0]).toMatchObject({ text: "네 알겠어요", reply: { id: "m-owner-1", author: "", content: "배포는 언제 해요?" } });
	});
});
