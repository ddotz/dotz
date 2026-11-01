// 설정 → 앱 · 알림: each notice class's phone-push switch has a "디스코드로도 보내기" switch (GET/PUT /api/discord/post, hub/discord-post.ts) while Discord is
// connected; without Discord those switches are hidden and one row says how to connect it. Headless (Bun.WebView) against a fake hub.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.ROUTE_SHOTS ?? join(tmpdir(), "dotz-discord-route");
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown) => Response.json(v);

type Hub = { server: ReturnType<typeof Bun.serve>; puts: Record<string, boolean>[]; post: Record<string, boolean> };
function hub(discordOn: boolean): Hub {
	const h = { puts: [], post: { chat: true, lanes: true, alert: true, worklog: true, web_lanes: false, ask: true, result: false, news: true, conv: true } } as unknown as Hub;
	h.server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url), p = url.pathname;
			if (p === "/") return indexPage(req);
			const asset = appAsset(req, p);
			if (asset) return asset;
			if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
			if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: discordOn ? { enabled: true, connected: true } : {}, notices_unread: 0 });
			if (p === "/api/conversations") return json({ items: [] });
			if (p === "/api/notices") return json({ items: [], unread: 0, gone: [] });
			if (p === "/api/activity") return json({ items: [], more: false, history: false });
			if (p === "/api/update") {
				const at = { sha: "a".repeat(40), short: "a".repeat(7), date: new Date(0).toISOString() };
				return json({ running: { kind: "git", branch: "main", commit: at }, disk: { kind: "git", branch: "main", commit: at }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [] });
			}
			if (p === "/api/push/classes") return json({ classes: { ask: true, alert: true, result: true, news: true, conv: true, log: false } });
			if (p === "/api/discord/post") {
				if (req.method !== "GET") {
					const b = (await req.json()) as Record<string, boolean>;
					h.puts.push(b);
					h.post = { ...h.post, ...b };
					queueMicrotask(settle);
				}
				return json(h.post);
			}
			if (p === "/api/accounts") return Response.json({ error: "no accounts here" }, { status: 404 });
			return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
		},
	});
	return h;
}
const on = hub(true), off = hub(false);

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterEach(() => { for (const v of views.splice(0)) v.close(); });
afterAll(() => { on.server.stop(true); off.server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
// Resolved by the fake hub when a write lands (timers run on the preload's fake clock, hub/runtime/test-clock.ts; the test timeout bounds the wait).
const waiters = new Set<{ ok: () => boolean; done: () => void }>();
function settle() { for (const w of waiters) if (w.ok()) { waiters.delete(w); w.done(); } }
const hubState = (ok: () => boolean) => new Promise<void>(done => { if (ok()) done(); else waiters.add({ ok, done }); });
async function settings(h: Hub, width: number, height: number, ready: string) {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${h.server.port}/`);
	await waitFor(v, `typeof S !== "undefined" && S && S.discord !== undefined`);
	await run(v, `go("settings")`);
	await waitFor(v, ready);
	return v;
}
const shot = async (v: View, name: string) => Bun.write(join(SHOTS, name), await v.screenshot());
const noOverflow = (v: View) => q<boolean>(v, `return document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...document.querySelectorAll("#settings .list")].every(l => l.scrollWidth <= l.clientWidth)`);

describe.each([[390, 844], [1280, 900]] as const)("at %ipx", (width, height) => {
	test("with Discord connected every class has a 디스코드로도 보내기 switch that sends its key", async () => {
		on.puts.length = 0;
		on.post = { ...on.post, alert: true, result: false };
		const v = await settings(on, width, height, `document.querySelectorAll(".hs-sw[data-dc]").length === 5`);
		expect(await q<string[][]>(v, `return [...document.querySelectorAll(".hs-sw[data-dc]")].map(b => [b.dataset.dc, b.getAttribute("aria-checked"), b.getAttribute("aria-label")])`)).toEqual([
			["ask", "true", "답변 필요 디스코드로도 보내기"], ["alert", "true", "경고 디스코드로도 보내기"], ["result", "false", "결과 디스코드로도 보내기"], ["news", "true", "새 소식 디스코드로도 보내기"], ["conv", "true", "대화 디스코드로도 보내기"]]);
		expect(await q<number>(v, `return document.querySelectorAll("[data-dc-hint]").length`)).toBe(0);
		await run(v, `document.querySelector('.hs-sw[data-k="alert"]').scrollIntoView({ block: "center" })`);
		await shot(v, `route-on-${width}.png`);
		await run(v, `document.querySelector('.hs-sw[data-dc="result"]').click()`);
		await hubState(() => on.puts.length === 1);
		expect(on.puts).toEqual([{ result: true }]);
		await waitFor(v, `document.querySelector('.hs-sw[data-dc="result"]').getAttribute("aria-checked") === "true"`);
		// alert is one key: the class row and the 디스코드에도 보내기 section row agree
		await run(v, `document.querySelector('.hs-sw[data-dc="alert"]').click()`);
		await hubState(() => on.puts.length === 2);
		expect(on.puts[1]).toEqual({ alert: false });
		await waitFor(v, `[...document.querySelectorAll(".hs-sw")].filter(b => /^(디스코드에도 알림 보내기|경고 디스코드로도 보내기)$/.test(b.getAttribute("aria-label"))).every(b => b.getAttribute("aria-checked") === "false")`);
		expect(await noOverflow(v)).toBe(true);
	}, 30_000);

	test("without Discord there are no such switches, only the one guidance row", async () => {
		const v = await settings(off, width, height, `document.querySelectorAll(".hs-sw[data-k]").length === 5`);
		expect(await q<number>(v, `return document.querySelectorAll(".hs-sw[data-dc]").length`)).toBe(0);
		expect(await q<number>(v, `return document.querySelectorAll("[data-dc-hint]").length`)).toBe(1);
		expect(await q<string>(v, `return document.querySelector("[data-dc-hint] .hd").textContent`)).toBe("디스코드로도 받으려면");
		await run(v, `document.querySelector('.hs-sw[data-k="alert"]').scrollIntoView({ block: "center" })`);
		await shot(v, `route-off-${width}.png`);
		expect(await noOverflow(v)).toBe(true);
		expect(off.puts.length).toBe(0);
	}, 30_000);
});
