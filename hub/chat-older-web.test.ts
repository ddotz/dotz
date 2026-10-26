import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The chat in a headless browser at 390px against a fixture conversation longer than one history read (150): scrolling to the top brings
// the older messages (web/js/13-data.js loadOlderMsgs), and a send that fails after the owner moved to another conversation goes back
// to the conversation it came from (web/js/14-slash-commands.js sendChat), not into the one on screen.
const ts = (i: number) => new Date(Date.UTC(2026, 9, 20, 0, i)).toISOString();
const N = 200;
const events = Array.from({ length: N }, (_, i) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` }));
let failSend: () => void = () => {};
let sendGate: Promise<void> = Promise.resolve();

const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/history") {
			if (url.searchParams.get("target") !== "main") return json({ events: [] });
			const limit = Number(url.searchParams.get("limit") ?? 150), before = url.searchParams.get("before");
			return json({ target: "main", events: events.filter(e => !before || e.ts < before).slice(-limit) });
		}
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/message") {
			await sendGate;
			return Response.json({ error: "보내지 못했어요" }, { status: 500 });
		}
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { view.close(); server.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const waitIn = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);

test("scrolling the chat to its top brings the messages older than the first 150", async () => {
	await view.navigate(`http://127.0.0.1:${server.port}/#chat`);
	await waitFor(`typeof ts === "function" && ts("main").hLoaded && ts("main").msgs.length === 150`);
	expect(await view.evaluate(`ts("main").hmore`)).toBe(true);
	await view.evaluate(`(timeline.scrollTop = 0, timeline.dispatchEvent(new Event("scroll")), 0)`);
	await waitFor(`ts("main").msgs.length === ${N}`);
	expect(await view.evaluate(`ts("main").msgs[0].text`)).toBe("메시지 0번이에요.");
	expect(await view.evaluate(`ts("main").hmore`)).toBe(false);
});

// Reaching the top loads the older messages by itself (the sentinel observer plus the scroll handler; no click), and the message that
// was at the top keeps its place in the view while the older ones go in above it.
test("reaching the top auto-loads the older messages and keeps the top message in place", async () => {
	const v = new Bun.WebView({ width: 390, height: 844 });
	try {
		await v.navigate(`http://127.0.0.1:${server.port}/?load=2#chat`);
		await waitIn(v, `typeof ts === "function" && ts("main").hLoaded && ts("main").msgs.length === 150`);
		expect(await v.evaluate(`$("#tl-top").hidden === false && $("#tl-more").hidden === false`)).toBe(true);   // the fallback button is there
		const before = await v.evaluate<{ ts: string; off: number }>(`(() => { timeline.scrollTop = 0; const m = document.querySelector("#tl [data-ts]"); const r = m.getBoundingClientRect(), t = timeline.getBoundingClientRect(); return { ts: m.dataset.ts, off: r.top - t.top }; })()`);
		await waitIn(v, `ts("main").msgs.length === ${N}`);
		const off = await v.evaluate<number | null>(`(() => { const m = [...document.querySelectorAll("#tl [data-ts]")].find(x => x.dataset.ts === ${JSON.stringify(before.ts)}); return m ? m.getBoundingClientRect().top - timeline.getBoundingClientRect().top : null; })()`);
		expect(off).not.toBeNull();
		expect(Math.abs((off as number) - before.off)).toBeLessThan(4);
		expect(await v.evaluate(`[ts("main").hmore, $("#tl-top").hidden]`)).toEqual([false, true]);   // the beginning: no more loads
	} finally { v.close(); }
});

test("a send that fails after the owner switched conversation goes back to its own conversation's draft", async () => {
	sendGate = new Promise(r => { failSend = r; });
	await view.evaluate(`(ta.value = "맥미니에 보내 줘", sendChat(), 0)`);
	await view.evaluate(`(setTarget("alert"), 0)`);
	await waitFor(`target === "alert"`);
	failSend();
	await waitFor(`ts("main").draft === "맥미니에 보내 줘"`);
	expect(await view.evaluate(`ta.value`)).not.toBe("맥미니에 보내 줘");
}, 20_000);
