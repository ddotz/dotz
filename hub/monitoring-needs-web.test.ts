import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The 앱 rows of the 모니터링 list say what waits on the owner (web/js/30-monitoring.js monNeedLine), never the latest item's title.
// Headless (Bun.WebView) against a small fake hub whose /api/integrations carries the counts (hub/integrations.ts needs). Set NEEDS_SHOTS=<dir> to keep screenshots.
const SHOTS = process.env.NEEDS_SHOTS ?? "";
const json = (v: unknown, status = 200) => Response.json(v, { status });
const now = new Date().toISOString();
const ITEMS = [
	{ key: "mail", label: "메일", icon: "mail", conv: ["mail:"], unread: 5, notices: [], needs: { drafts: 2, unread: 3, sentToday: 4 } },
	{ key: "kakao", label: "카카오톡", icon: "kakao", conv: [], unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } },
	{ key: "youtube", label: "유튜브", icon: "youtube", conv: [], unread: 2, notices: [], needs: { drafts: 0, unread: 2, sentToday: 0 } },
];
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
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		if (url.pathname === "/api/monitors") return json({ items: [] });
		if (url.pathname === "/api/integrations") return json({ items: ITEMS });
		if (url.pathname === "/api/conversations") return json({ items: [{ target: "mail:fx-1", unread: 3, last: { ts: now, text: "[광고] 일일 환율 안내", from: "bot" }, mail: { subject: "[광고] 일일 환율 안내", from: "Bank <b@example.com>", source: "fx", at: now } }] });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});
const until = (cond: string, what: string) => `new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = (${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > 10000) rej(new Error(${JSON.stringify(what)})); else requestAnimationFrame(tick); }; tick(); })`;

for (const width of [1440, 390]) {
	test(`app rows at ${width}px: the action line and the waiting badge, no item title`, async () => {
		const v = new Bun.WebView({ width, height: 900 });
		views.push(v);
		await v.navigate(`http://127.0.0.1:${server.port}/`);
		await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
		await v.navigate(`http://127.0.0.1:${server.port}/?light#monitoring`);
		await v.evaluate(until(`current === "monitoring" && INTG.items.length === 3 && CV.loaded && document.querySelectorAll("#mon-side .cv-row, #mon-list .cv-row").length >= 3`, "rows not drawn"));
		const got = JSON.parse((await v.evaluate(`JSON.stringify(monRows(monItems(), null).filter(r => r.k && r.k.startsWith("i:")).map(r => [r.k, r.hint, r.unread]))`)) as string);
		expect(got).toEqual([["i:mail", "답장 확인 2건 · 안 읽음 3", 2], ["i:kakao", "확인할 것 없어요", 0], ["i:youtube", "안 읽음 2", 2]]);
		const text = (await v.evaluate(`document.body.innerText`)) as string;
		expect(text).toContain("답장 확인 2건 · 안 읽음 3");
		expect(text).not.toContain("일일 환율");
		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await Bun.write(`${SHOTS}/needs-${width}.png`, await v.screenshot());
		}
	});
}
