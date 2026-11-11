import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// 공급자 추가 with a provider list longer than the screen, in a headless Bun.WebView: the list has to scroll to its last row, the scrolling
// region has to reach the footer (no empty band under the list), and no row may sit under an overflow-hidden ancestor that cannot scroll.
// Screenshots are written only when PROVIDER_ADD_SHOTS names a folder (PROVIDER_ADD_PREFIX = before | after).
const SHOTS = process.env.PROVIDER_ADD_SHOTS;
const PREFIX = process.env.PROVIDER_ADD_PREFIX ?? "after";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const login = ["Anthropic Subscription (Claude Pro/Max)", "ChatGPT Subscription (Plus/Pro)", "Cursor (Pro/Ultra/Teams)", "Cursor CLI (OAuth)", "GitHub Copilot", "Kimi Code (subscription)", "Radius", "Qwen Code", "Gemini CLI", "xAI (Grok/X subscription)", "Z.ai Coding Plan", "Mistral Le Chat", "Perplexity Pro", "Amp"].map((name, i) => ({ id: `login-${i}`, name, kind: "oauth", add_account: i === 0 }));
const keys = ["openai", "openrouter", "groq", "deepseek", "together"].map(id => ({ id, name: id, kind: "api_key" }));
const addable = [...login, ...keys];

const te = new TextEncoder();
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let streamWaiters: (() => void)[] = [];
const json = (v: unknown) => Response.json(v);
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
		if (p === "/api/monitors" || p === "/api/integrations") return json({ items: [] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: [] });
		if (p === "/api/update" || p === "/api/runtimes") return Response.json({ error: "stub" }, { status: 500 });
		if (p === "/api/providers") return json({ providers: [], addable });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = (width: number, height: number): View => { const v = new Bun.WebView({ width, height }); views.push(v); return v; };
afterEach(() => { for (const v of views.splice(0)) v.close(); });
afterAll(() => { for (const v of views) v.close(); for (const c of streams) { try { c.close(); } catch { /* already closed */ } } server.stop(true); });

const waitFor = (v: View, expr: string, ms = 4000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
const boot = async (v: View) => {
	const opened = new Promise<void>(r => streamWaiters.push(r));
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NM.loaded && S`);
	await v.evaluate(`(() => { if (dotzTheme.get() === "dark") dotzTheme.toggle(); })(), 0`);
	await v.evaluate(`(() => { P = { providers: [], addable: ${JSON.stringify(addable)} }; addProviderDialog(); })(), 0`);
	await waitFor(v, `document.querySelector("dialog[open] .pickbox")`);
};

type Geo = {
	rows: number; rowH: number;
	scroller: string; scrollable: boolean;
	lastInView: boolean; gap: number;
	clipped: string[];
};
// scroll the nearest scrollable ancestor of the list to its end, then measure from the rects
const measure = (v: View) => q<Geo>(v, `
	const dlg = document.querySelector("dialog[open]");
	const rows = [...dlg.querySelectorAll(".pickbox .li")];
	const last = rows[rows.length - 1];
	const scrolls = n => { const o = getComputedStyle(n).overflowY; return (o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight + 1; };
	const hides = n => { const o = getComputedStyle(n).overflowY; return o === "hidden" || o === "clip"; };
	const chain = []; for (let n = last.parentElement; n && n !== dlg.parentElement; n = n.parentElement) chain.push(n);
	const scroller = chain.find(scrolls);
	if (scroller) scroller.scrollTop = scroller.scrollHeight;
	const r = last.getBoundingClientRect(), rowH = rows[1].getBoundingClientRect().height;
	const box = (scroller || dlg.querySelector(".pickbox")).getBoundingClientRect();
	const ft = dlg.querySelector(".fs-ft").getBoundingClientRect();
	// an ancestor that clips and cannot scroll (hidden/clip, or auto with nothing to scroll) must still contain every row
	const clipped = [];
	for (const n of chain.slice(0, scroller ? chain.indexOf(scroller) : chain.length)) {
		if (!hides(n)) continue;
		const nb = n.getBoundingClientRect();
		for (const row of rows.filter(r => n.contains(r))) { const b = row.getBoundingClientRect(); if (b.bottom > nb.bottom + 1 || b.top < nb.top - 1) { clipped.push(n.className || n.tagName); break; } }
	}
	return { rows: rows.length, rowH, scroller: scroller ? (scroller.className || scroller.tagName) : "", scrollable: !!scroller,
		lastInView: r.top >= box.top - 1 && r.bottom <= box.bottom + 1, gap: ft.top - box.bottom, clipped };`);

for (const [w, h] of [[390, 844], [412, 915], [1280, 800]] as const) {
	test(`${w}px: 공급자 추가 with a long list scrolls to its last row, fills down to the footer and clips no row`, async () => {
		const v = open(w, h);
		await boot(v);
		await shot(v, `${PREFIX}-${w}.png`);
		const g = await measure(v);
		expect(g.rows).toBe(addable.length);
		expect(g.scrollable).toBe(true);
		expect(g.lastInView).toBe(true);
		expect(g.gap).toBeLessThanOrEqual(g.rowH);
		expect(g.clipped).toEqual([]);
	});
}
