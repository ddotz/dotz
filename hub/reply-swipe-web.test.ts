import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appAsset, indexPage, webBuild } from "./webapp.ts";

// Swipe a message from right to left (touch) or press its hover button to reply to it: a quoted bar sits above the composer (x cancels it)
// and the send carries the quoted message (hub/intake.ts parseReply). Touch is driven with synthetic pointer events and synthetic touch
// events (the same drag logic); a real finger is a phone check.
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

// One touch drag on a message row: the start event at its right part (or at startX), then the moves, then the end event. Moves are
// [dx, dy] from the start; a negative dx is the finger moving left. via "touch" drives touchstart/touchmove/touchend instead of pointer events.
type Via = "pointer" | "touch";
const drag = (rid: string, moves: [number, number][], opts: { end?: "up" | "cancel"; startX?: number; via?: Via } = {}) =>
	view.evaluate(`(() => {
		const via = ${JSON.stringify(opts.via ?? "pointer")}, endKind = ${JSON.stringify(opts.end ?? "")};
		const row = document.querySelector('#tl [data-rid="${rid}"]'), r = row.getBoundingClientRect();
		const x0 = ${opts.startX ?? "null"} ?? r.right - 20, y0 = r.top + r.height / 2;
		const fire = (kind, x, y) => {
			if (via === "pointer") {
				const type = { down: "pointerdown", move: "pointermove", up: "pointerup", cancel: "pointercancel" }[kind];
				row.dispatchEvent(new PointerEvent(type, { pointerType: "touch", isPrimary: true, pointerId: 7, clientX: x, clientY: y, bubbles: true, cancelable: true }));
				return null;
			}
			const type = { down: "touchstart", move: "touchmove", up: "touchend", cancel: "touchcancel" }[kind];
			const t = { identifier: 3, clientX: x, clientY: y, target: row };
			const e = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperty(e, "touches", { value: kind === "up" || kind === "cancel" ? [] : [t] });
			Object.defineProperty(e, "changedTouches", { value: [t] });
			row.dispatchEvent(e);
			return e.defaultPrevented;
		};
		const prevented = [];
		fire("down", x0, y0);
		for (const [dx, dy] of ${JSON.stringify(moves)}) prevented.push(fire("move", x0 + dx, y0 + dy));
		window.__row = row; window.__fire = fire; window.__prevented = prevented; window.__end = [x0, y0, ${JSON.stringify(moves.at(-1) ?? [0, 0])}];
		if (endKind) fire(endKind, x0 + window.__end[2][0], y0 + window.__end[2][1]);
	})()`);
const endDrag = () => view.evaluate(`window.__fire("up", window.__end[0] + window.__end[2][0], window.__end[1] + window.__end[2][1])`);
const bar = () => ev<{ hidden: boolean; au: string; ct: string } | null>(`(() => { const b = document.querySelector("#replybar"); return b ? { hidden: b.hidden, au: b.querySelector(".rp-au").textContent, ct: b.querySelector(".rp-ct").textContent } : null; })()`);

describe("swipe to reply on a phone", () => {
	test("a swipe past the threshold shows the quoted bar above the composer; the row follows the finger and snaps back", async () => {
		await drag(BOT_TS, [[-20, 2], [-50, 3], [-75, 3]]);
		expect(await ev(`(() => { const r = window.__row; return { pull: r.classList.contains("rp-pull"), hit: r.classList.contains("rp-hit"), x: r.style.getPropertyValue("--rp-x"), ind: !!r.querySelector(".rp-ind") }; })()`)).toMatchObject({ pull: true, hit: true, ind: true });
		await endDrag();
		expect(await ev(`(() => { const r = window.__row; return { pull: r.classList.contains("rp-pull"), snap: r.classList.contains("rp-snap"), x: r.style.getPropertyValue("--rp-x"), ind: !!r.querySelector(".rp-ind") }; })()`)).toEqual({ pull: false, snap: true, x: "", ind: false });
		expect(await bar()).toEqual({ hidden: false, au: "dotz", ct: "내일 오전에 배포할게요" });
		expect(await ev(`document.activeElement === document.querySelector("#text")`)).toBe(true);
		expect(await ev(`(() => { const b = document.querySelector("#replybar").getBoundingClientRect(), s = document.querySelector("#send").getBoundingClientRect(); return b.bottom <= s.top + 1 && b.width > 200; })()`)).toBe(true);
	});

	test("under 60px, a vertical scroll, an edge start and a cancelled touch do not start a reply", async () => {
		await drag(OWNER.mid, [[-30, 1], [-50, 2]], { end: "up" });
		expect(await bar()).toBeNull();
		await drag(OWNER.mid, [[-3, 20], [-6, 60], [-90, 70]], { end: "up" });
		expect(await ev(`window.__row.classList.contains("rp-pull")`)).toBe(false);
		expect(await bar()).toBeNull();
		await drag(OWNER.mid, [[-40, 2], [-90, 2]], { end: "up", startX: 388 });
		expect(await bar()).toBeNull();
		await drag(OWNER.mid, [[-40, 2], [-90, 2]], { end: "cancel" });
		expect(await bar()).toBeNull();
		expect(await ev(`window.__row.style.getPropertyValue("--rp-x")`)).toBe("");
	});

	test("a left-to-right drag does not start a reply, and the row does not move", async () => {
		await drag(BOT_TS, [[20, 2], [60, 3], [90, 3]], { end: "up", startX: 40 });
		expect(await ev(`(() => { const r = window.__row; return { pull: r.classList.contains("rp-pull"), snap: r.classList.contains("rp-snap"), ind: !!r.querySelector(".rp-ind") }; })()`)).toEqual({ pull: false, snap: false, ind: false });
		expect(await bar()).toBeNull();
		await drag(BOT_TS, [[20, 2], [60, 3], [90, 3]], { end: "up", startX: 40, via: "touch" });
		expect(await bar()).toBeNull();
	});

	test("a right-edge start does not start a reply, a start 16px or more from the edge does", async () => {
		await drag(OWNER.mid, [[-40, 2], [-90, 2]], { end: "up", startX: 380 });
		expect(await bar()).toBeNull();
		await drag(OWNER.mid, [[-40, 2], [-90, 2]], { end: "up", startX: 360 });
		expect(await bar()).toEqual({ hidden: false, au: "나", ct: "배포는 언제 해요?" });
	});

	test("touch events: a right-to-left drag is cancelled once horizontal, moves the row left, shows the icon on the right and opens the bar", async () => {
		await drag(BOT_TS, [[-5, 1], [-30, 2], [-75, 3]], { via: "touch" });
		expect(await ev<boolean[]>(`window.__prevented`)).toEqual([false, true, true]);
		expect(await ev(`(() => { const r = window.__row, ind = r.querySelector(".rp-ind"); return { hit: r.classList.contains("rp-hit"), indRight: ind.getBoundingClientRect().left > r.getBoundingClientRect().left + r.getBoundingClientRect().width / 2 }; })()`)).toEqual({ hit: true, indRight: true });
		expect(await ev(`new DOMMatrix(getComputedStyle(window.__row).transform).m41 < 0`)).toBe(true);
		await endDrag();
		expect(await bar()).toEqual({ hidden: false, au: "dotz", ct: "내일 오전에 배포할게요" });
	});

	test("touch events: a vertical scroll is not cancelled and a short drag does not start a reply", async () => {
		await drag(OWNER.mid, [[-2, 20], [-4, 60]], { end: "up", via: "touch" });
		expect(await ev<boolean[]>(`window.__prevented`)).toEqual([false, false]);
		expect(await bar()).toBeNull();
		await drag(OWNER.mid, [[-30, 1], [-50, 2]], { end: "up", via: "touch" });
		expect(await bar()).toBeNull();
	});

	test("a touchstart takes over from the pointer events of the same finger (a pointercancel mid-drag does not end it)", async () => {
		await view.evaluate(`(() => {
			const row = document.querySelector('#tl [data-rid="m-owner-1"]'), r = row.getBoundingClientRect(), x0 = r.right - 20, y0 = r.top + r.height / 2;
			const pe = (type, x) => row.dispatchEvent(new PointerEvent(type, { pointerType: "touch", isPrimary: true, pointerId: 7, clientX: x, clientY: y0, bubbles: true, cancelable: true }));
			const te = (type, x, ts) => { const t = { identifier: 3, clientX: x, clientY: y0, target: row }; const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "touches", { value: ts ? [] : [t] }); Object.defineProperty(e, "changedTouches", { value: [t] }); row.dispatchEvent(e); };
			pe("pointerdown", x0); te("touchstart", x0);
			te("touchmove", x0 - 30); pe("pointermove", x0 - 30); te("touchmove", x0 - 80); pe("pointercancel", x0 - 80);
			te("touchend", x0 - 80, true);
		})()`);
		expect(await bar()).toEqual({ hidden: false, au: "나", ct: "배포는 언제 해요?" });
	});

	test("the x cancels the reply and the bar goes away", async () => {
		await drag(OWNER.mid, [[-30, 1], [-80, 2]], { end: "up" });
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
		await drag(BOT_TS, [[-30, 1], [-80, 2]], { end: "up" });
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

	// The button of an own (right-aligned) message sits left of the bubble, past a gap. It only shows on hover, so the pointer must be able to
	// reach it from the bubble without leaving the row: every point of the way hits the row, its gap bridge or the button, and a real click at
	// the (still hidden) button or at the gap opens the reply bar. (The WebKit view has no mouse-move input, so hover itself is a CSS rule.)
	// The page settles after a resize (scroll anchoring moves rows a frame later): measure only once two frames agree.
	const rectOf = async (sel: string) => {
		await view.evaluate(`new Promise(res => { let last = ""; let n = 0; const tick = () => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(), k = [r.left, r.top].join(); n = k === last ? n + 1 : 0; last = k; if (n >= 3) res(true); else requestAnimationFrame(tick); }; tick(); })`);
		return rectNow(sel);
	};
	const rectNow = (sel: string) => ev<{ l: number; r: number; t: number; b: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; })()`);
	const hitsRow = (rid: string, x: number, y: number) => ev<boolean>(`(() => { const e = document.elementFromPoint(${x}, ${y}); return !!e && !!e.closest('[data-rid="${rid}"]'); })()`);

	test("no point between an own message and its button leaves the row, and a real click on the hidden button or the gap opens the reply bar", async () => {
		await view.resize(1280, 800);
		const row = '#tl [data-rid="m-owner-1"]', btn = row + " > .rp-btn";
		const b = await rectOf(row), p = await rectOf(btn);
		const y = (p.t + p.b) / 2;
		expect(p.r).toBeLessThan(b.l);
		for (let x = Math.ceil(p.l); x <= b.l + 4; x++) expect(await hitsRow("m-owner-1", x, y)).toBe(true);
		expect(await ev(`getComputedStyle(document.querySelector(${JSON.stringify(btn)})).opacity`)).toBe("0");
		await view.click((p.l + p.r) / 2, y);
		expect(await bar()).toEqual({ hidden: false, au: "나", ct: "배포는 언제 해요?" });
		await view.evaluate(`rpClear()`);
		await view.click(p.r + 3, y);
		expect(await bar()).toEqual({ hidden: false, au: "나", ct: "배포는 언제 해요?" });
	});

	test("an assistant message's button is reachable from its text", async () => {
		await view.resize(1280, 800);
		const row = `#tl [data-rid="${BOT_TS}"]`, btn = row + " > .rp-btn";
		const p = await rectOf(btn);
		expect(await hitsRow(BOT_TS, (p.l + p.r) / 2, (p.t + p.b) / 2)).toBe(true);
		await view.click((p.l + p.r) / 2, (p.t + p.b) / 2);
		expect(await bar()).toEqual({ hidden: false, au: "dotz", ct: "내일 오전에 배포할게요" });
	});

	test("a button reached with the keyboard is shown", async () => {
		await view.resize(1280, 800);
		await view.evaluate(`document.querySelector('#tl [data-rid="m-owner-1"] > .rp-btn').focus()`);
		await view.press("Tab");
		await waitFor(`document.activeElement.matches(".rp-btn:focus-visible") && getComputedStyle(document.activeElement).opacity === "1"`);
	});
});

describe("tap on running work", () => {
	const WORK = { id: "st_x", description: "프로젝트 지우기", status: "running", started_at: Date.now(), target: "web" };
	test("a worker whose message is drawn jumps to it; one with no message ref opens its own detail and goes nowhere", async () => {
		await view.evaluate(`(window.__jumps = [], ts(MAIN).hLoaded = ts(MAIN).aLoaded = true, ntJump = a => window.__jumps.push(a))`);
		await view.evaluate(`workGo(${JSON.stringify({ ...WORK, reply_to: "m-owner-1" })})`);
		expect(await ev(`window.__jumps`)).toEqual([{ src: "main", at: "2026-10-22T01:00:00.000Z" }]);
		expect(await ev(`document.querySelector("#sheet").hidden`)).toBe(true);
		await view.evaluate(`workGo(${JSON.stringify(WORK)})`);
		await view.evaluate(`workGo(${JSON.stringify({ ...WORK, reply_to: "gone-msg" })})`);
		await waitFor(`!document.querySelector("#sheet").hidden`);
		expect(await ev(`document.querySelector("#sh-name").textContent`)).toBe("프로젝트 지우기");
		expect(await ev(`window.__jumps.length`)).toBe(1);
	});
});
