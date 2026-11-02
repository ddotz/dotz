import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 홈 지금 진행 중 (web/js/08-home.js homeLimitRow): work deferred to the usage-limit reset (/api/state `deferred`, hub/limitwait.ts) is a row
// with the badge drawn from resume_at, styled like the other rows' status (.hs); a legacy time prefix in `what` is not shown again.
let deferred: unknown[] = [
	{ id: "ui-fix", lane: "ui-fix", what: "[한도 리셋 뒤 재개 14:30] UI 정리", resume_at: "2026-11-02T05:30:00.000Z" },
];
const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, deferred });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { view.close(); server.stop(true); });
const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(code: string): Promise<T> => JSON.parse((await view.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const ROW = `document.querySelector('#home-now [data-k="running"] [data-wait="ui-fix"]')`;

test("a deferred task is a 지금 진행 중 row with the badge '한도 리셋되면 재개 (HH:MM)', its name without the legacy prefix", async () => {
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`S && current === "home" && ${ROW}`);
	expect(await q(`return ${ROW}.querySelector(".hs").textContent`)).toBe("한도 리셋되면 재개 (14:30)");
	expect(await q(`return ${ROW}.querySelector(".nm").textContent`)).toBe("UI 정리");
	expect(await q(`return !!document.querySelector('#home-now [data-k="running"] .empty')`)).toBe(false);
}, 15_000);

test("once the work starts (deferred is empty) the row and its badge are gone", async () => {
	deferred = [];
	await view.evaluate(`refreshState()`);
	await waitFor(`!${ROW}`);
	expect(await q(`return document.querySelector('#home-now [data-k="running"]').textContent`)).not.toContain("한도 리셋되면 재개");
}, 15_000);
