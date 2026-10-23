import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// 모니터링 > 앱 > 카카오톡 (web/js/30-kakao.js): the room choice, the chosen rooms as conversation rows and the per-room chat, run as shipped in a headless
// browser (Bun.WebView) against a stubbed /api/kakao/* (docs/kakao-rooms-api.md). Names and texts are placeholders. Screenshots are written only when KAKAO_SHOTS names a folder.
const SHOTS = process.env.KAKAO_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

type Msg = { logId: string; authorId: string; sender: string; text: string; type: number; sentAt: number; fromMe: boolean; unread: number; media?: Record<string, unknown> };
type Room = { chatId: string; name: string; kind: string; watched: boolean; autoDraft: boolean; unread: number; lastAt: number };
type Draft = { code: string; text: string; basisLogId: string; created: number };
type Send = { id: string; text: string; state: string; reason?: string; at: number };
type Req = { method: string; path: string; body: Record<string, unknown> | null };

const at = (d: number, h: number, m: number, s = 0) => Date.UTC(2026, 9, d, h, m, s);
const who = { 가나: { authorId: "u1", sender: "가나" }, 다라: { authorId: "u2", sender: "다라" }, me: { authorId: "me", sender: "나" } };
// KakaoTalk's read counters (members who have not read the message yet) of a few messages; everything else is read by all (0).
const UNREAD: Record<string, number> = { "3001": 2, "3002": 2, "3003": 1, "3007": 1 };
const mk = (logId: string, w: keyof typeof who, text: string, sentAt: number, type = 1, media?: Record<string, unknown>): Msg => ({ logId, ...who[w], text, type, sentAt, fromMe: w === "me", unread: UNREAD[logId] ?? 0, ...(media ? { media } : {}) });
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
const OLD = Array.from({ length: 30 }, (_, i) => mk(String(2001 + i), i % 3 === 2 ? "me" : "가나", `예전 대화 ${i}`, at(20, 1, i * 2)));
const MID = [
	mk("3001", "가나", "안녕하세요 가나다 모임입니다", at(21, 3, 0)),
	mk("3002", "가나", "오늘 모임은 일곱 시예요", at(21, 3, 0, 20)),
	mk("3003", "me", "네 알겠어요", at(21, 3, 2)),
	mk("3004", "다라", "", at(21, 3, 5), 2),
	mk("3005", "다라", "", at(21, 3, 6), 20),
	mk("3006", "가나", "<b>굵게</b> & <img src=x onerror=alert(1)> 그대로 보여야 해요", at(21, 3, 8)),
	mk("3007", "가나", "아주긴문장".repeat(40), at(21, 3, 9)),
];
const FRESH = Array.from({ length: 30 }, (_, i) => mk(String(4001 + i), "다라", `새 메시지 ${i}`, at(22, 1, i)));
const DRAFTS = (): Draft[] => [
	{ code: "d1", text: "초안 하나예요", basisLogId: "4030", created: at(22, 2, 0) },
	{ code: "d2", text: "초안 둘이에요", basisLogId: "4030", created: at(22, 2, 1) },
	{ code: "d3", text: "초안 셋이에요", basisLogId: "4030", created: at(22, 2, 2) },
];
const ROOMS = (): Room[] => [
	{ chatId: "100", name: "가나다 모임", kind: "group", watched: true, autoDraft: false, unread: 30, lastAt: at(22, 1, 29) },
	{ chatId: "200", name: "사아자 방", kind: "group", watched: false, autoDraft: false, unread: 0, lastAt: at(19, 5, 0) },
	{ chatId: "300", name: "라마바", kind: "direct", watched: true, autoDraft: false, unread: 0, lastAt: at(21, 5, 0) },
];

let rooms = ROOMS(), msgs: Msg[] = [], drafts: Draft[] = [], sends: Send[] = [], roomsAnswer: Record<string, unknown> | null = null;
let ask: { question: string; choices: string[] } | null = null;
let reqs: Req[] = [];
let waiters: { pred: (r: Req) => boolean; res: (r: Req) => void }[] = [];
const reset = () => { rooms = ROOMS(); msgs = [...OLD, ...MID, ...FRESH]; drafts = DRAFTS(); sends = []; roomsAnswer = null; ask = null; reqs = []; waiters = []; };
const record = (r: Req) => { reqs.push(r); waiters = waiters.filter(w => (w.pred(r) ? (w.res(r), false) : true)); };
const expectReq = (pred: (r: Req) => boolean, ms = 3500): Promise<Req> => {
	const have = reqs.find(pred);
	if (have) return Promise.resolve(have);
	return new Promise((res, rej) => {
		const t = setTimeout(() => rej(new Error(`no matching request; got ${JSON.stringify(reqs.map(r => `${r.method} ${r.path}`))}`)), ms);
		waiters.push({ pred, res: r => { clearTimeout(t); res(r); } });
	});
};
const isReq = (method: string, path: string) => (r: Req) => r.method === method && r.path === path;

const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let streamWaiters: (() => void)[] = [];
const te = new TextEncoder();
const emit = (e: object) => {
	for (const c of streams) {
		try { c.enqueue(te.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { streams.delete(c); }
	}
};
const streamOpen = () => new Promise<void>(r => streamWaiters.push(r));

const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") {
			let ctl: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({
				start(c) { ctl = c; streams.add(c); c.enqueue(te.encode(": open\n\n")); const w = streamWaiters; streamWaiters = []; for (const f of w) f(); },
				cancel() { streams.delete(ctl); },
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
		}
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/integrations") return json({ items: [{ key: "kakao", label: "카카오톡", icon: "chat", kind: "app", conv: [], notices: [], needs: { drafts: drafts.length, unread: 30, sentToday: 0 } }] });
		if (p === "/api/kakao/rooms") return json(roomsAnswer ?? { on: true, rooms });
		const media = /^\/api\/kakao\/media\/(\w+)\/(\w+)(\/file)?$/.exec(p);
		if (media) {
			record({ method: "GET", path: `${p}${url.search}`, body: null });
			if (media[2] === "5008") return json({ error: "기간이 지나 볼 수 없어요" }, 410);
			return new Response(PNG, { headers: { "Content-Type": "image/png" } });
		}
		const body = req.method === "GET" ? null : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
		const m = /^\/api\/kakao\/rooms\/(\w+)$/.exec(p);
		if (m && req.method === "PUT") {
			record({ method: "PUT", path: p, body });
			const r = rooms.find(x => x.chatId === m[1]);
			if (r) { if ("watched" in body!) r.watched = !!body!.watched; if ("autoDraft" in body!) r.autoDraft = !!body!.autoDraft; }
			return json({ ok: true, watched: rooms.filter(x => x.watched).map(x => x.chatId) });
		}
		const ad = /^\/api\/kakao\/chat\/(\w+)\/ask\/drop$/.exec(p);
		if (ad && req.method === "POST") { record({ method: "POST", path: p, body }); ask = null; return json({ ok: true }); }
		const c = /^\/api\/kakao\/chat\/(\w+)(?:\/(reads?|send|draft))?$/.exec(p);
		if (c) {
			const room = rooms.find(x => x.chatId === c[1]);
			if (!room || !room.watched) return json({ error: "지켜보는 대화방이 아니에요" }, 403);
			if (c[2] === "reads" && req.method === "GET") {
				record({ method: "GET", path: `${p}${url.search}`, body: null });
				const from = BigInt(url.searchParams.get("from") ?? "0");
				return json({ counts: Object.fromEntries(msgs.filter(x => BigInt(x.logId) >= from).map(x => [x.logId, x.unread])) });
			}
			if (req.method === "GET") {
				record({ method: "GET", path: `${p}${url.search}`, body: null });
				const after = url.searchParams.get("after");
				const sorted = [...msgs].sort((a, b) => (BigInt(a.logId) > BigInt(b.logId) ? 1 : -1)), lim = Number(url.searchParams.get("limit") ?? 80);
				const list = after ? sorted.filter(x => BigInt(x.logId) > BigInt(after)).slice(0, lim) : sorted.slice(-lim);
				return json({ room: { chatId: room.chatId, name: room.name, kind: room.kind, group: room.kind === "group" }, messages: list, read: after ? undefined : "3007", kakaoUnread: 30, drafts, sends, ...(ask ? { ask } : {}) });
			}
			record({ method: "POST", path: p, body });
			if (c[2] === "draft" && typeof body!.choice === "string") {
				ask = null;
				drafts = [{ code: "dp", text: `답장: ${body!.choice}`, basisLogId: "4033", created: Date.now() }];
				emit({ kind: "kakao_draft", chatId: c[1] });
				return json({ state: "drafting" }, 202);
			}
			if (c[2] === "read") room.unread = 0;
			if (c[2] === "send") { const s = { id: `s${sends.length + 1}`, text: String(body!.text), state: "sending", at: Date.now() }; sends.push(s); return json({ id: s.id, state: "sending" }, 202); }
			return json({ ok: true });
		}
		const d = /^\/api\/kakao\/drafts\/(\w+)\/(send|drop)$/.exec(p);
		if (d && req.method === "POST") {
			record({ method: "POST", path: p, body });
			drafts = drafts.filter(x => x.code !== d[1]);
			if (d[2] === "send") { const s = { id: `s${sends.length + 1}`, text: String(body!.text ?? "초안"), state: "sending", at: Date.now() }; sends.push(s); return json({ id: s.id, state: "sending" }, 202); }
			return json({ ok: true });
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = (width: number, height: number): View => { const v = new Bun.WebView({ width, height }); views.push(v); return v; };
afterAll(() => { for (const v of views) v.close(); for (const c of streams) { try { c.close(); } catch { /* already closed */ } } server.stop(true); });
beforeEach(reset);

const waitFor = (v: View, expr: string, ms = 3500) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const boot = async (v: View) => {
	const opened = streamOpen();
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await light(v);
	await run(v, `go("monitoring", "i:kakao")`);
	await waitFor(v, `!$("#kk").hidden && KK.loaded && document.querySelector(".kk-rooms .cv-gh, .kk-rooms .kk-note")`);
};
const openRoom = async (v: View, id = "100") => {
	await run(v, `document.querySelector('.kk-row[data-chat="${id}"]').click()`);
	await waitFor(v, `KK.open === "${id}" && !KK.loading && KK.placed`);
};
// Types a query into the room search (an input event, like the keyboard).
const search = (v: View, text: string) => run(v, `const i = document.querySelector("#kk-q"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true }))`);
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const dark = (v: View) => run(v, `if (dotzTheme.get() !== "dark") dotzTheme.toggle()`);
const light = (v: View) => run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);

// The newest message is wholly inside the timeline, which ends at or above the composer, and the timeline is scrolled to its end.
const newestInSight = (v: View, logId: string) =>
	q<boolean>(v, `const t = document.querySelector("#kk-tl"), tr = t.getBoundingClientRect(), m = document.querySelector('[data-log="${logId}"]').getBoundingClientRect(), f = document.querySelector("#kk-foot").getBoundingClientRect();
		return m.bottom <= tr.bottom + 1 && m.top >= tr.top && tr.bottom <= f.top + 1 && t.scrollHeight - t.scrollTop - t.clientHeight <= 1`);
type Geo = { markTop: number; scrollTop: number; stick: boolean; markNext: string | null };
const geo = (v: View) => q<Geo>(v, `const m = document.querySelector(".kk-new"), t = document.querySelector("#kk-tl"); return { markTop: m ? Math.round(m.getBoundingClientRect().top - t.getBoundingClientRect().top) : -999, scrollTop: Math.round(t.scrollTop), stick: KK.stick, markNext: m && m.nextElementSibling ? m.nextElementSibling.dataset.log : null }`);

describe("카카오톡 at desktop width (1280x800)", () => {
	const v = open(1280, 800);

	test("the room choice lists every room with a switch; the chosen ones are conversation rows with name, initial, time and unread", async () => {
		await boot(v);
		const s = await q<{ rows: { name: string; initial: string; time: string; badge: string }[]; sw: string[][]; expanded: string | null }>(v, `
			const rows = [...document.querySelectorAll(".kk-row")].map(r => ({ name: r.querySelector(".cv-n").textContent, initial: r.querySelector(".kk-av").textContent, time: (r.querySelector(".kk-t") || {}).textContent || "", badge: (r.querySelector(".nb") || {}).textContent || "" }));
			return { rows, sw: [...document.querySelectorAll(".kk-pr")].map(p => [p.dataset.chat, p.querySelector('[data-k="watch"]').getAttribute("aria-checked")]), expanded: document.querySelector("#kk-pick-btn").getAttribute("aria-expanded") }`);
		expect(s.rows.map(r => r.name)).toEqual(["가나다 모임", "라마바"]);
		expect(s.rows[0]).toMatchObject({ initial: "가", badge: "30" });
		expect(s.rows[0]!.time.length).toBeGreaterThan(0);
		expect(s.expanded).toBe("false");
		await run(v, `document.querySelector("#kk-pick-btn").click()`);
		const sw = await q<string[][]>(v, `return [...document.querySelectorAll(".kk-pr")].map(p => [p.dataset.chat, p.querySelector('[data-k="watch"]').getAttribute("aria-checked")])`);
		expect(sw).toEqual([["100", "true"], ["200", "false"], ["300", "true"]]);
		await shot(v, "01-desktop-rooms.png");
		await run(v, `document.querySelector("#kk-pick-btn").click()`);
	});

	test("toggling a room PUTs {watched}; a watched room has an 자동 초안 switch that PUTs {autoDraft}", async () => {
		await run(v, `document.querySelector("#kk-pick-btn").click()`);
		await run(v, `document.querySelector('.kk-pr[data-chat="200"] [data-k="watch"]').click()`);
		const put = await expectReq(isReq("PUT", "/api/kakao/rooms/200"));
		expect(put.body).toEqual({ watched: true });
		await waitFor(v, `document.querySelector('.kk-pr[data-chat="200"] [data-k="auto"]')`);
		expect(await q(v, `return document.querySelector('.kk-pr[data-chat="200"] [data-k="watch"]').getAttribute("aria-checked")`)).toBe("true");
		await run(v, `document.querySelector('.kk-pr[data-chat="100"] [data-k="auto"]').click()`);
		expect((await expectReq(isReq("PUT", "/api/kakao/rooms/100"))).body).toEqual({ autoDraft: true });
		expect(await q(v, `return document.querySelector(".kk-hint").textContent.includes("토큰")`)).toBe(true);
	});

	test("opening a room: bubbles left and right, names and times per run, date dividers, placeholders, escaped text, the unread line", async () => {
		await boot(v);
		await openRoom(v);
		const g = await geo(v);
		expect(g.markNext).toBe("4001");
		expect((await expectReq(isReq("POST", "/api/kakao/chat/100/read"))).body).toEqual({ logId: "4030" });
		const lay = await q<Record<string, number>>(v, `
			const r = s => document.querySelector(s).getBoundingClientRect(), t = r("#kk-tl");
			return { inL: r('[data-log="3001"] .kk-bub').left, inR: r('[data-log="3001"] .kk-bub').right, meL: r('[data-log="3003"] .kk-bub').left, meR: r('[data-log="3003"] .kk-bub').right, tl: t.left, tr: t.right, longR: r('[data-log="3007"] .kk-bub').right, hScroll: document.querySelector("#kk-tl").scrollWidth - document.querySelector("#kk-tl").clientWidth }`);
		expect(lay.inL).toBeLessThan(lay.tl + 80);
		expect(lay.meR).toBeGreaterThan(lay.tr - 24);
		expect(lay.meL).toBeGreaterThan(lay.inL + 100);
		expect(lay.longR).toBeLessThanOrEqual(lay.tr);
		expect(lay.hScroll).toBeLessThanOrEqual(0);
		const runs = await q<Record<string, unknown>>(v, `
			const has = (id, s) => !!document.querySelector('[data-log="' + id + '"] ' + s);
			return { name1: has("3001", ".kk-name"), name2: has("3002", ".kk-name"), time1: has("3001", ".kk-time"), time2: has("3002", ".kk-time"), av1: has("3001", ".kk-av:not(.sp)"), av2: has("3002", ".kk-av.sp"), meTime: has("3003", ".kk-time"), meName: has("3003", ".kk-name"),
				ph1: document.querySelector('[data-log="3004"] .kk-bub').textContent, ph2: document.querySelector('[data-log="3005"] .kk-bub').textContent,
				raw: document.querySelector('[data-log="3006"] .kk-bub').textContent, tags: document.querySelectorAll('[data-log="3006"] .kk-bub *').length,
				dates: [...document.querySelectorAll(".kk-date")].map(d => d.textContent), mark: document.querySelector(".kk-new").textContent }`);
		expect(runs).toMatchObject({ name1: true, name2: false, time1: false, time2: true, av1: true, av2: true, meTime: true, meName: false, ph1: "(사진)", ph2: "(이모티콘)", tags: 0, mark: "여기까지 읽었어요" });
		expect(runs.raw).toBe("<b>굵게</b> & <img src=x onerror=alert(1)> 그대로 보여야 해요");
		const dates = runs.dates as string[];
		expect(dates.length).toBeGreaterThanOrEqual(3);
		for (const d of dates) expect(d).toMatch(/^\d{4}년 \d{1,2}월 \d{1,2}일 .요일$/);
		await shot(v, "02-desktop-unread.png");
	});

	test("the room opens at the newest message, fully above the composer; /read carries the last logId; the unread line stays in the list", async () => {
		const g = await geo(v);
		expect(g.stick).toBe(true);
		expect(g.scrollTop).toBeGreaterThan(0);
		expect(g.markTop).toBeLessThan(0);
		expect(await newestInSight(v, "4030")).toBe(true);
		await waitFor(v, `!document.querySelector('.kk-row[data-chat="100"] .nb')`);
	});

	test("a new message while scrolled up shows the 새 메시지 pill and keeps the place; at the bottom it follows", async () => {
		await run(v, `document.querySelector("#kk-tl").scrollTop = 0`);
		await waitFor(v, `KK.stick === false`);
		msgs.push(mk("4031", "다라", "위에 있을 때 온 메시지", at(22, 2, 0)));
		emit({ kind: "kakao", chatId: "100", logId: "4031" });
		await waitFor(v, `document.querySelector('[data-log="4031"]')`);
		const s = await q<{ pill: boolean; top: number; text: string }>(v, `return { pill: !document.querySelector("#kk-pill").hidden, top: document.querySelector("#kk-tl").scrollTop, text: document.querySelector("#kk-pill").textContent }`);
		expect(s.pill).toBe(true);
		expect(s.top).toBeLessThan(5);
		expect(s.text).toContain("새 메시지");
		await run(v, `document.querySelector("#kk-pill").click()`);
		await waitFor(v, `KK.stick && document.querySelector("#kk-pill").hidden`);
		expect((await expectReq(r => r.path.endsWith("/read") && r.body?.logId === "4031")).body).toEqual({ logId: "4031" });
		msgs.push(mk("4032", "다라", "맨 아래에 있을 때 온 메시지", at(22, 2, 1)));
		emit({ kind: "kakao", chatId: "100", logId: "4032" });
		await waitFor(v, `document.querySelector('[data-log="4032"]') && KK.stick && document.querySelector("#kk-tl").scrollTop + document.querySelector("#kk-tl").clientHeight >= document.querySelector("#kk-tl").scrollHeight - 4`);
	});

	test("a row that lands below the newest logId we hold (a late sync) is merged in logId order, not skipped", async () => {
		msgs.push(mk("3500", "다라", "늦게 들어온 메시지", at(21, 5, 0)));
		emit({ kind: "kakao", chatId: "100", logId: "4032" });
		await waitFor(v, `document.querySelector('[data-log="3500"]')`);
		const order = await q<string[]>(v, `return [...document.querySelectorAll("#kk-tl [data-log]")].map(n => n.dataset.log)`);
		expect(order.indexOf("3500")).toBe(order.indexOf("3007") + 1);
		expect(order.indexOf("3500")).toBe(order.lastIndexOf("3500"));
		expect(await newestInSight(v, "4032")).toBe(true);
	});

	test("a burst of more than one page after the last held row is read to the end and the view stays pinned", async () => {
		for (let i = 0; i < 150; i++) msgs.push(mk(String(5001 + i), "다라", `몰려온 메시지 ${i}`, at(22, 3, 0, i)));
		emit({ kind: "kakao", chatId: "100", logId: "5150" });
		await waitFor(v, `document.querySelector('[data-log="5150"]')`);
		expect(await q<number>(v, `return document.querySelectorAll('#kk-tl [data-log]').length`)).toBe(69 + 1 + 150);
		expect(await newestInSight(v, "5150")).toBe(true);
	});

	test("a message in another room adds to its unread badge", async () => {
		emit({ kind: "kakao", chatId: "300", logId: "9" });
		await waitFor(v, `(document.querySelector('.kk-row[data-chat="300"] .nb') || {}).textContent === "1"`);
	});

	test("read counters: a small bold yellow number on the time side of a bubble, above the time, own and incoming alike, none at 0", async () => {
		const s = await q<Record<string, any>>(v, `
			const r = s => document.querySelector(s).getBoundingClientRect();
			const rd = id => (document.querySelector('[data-log="' + id + '"] .kk-rd') || {}).textContent ?? null;
			const cs = getComputedStyle(document.querySelector('[data-log="3002"] .kk-rd'));
			return { all: [...document.querySelectorAll(".kk-rd")].map(n => n.closest("[data-log]").dataset.log + ":" + n.textContent), r1: rd("3001"), r2: rd("3002"), r3: rd("3003"), r4: rd("3004"), r6: rd("3006"),
				weight: Number(cs.fontWeight), size: parseFloat(cs.fontSize), color: cs.color, label: document.querySelector('[data-log="3003"] .kk-rd').getAttribute("aria-label"),
				inAbove: r('[data-log="3002"] .kk-rd').bottom <= r('[data-log="3002"] .kk-time').top + 1, inSide: r('[data-log="3002"] .kk-meta').left >= r('[data-log="3002"] .kk-bub').right - 1,
				meAbove: r('[data-log="3003"] .kk-rd').bottom <= r('[data-log="3003"] .kk-time').top + 1, meSide: r('[data-log="3003"] .kk-meta').right <= r('[data-log="3003"] .kk-bub').left + 1,
				timeless: !document.querySelector('[data-log="3001"] .kk-time') && !!document.querySelector('[data-log="3001"] .kk-meta'), hScroll: document.querySelector("#kk-tl").scrollWidth - document.querySelector("#kk-tl").clientWidth }`);
		expect(s.all).toEqual(["3001:2", "3002:2", "3003:1", "3007:1"]);
		expect(s).toMatchObject({ r1: "2", r2: "2", r3: "1", r4: null, r6: null, inAbove: true, inSide: true, meAbove: true, meSide: true, timeless: true, label: "아직 안 읽은 사람 1명" });
		expect(s.weight).toBeGreaterThanOrEqual(700);
		expect(s.size).toBeLessThanOrEqual(12);
		expect(s.color).not.toBe("rgba(0, 0, 0, 0)");
		expect(s.hScroll).toBeLessThanOrEqual(0);
		await run(v, `document.querySelector('[data-log="3001"]').scrollIntoView({ block: "center" })`);
		await shot(v, "08-desktop-counts.png");
	});

	test("kakao_read for the open room asks /reads?from=<oldest shown> and repaints the counters without refetching bodies", async () => {
		const bodies = reqs.filter(r => r.method === "GET" && /^\/api\/kakao\/chat\/100\?/.test(r.path)).length;
		for (const m of msgs) if (m.logId === "3001" || m.logId === "3007") m.unread = 0; else if (m.logId === "3002") m.unread = 1;
		emit({ kind: "kakao_read", chatId: "300" });
		emit({ kind: "kakao_read", chatId: "100" });
		await expectReq(isReq("GET", "/api/kakao/chat/100/reads?from=2001"));
		await waitFor(v, `[...document.querySelectorAll(".kk-rd")].map(n => n.closest("[data-log]").dataset.log + ":" + n.textContent).join() === "3002:1,3003:1"`);
		expect(reqs.filter(r => r.path.startsWith("/api/kakao/chat/300"))).toEqual([]);
		expect(reqs.filter(r => r.method === "GET" && /^\/api\/kakao\/chat\/100\?/.test(r.path)).length).toBe(bodies);
	});

	test("a typed message POSTs {text} with a 보내는 중 bubble on the right; sent clears it once the message is read back; failed shows the reason and retries", async () => {
		await run(v, `const t = document.querySelector("#kk-text"); t.value = "가나다 답장"; t.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#kk-send-btn").click()`);
		expect((await expectReq(isReq("POST", "/api/kakao/chat/100/send"))).body).toEqual({ text: "가나다 답장" });
		await waitFor(v, `document.querySelector(".kk-m.me.pend .kk-state")`);
		expect(await q(v, `return !!document.querySelector(".kk-m.pend .kk-rd")`)).toBe(false);
		const pend = await q<{ state: string; right: number; tr: number; empty: string }>(v, `const b = document.querySelector(".kk-m.me.pend .kk-bub").getBoundingClientRect(); return { state: document.querySelector(".kk-m.me.pend .kk-state").textContent, right: b.right, tr: document.querySelector("#kk-tl").getBoundingClientRect().right, empty: document.querySelector("#kk-text").value }`);
		expect(pend.state).toBe("보내는 중");
		expect(pend.right).toBeGreaterThan(pend.tr - 24);
		expect(pend.empty).toBe("");
		msgs.push({ ...mk("4033", "me", "가나다 답장", Date.now()) });
		emit({ kind: "kakao_send", chatId: "100", id: "s1", state: "sent" });
		await waitFor(v, `document.querySelector('[data-log="4033"]') && !document.querySelector(".kk-m.me.pend")`);

		await run(v, `const t = document.querySelector("#kk-text"); t.value = "두번째 글"; t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
		expect((await expectReq(r => r.path === "/api/kakao/chat/100/send" && r.body?.text === "두번째 글")).body).toEqual({ text: "두번째 글" });
		Object.assign(sends.find(s => s.id === "s2")!, { state: "failed", reason: "전송에 실패했어요" });
		emit({ kind: "kakao_send", chatId: "100", id: "s2", state: "failed", reason: "전송에 실패했어요" });
		await waitFor(v, `(document.querySelector(".kk-m.me.pend.failed .kk-state") || {}).textContent === "실패 · 전송에 실패했어요"`);
		await run(v, `document.querySelector("#kk-tl").scrollTop = 1e9`);
		await shot(v, "07-desktop-send-failed.png");
		await run(v, `document.querySelector('.kk-m.pend [data-k="retry"]').click()`);
		await waitFor(v, `document.querySelectorAll(".kk-m.me.pend").length === 1 && document.querySelector(".kk-m.me.pend .kk-state").textContent === "보내는 중"`);
		expect(reqs.filter(r => r.path === "/api/kakao/chat/100/send" && r.body?.text === "두번째 글")).toHaveLength(2);
	});

	test("Shift+Enter is a new line and sends nothing", async () => {
		const before = reqs.filter(r => r.path.endsWith("/send")).length;
		const prevented = await q<boolean>(v, `const t = document.querySelector("#kk-text"); const e = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented`);
		expect(prevented).toBe(false);
		expect(reqs.filter(r => r.path.endsWith("/send")).length).toBe(before);
	});

	test("drafts of the room: a card with 보내기 / 고치기 / 버리기; 보내기 posts the draft route as is, 고치기 sends the edited text, 버리기 drops", async () => {
		const cards = await q<string[]>(v, `return [...document.querySelectorAll(".kk-draft .kk-dt")].map(d => d.textContent)`);
		expect(cards).toEqual(["초안 하나예요", "초안 둘이에요", "초안 셋이에요"]);
		await shot(v, "03-desktop-drafts.png");
		await run(v, `document.querySelector('.kk-draft[data-code="d1"] [data-k="send"]').click()`);
		expect((await expectReq(isReq("POST", "/api/kakao/drafts/d1/send"))).body).toEqual({});
		await waitFor(v, `!document.querySelector('.kk-draft[data-code="d1"]')`);

		await run(v, `document.querySelector('.kk-draft[data-code="d2"] [data-k="edit"]').click()`);
		const ed = await q<{ value: string; bar: boolean; card: boolean }>(v, `return { value: document.querySelector("#kk-text").value, bar: !document.querySelector("#kk-edit").hidden, card: !!document.querySelector('.kk-draft[data-code="d2"]') }`);
		expect(ed).toEqual({ value: "초안 둘이에요", bar: true, card: false });
		await run(v, `const t = document.querySelector("#kk-text"); t.value = "고친 글"; t.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#kk-send-btn").click()`);
		expect((await expectReq(isReq("POST", "/api/kakao/drafts/d2/send"))).body).toEqual({ text: "고친 글" });
		await waitFor(v, `document.querySelector("#kk-edit").hidden && document.querySelector("#kk-text").value === ""`);

		await run(v, `document.querySelector('.kk-draft[data-code="d3"] [data-k="drop"]').click()`);
		await expectReq(isReq("POST", "/api/kakao/drafts/d3/drop"));
		await waitFor(v, `!document.querySelector(".kk-draft")`);
	});

	test("답장 초안 POSTs /draft, shows 초안 만드는 중… until the room's kakao_draft arrives, then the new draft card", async () => {
		await run(v, `document.querySelector("#kk-draft-btn").click()`);
		await expectReq(isReq("POST", "/api/kakao/chat/100/draft"));
		const busy = await q<{ text: string; disabled: boolean }>(v, `const b = document.querySelector("#kk-draft-btn"); return { text: b.textContent, disabled: b.disabled }`);
		expect(busy).toEqual({ text: "초안 만드는 중…", disabled: true });
		drafts.push({ code: "d4", text: "새로 만든 초안이에요", basisLogId: "4033", created: Date.now() });
		emit({ kind: "kakao_draft", chatId: "100" });
		await waitFor(v, `document.querySelector('.kk-draft[data-code="d4"]') && !document.querySelector("#kk-draft-btn").disabled`);
		expect(await q(v, `return document.querySelector("#kk-draft-btn").textContent`)).toBe("답장 초안");
		await run(v, `document.querySelector("#kk-tl").scrollTop = 1e9`);
		await shot(v, "04-desktop-bottom.png");
	});

	test("an open question of the room: the card shows it with one button per choice; a pick POSTs {choice} and the draft card follows; 직접 쓸게 drops it and opens the composer", async () => {
		ask = { question: "티켓 취소할까요?", choices: ["취소해", "다른 날 물어봐", "그냥 가자"] };
		emit({ kind: "kakao_draft", chatId: "100" });
		await waitFor(v, `document.querySelector(".kk-ask")`);
		const card = await q<{ q: string; buttons: string[]; first: boolean }>(v, `const c = document.querySelector(".kk-ask"); return { q: c.querySelector(".kk-dt").textContent, buttons: [...c.querySelectorAll(".btn")].map(b => b.textContent), first: document.querySelector("#kk-drafts").firstElementChild === c }`);
		expect(card).toEqual({ q: "티켓 취소할까요?", buttons: ["취소해", "다른 날 물어봐", "그냥 가자", "직접 쓸게"], first: true });
		await shot(v, "06-desktop-ask.png");
		await run(v, `document.querySelector('.kk-ask [data-k="pick"][data-i="0"]').click()`);
		expect((await expectReq(r => r.method === "POST" && r.path === "/api/kakao/chat/100/draft" && r.body?.choice === "취소해")).body).toEqual({ choice: "취소해" });
		await waitFor(v, `!document.querySelector(".kk-ask") && document.querySelector('.kk-draft[data-code="dp"] .kk-dt')`);
		expect(await q(v, `return [...document.querySelectorAll('.kk-draft[data-code="dp"] .btn')].map(b => b.textContent)`)).toEqual(["보내기", "고치기", "버리기"]);
		expect(await q(v, `return document.querySelector('.kk-draft[data-code="dp"] .kk-dt').textContent`)).toBe("답장: 취소해");

		ask = { question: "다시 묻습니다", choices: ["응", "아니"] };
		emit({ kind: "kakao_draft", chatId: "100" });
		await waitFor(v, `document.querySelector(".kk-ask")`);
		await run(v, `document.querySelector('.kk-ask [data-k="own"]').click()`);
		await expectReq(isReq("POST", "/api/kakao/chat/100/ask/drop"));
		await waitFor(v, `!document.querySelector(".kk-ask") && document.activeElement && document.activeElement.id === "kk-text"`);
	});

	test("dark", async () => {
		await dark(v);
		await shot(v, "05-desktop-dark.png");
		await light(v);
	});
});

describe("카카오톡 on a phone (390x844)", () => {
	const v = open(390, 844);

	test("the room list and the chat are separate screens with a back button; the composer stays on screen", async () => {
		await boot(v);
		const disp = (s: string) => `getComputedStyle(document.querySelector("${s}")).display`;
		expect(await q(v, `return [${disp(".kk-rooms")}, ${disp(".kk-chat")}]`)).toEqual(["block", "none"]);
		await shot(v, "10-mobile-rooms.png");
		await openRoom(v);
		expect(await q(v, `return [${disp(".kk-rooms")}, ${disp(".kk-chat")}, document.querySelector("#title").textContent, !document.querySelector("#back").hidden]`)).toEqual(["none", "flex", "가나다 모임", true]);
		const g = await geo(v);
		expect(g.markNext).toBe("4001");
		expect(g.stick).toBe(true);
		expect(await newestInSight(v, "4030")).toBe(true);
		await shot(v, "11-mobile-unread.png");
		await shot(v, "12-mobile-drafts.png");
		const foot = await q<{ bottom: number; h: number; right: number; w: number }>(v, `const f = document.querySelector("#kk-foot").getBoundingClientRect(); return { bottom: f.bottom, h: innerHeight, right: f.right, w: innerWidth }`);
		expect(foot.bottom).toBeLessThanOrEqual(foot.h);
		expect(foot.right).toBeLessThanOrEqual(foot.w);

		await v.resize(390, 544);
		await run(v, `visualViewport.dispatchEvent(new Event("resize"))`);
		expect(await q<boolean>(v, `const f = document.querySelector("#kk-foot").getBoundingClientRect(); return f.bottom <= innerHeight && f.top >= 0`)).toBe(true);
		await v.resize(390, 844);

		await run(v, `const t = document.querySelector("#kk-text"); t.value = "줄바꿈"; const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); t.dispatchEvent(e); window.__enterPrevented = e.defaultPrevented`);
		expect(await q(v, `return window.__enterPrevented`)).toBe(false);
		expect(reqs.some(r => r.path.endsWith("/send"))).toBe(false);

		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `!KK.open`);
		expect(await q(v, `return [${disp(".kk-rooms")}, ${disp(".kk-chat")}]`)).toEqual(["block", "none"]);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `MON.list`);
	});

	test("room search at 390px: the input sits on top of the room choice, fits the width, and filters the choice list", async () => {
		await boot(v);
		await run(v, `document.querySelector("#kk-pick-btn").click()`);
		await waitFor(v, `document.querySelector("#kk-q")`);
		await search(v, "모임");
		const s = await q<Record<string, any>>(v, `const i = document.querySelector("#kk-q").getBoundingClientRect(), p = document.querySelector(".kk-rooms");
			return { rows: [...document.querySelectorAll('.kk-pr')].map(r => r.dataset.chat), h: i.height, left: i.left, right: i.right, w: innerWidth, hScroll: p.scrollWidth - p.clientWidth, font: parseFloat(getComputedStyle(document.querySelector("#kk-q")).fontSize) }`);
		expect(s.rows).toEqual(["100"]);
		expect(s.h).toBeGreaterThanOrEqual(44);
		expect(s.left).toBeGreaterThanOrEqual(0);
		expect(s.right).toBeLessThanOrEqual(s.w);
		expect(s.hScroll).toBeLessThanOrEqual(0);
		expect(s.font).toBeGreaterThanOrEqual(16);
		await shot(v, "14-mobile-search.png");
	});

	test("dark chat", async () => {
		await boot(v);
		await openRoom(v);
		await dark(v);
		await shot(v, "13-mobile-dark.png");
		await light(v);
	});
});

describe("대화방 검색 (room search)", () => {
	const v = open(1280, 800);
	const rowsOf = (v: View) => q<string[]>(v, `return [...document.querySelectorAll(".kk-pr")].map(r => r.dataset.chat)`);

	test("a search input tops the room choice; it filters by name (substring, case-insensitive, initial consonants) and says so when nothing matches", async () => {
		reset();
		await boot(v);
		await run(v, `document.querySelector("#kk-pick-btn").click()`);
		const top = await q<Record<string, any>>(v, `const i = document.querySelector("#kk-q"); return { ph: i.placeholder, prev: i.previousElementSibling.id, label: i.getAttribute("aria-label") }`);
		expect(top).toEqual({ ph: "대화방 검색", prev: "kk-pick-btn", label: "대화방 검색" });
		expect(await rowsOf(v)).toEqual(["100", "200", "300"]);
		await search(v, "라마");
		expect(await rowsOf(v)).toEqual(["300"]);
		await search(v, "ㄱㄴㄷ");
		expect(await rowsOf(v)).toEqual(["100"]);
		await search(v, " ㅅㅇㅈ ");
		expect(await rowsOf(v)).toEqual(["200"]);
		await search(v, "모임");
		expect(await rowsOf(v)).toEqual(["100"]);
		await search(v, "zzz");
		expect(await rowsOf(v)).toEqual([]);
		expect(await q(v, `return document.querySelector("#kk-nomatch").textContent`)).toBe("찾는 대화방이 없어요");
		await shot(v, "09-desktop-search-empty.png");
		await search(v, "");
		expect(await rowsOf(v)).toEqual(["100", "200", "300"]);
		expect(await q(v, `return !document.querySelector("#kk-nomatch")`)).toBe(true);
		expect(await q(v, `return [kkMatch("Book Club", "bOOK"), kkMatch("가나다 모임", "나다"), kkMatch("가나다", "ㄴ"), kkMatch("가나다", "ㄹ"), kkMatch("가나다", "가ㄴ")]`)).toEqual([true, true, true, false, false]);
	});

	test("the switches keep working while filtered, and the query survives the repaint; the watched rows below are not filtered", async () => {
		await search(v, "라마");
		await run(v, `document.querySelector('.kk-pr[data-chat="300"] [data-k="watch"]').click()`);
		expect((await expectReq(isReq("PUT", "/api/kakao/rooms/300"))).body).toEqual({ watched: false });
		await waitFor(v, `document.querySelector('.kk-pr[data-chat="300"] [data-k="watch"]').getAttribute("aria-checked") === "false"`);
		expect(await rowsOf(v)).toEqual(["300"]);
		expect(await q(v, `return [document.querySelector("#kk-q").value, [...document.querySelectorAll(".kk-row")].map(r => r.dataset.chat)]`)).toEqual(["라마", ["100"]]);
		await search(v, "사아");
		await run(v, `document.querySelector('.kk-pr[data-chat="200"] [data-k="watch"]').click()`);
		await expectReq(isReq("PUT", "/api/kakao/rooms/200"));
		await waitFor(v, `document.querySelector('.kk-pr[data-chat="200"] [data-k="auto"]')`);
		expect(await rowsOf(v)).toEqual(["200"]);
	});
});

describe("empty and error states", () => {
	const v = open(1280, 800);

	test("no room chosen: the picker is open and one line asks to choose", async () => {
		reset();
		for (const r of rooms) r.watched = false;
		await boot(v);
		expect(await q(v, `return document.querySelector("#kk-empty").textContent`)).toBe("지켜볼 대화방을 골라 주세요");
		expect(await q(v, `return document.querySelector("#kk-pick-btn").getAttribute("aria-expanded")`)).toBe("true");
		expect(await q(v, `return document.querySelectorAll(".kk-pr").length`)).toBe(3);
		await shot(v, "06-desktop-empty.png");
	});

	test("an error from the rooms route is one plain line", async () => {
		reset();
		roomsAnswer = { on: true, rooms: [], error: "카카오톡 데이터베이스를 읽을 수 없어요" };
		await boot(v);
		expect(await q(v, `return [...document.querySelectorAll(".kk-rooms .kk-note")].map(n => n.textContent)`)).toEqual(["카카오톡 데이터베이스를 읽을 수 없어요"]);
	});

	test("integration off is one plain line", async () => {
		reset();
		roomsAnswer = { on: false, rooms: [] };
		await boot(v);
		expect(await q(v, `return [...document.querySelectorAll(".kk-rooms .kk-note")].map(n => n.textContent)`)).toEqual(["카카오톡 연동이 꺼져 있어요"]);
	});
});

const MEDIA = (): Msg[] => [
	mk("5001", "가나", "", at(23, 3, 0), 2, { kind: "photo", w: 320, h: 240, count: 1, expired: false }),
	mk("5002", "가나", "", at(23, 3, 0, 20), 27, { kind: "photo", w: 200, h: 300, count: 8, expired: false }),
	mk("5003", "다라", "", at(23, 3, 1), 3, { kind: "video", w: 640, h: 360, d: 75, expired: false }),
	mk("5004", "가나", "", at(23, 3, 2), 5, { kind: "voice", d: 8, expired: false }),
	mk("5005", "me", "", at(23, 3, 3), 18, { kind: "file", name: "보고서.pdf", size: 2048, local: true, expired: false }),
	mk("5006", "가나", "", at(23, 3, 4), 18, { kind: "file", name: "<b>큰파일</b>.zip", size: 5 * 1048576, local: false, expired: true }),
	mk("5007", "다라", "", at(23, 3, 5), 2, { kind: "photo", w: 320, h: 240, count: 1, expired: true }),
	mk("5008", "가나", "", at(23, 3, 6), 2, { kind: "photo", w: 320, h: 240, count: 1, expired: false }),
	mk("5009", "가나", "", at(23, 3, 7), 20, { kind: "emoticon", alt: "(이모티콘) 하트" }),
	mk("5010", "다라", "나도 좋아", at(23, 3, 8), 26, { kind: "reply", quote: "점심 뭐 먹을까", quoteSender: "가나" }),
	mk("5011", "가나", "", at(23, 3, 9), 16, { kind: "location", label: "서울 강남구", lat: 37.5, lng: 127.03 }),
	mk("5012", "가나", "다라님이 들어왔어요", at(23, 3, 10), 0),
	mk("5013", "가나", "알림 메시지", at(23, 3, 11), 71),
	mk("5014", "다라", "", at(23, 3, 12), 99),
	mk("5015", "가나", "", at(23, 3, 13), 12, { kind: "emoticon", alt: "(이모티콘) 카카오 이모티콘", text: "고마워 <b>x</b>" }),
];
const useMedia = () => { reset(); msgs = MEDIA(); drafts = []; };

describe("카카오톡 media at desktop width", () => {
	const v = open(1280, 800);

	test("a photo is a lazy rounded thumbnail from the media route, no colored bubble, at most 240px wide", async () => {
		useMedia();
		await boot(v);
		await openRoom(v);
		await run(v, `document.querySelector('#kk-tl').scrollTop = 0`);
		const s = await q<Record<string, any>>(v, `
			const b = document.querySelector('[data-log="5001"] .kk-photo'), img = b.querySelector("img"), r = b.getBoundingClientRect();
			return { src: img.getAttribute("src"), loading: img.getAttribute("loading"), alt: img.alt, w: r.width, h: r.height, bubble: !!document.querySelector('[data-log="5001"] .kk-bub'), bg: getComputedStyle(document.querySelector('[data-log="5001"] .kk-media')).backgroundColor, radius: parseFloat(getComputedStyle(b).borderTopLeftRadius), text: document.querySelector('[data-log="5001"]').textContent.includes("(사진)") }`);
		expect(s).toMatchObject({ src: "/api/kakao/media/100/5001?i=0&v=thumb", loading: "lazy", alt: "사진", bubble: false, text: false });
		expect(s.w).toBeLessThanOrEqual(240);
		expect(s.w).toBeGreaterThan(150);
		expect(Math.abs(s.w / s.h - 320 / 240)).toBeLessThan(0.05);
		expect(s.radius).toBeGreaterThanOrEqual(8);
		expect(s.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
		await expectReq(isReq("GET", "/api/kakao/media/100/5001?i=0&v=thumb"));
	});

	test("an album is a 3-column grid of at most 6 tiles with +N on the last; a tile opens the viewer at its index and the arrows page through", async () => {
		const g = await q<Record<string, any>>(v, `
			const a = document.querySelector('[data-log="5002"] .kk-album'), tiles = [...a.querySelectorAll(".kk-photo")];
			return { cols: a.className, n: tiles.length, more: tiles[5].querySelector(".kk-more-n").textContent, srcs: tiles.map(t => t.querySelector("img").getAttribute("src")), w: a.getBoundingClientRect().width, tw: tiles[0].getBoundingClientRect().width, th: tiles[0].getBoundingClientRect().height, cw: getComputedStyle(a).gridTemplateColumns.split(" ").length }`);
		expect(g.n).toBe(6);
		expect(g.cols).toContain("c3");
		expect(g.cw).toBe(3);
		expect(g.more).toBe("+3");
		expect(g.srcs[1]).toBe("/api/kakao/media/100/5002?i=1&v=thumb");
		expect(g.w).toBeLessThanOrEqual(240);
		expect(g.tw).toBeLessThan(90);
		expect(Math.abs(g.tw - g.th)).toBeLessThan(2);
		await run(v, `document.querySelectorAll('[data-log="5002"] .kk-photo')[1].click()`);
		await waitFor(v, `document.querySelector('dialog.kk-vwd[open] img')`);
		const w = () => q<Record<string, any>>(v, `const d = document.querySelector("dialog.kk-vwd"); return { title: d.querySelector(".lb-n").textContent, src: d.querySelector("img").getAttribute("src"), prev: d.querySelector('[data-k="prev"]').hidden, next: d.querySelector('[data-k="next"]').hidden, video: !!d.querySelector("video") }`);
		expect(await w()).toEqual({ title: "사진 2 / 8", src: "/api/kakao/media/100/5002?i=1&v=full", prev: false, next: false, video: false });
		await run(v, `document.querySelector('dialog.kk-vwd [data-k="next"]').click()`);
		expect((await w()).src).toBe("/api/kakao/media/100/5002?i=2&v=full");
		await run(v, `document.querySelector('dialog.kk-vwd [data-k="close"]').click()`);
		await waitFor(v, `!document.querySelector('dialog.kk-vwd')`);
	});

	test("a video shows its thumbnail with a play icon and the length; tapping plays it with controls in the viewer", async () => {
		const s = await q<Record<string, any>>(v, `const b = document.querySelector('[data-log="5003"] .kk-video'); return { play: !!b.querySelector(".kk-play"), dur: b.querySelector(".kk-dur").textContent, src: b.querySelector("img").getAttribute("src"), label: b.getAttribute("aria-label") }`);
		expect(s).toEqual({ play: true, dur: "1:15", src: "/api/kakao/media/100/5003?i=0&v=thumb", label: "동영상 재생" });
		await run(v, `document.querySelector('[data-log="5003"] .kk-video').click()`);
		await waitFor(v, `document.querySelector('dialog.kk-vwd[open] video[controls]')`);
		expect(await q(v, `return document.querySelector('dialog.kk-vwd video').getAttribute('src')`)).toBe("/api/kakao/media/100/5003?i=0&v=full");
		await run(v, `document.querySelector('dialog.kk-vwd [data-k="close"]').click()`);
		await waitFor(v, `!document.querySelector('dialog.kk-vwd')`);
	});

	test("voice is a compact audio control that loads nothing until played; files are cards: 열기 when downloaded here, else PC에 없음", async () => {
		const s = await q<Record<string, any>>(v, `
			const a = document.querySelector('[data-log="5004"] audio'), f1 = document.querySelector('[data-log="5005"] .kk-bub.file'), f2 = document.querySelector('[data-log="5006"] .kk-bub.file'), open = f1.querySelector("a.kk-open");
			return { audio: [a.controls, a.getAttribute("preload"), a.getAttribute("src")], f1: [f1.querySelector(".kk-fn").textContent, f1.querySelector(".kk-sub").textContent, open.textContent, open.getAttribute("href"), open.getAttribute("target"), !!f1.querySelector("svg")],
				f2: [f2.querySelector(".kk-fn").textContent, f2.querySelector("a"), f2.querySelector(".kk-nopc").textContent, f2.querySelector(".kk-sub").textContent], tags: f2.querySelectorAll(".kk-fn *").length }`);
		expect(s.audio).toEqual([true, "none", "/api/kakao/media/100/5004?i=0&v=full"]);
		expect(s.f1).toEqual(["보고서.pdf", "2KB", "열기", "/api/kakao/media/100/5005/file", "_blank", true]);
		expect(s.f2[0]).toBe("<b>큰파일</b>.zip");
		expect(s.f2[1]).toBeNull();
		expect(s.f2[2]).toBe("PC에 없음");
		expect(s.f2[3]).toContain("5.0MB");
		expect(s.tags).toBe(0);
		expect(reqs.some(r => r.path.startsWith("/api/kakao/media/100/5004"))).toBe(false);
	});

	test("an expired photo is a muted 기간이 지나 볼 수 없어요 card without a request; a thumbnail the server answers 410 for turns into one", async () => {
		expect(await q(v, `const c = document.querySelector('[data-log="5007"] .kk-bub.gone'); return [c.textContent, !!document.querySelector('[data-log="5007"] img')]`)).toEqual(["기간이 지나 볼 수 없어요", false]);
		expect(reqs.some(r => r.path.startsWith("/api/kakao/media/100/5007"))).toBe(false);
		await run(v, `document.querySelector('[data-log="5008"]').scrollIntoView()`);
		await waitFor(v, `document.querySelector('[data-log="5008"] .kk-photo.gone .kk-gonet')`);
		expect(await q(v, `return document.querySelector('[data-log="5008"] .kk-gonet').textContent`)).toBe("기간이 지나 볼 수 없어요");
	});

	test("emoticon shows its alt, a reply quotes the source above its text, a location links to a map search, a feed line is a centered system line, other types fall back to text or (기타 메시지)", async () => {
		const s = await q<Record<string, any>>(v, `
			const t = id => document.querySelector('[data-log="' + id + '"]'), loc = t("5011").querySelector("a.kk-bub.loc"), sys = t("5012").querySelector(".kk-sys") || t("5012"), r = t("5012").getBoundingClientRect(), tl = document.querySelector("#kk-tl").getBoundingClientRect();
			return { emo: t("5009").querySelector(".kk-bub").textContent, qn: t("5010").querySelector(".kk-qn").textContent, qt: t("5010").querySelector(".kk-qt").textContent, rt: t("5010").querySelector(".kk-rt").textContent,
				loc: [loc.textContent, loc.getAttribute("href"), loc.getAttribute("target"), loc.getAttribute("rel")], sys: [sys.textContent, Math.abs((r.left + r.right) / 2 - (tl.left + tl.right) / 2) < 20, !!t("5012").querySelector(".kk-bub")],
				n71: t("5013").querySelector(".kk-bub").textContent, n99: t("5014").querySelector(".kk-bub").textContent }`);
		expect(s.emo).toBe("(이모티콘) 하트");
		// a sticker with text: the sticker placeholder on top, the text (as text, not markup) in its own bubble under it; a bare sticker has one bubble
		const e = await q<Record<string, any>>(v, `const t = id => document.querySelector('[data-log="' + id + '"]'), b = [...t("5015").querySelectorAll(".kk-emo .kk-bub")], bare = t("5009").querySelectorAll(".kk-bub");
			return { texts: b.map(x => x.textContent), cls: b.map(x => x.classList.contains("ph")), under: b.length === 2 && b[0].getBoundingClientRect().bottom <= b[1].getBoundingClientRect().top + 1, markup: !!t("5015").querySelector("b"), bare: bare.length, bareEmo: !!t("5009").querySelector(".kk-emo") }`);
		expect(e).toEqual({ texts: ["(이모티콘) 카카오 이모티콘", "고마워 <b>x</b>"], cls: [true, false], under: true, markup: false, bare: 1, bareEmo: false });
		expect([s.qn, s.qt, s.rt]).toEqual(["가나", "점심 뭐 먹을까", "나도 좋아"]);
		expect(s.loc[0]).toContain("위치: 서울 강남구");
		expect(s.loc[1]).toBe("https://map.kakao.com/link/map/" + encodeURIComponent("서울 강남구") + ",37.5,127.03");
		expect(s.loc.slice(2)).toEqual(["_blank", "noopener"]);
		expect(s.sys).toEqual(["다라님이 들어왔어요", true, false]);
		expect([s.n71, s.n99]).toEqual(["알림 메시지", "(기타 메시지)"]);
		await shot(v, "10-desktop-media.png");
		await run(v, `document.querySelector("#kk-tl").scrollTop = 0`);
		await shot(v, "10-desktop-media-top.png");
	});
});

describe("카카오톡 media at 390px", () => {
	const v = open(390, 844);

	test("a photo is at most 200px wide and the timeline does not scroll sideways", async () => {
		useMedia();
		msgs = MEDIA().slice(0, 1);
		await boot(v);
		await openRoom(v);
		const s = await q<Record<string, number>>(v, `const r = document.querySelector('[data-log="5001"] .kk-photo').getBoundingClientRect(), t = document.querySelector("#kk-tl"); return { w: r.width, right: r.right, vw: innerWidth, h: t.scrollWidth - t.clientWidth }`);
		expect(s.w).toBeLessThanOrEqual(200);
		expect(s.w).toBeGreaterThan(120);
		expect(s.right).toBeLessThanOrEqual(s.vw);
		expect(s.h).toBeLessThanOrEqual(0);
		await shot(v, "11-mobile-photo.png");
	});

	test("the mix (album, file, reply, location) fits the phone width", async () => {
		useMedia();
		await boot(v);
		await openRoom(v);
		const h = await q<number>(v, `const t = document.querySelector('#kk-tl'); return t.scrollWidth - t.clientWidth`);
		expect(h).toBeLessThanOrEqual(0);
		await run(v, `document.querySelector('[data-log="5002"]').scrollIntoView()`);
		await shot(v, "12-mobile-media-mix.png");
		await run(v, `document.querySelector('[data-log="5005"]').scrollIntoView()`);
		await shot(v, "12-mobile-media-mix2.png");
	});
});
