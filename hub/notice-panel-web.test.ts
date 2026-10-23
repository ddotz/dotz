import { afterAll, describe, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The 홈 알림 card lists alerts only (owner 2026-10-23): a reply in a conversation (a monitor's settings conversation, a session) is unread in
// that conversation, which the 채팅 tab leads to, not a notice on 홈. Each listed alert opens where it was posted and leaves the count.
const base = { tone: "", read: false };
const items = [
	{ ...base, id: "de63c481", kind: "message", title: "NAS 패치 감시", text: "네, 아직 새 버전이 없어요", open: "settings:w:nas-php-node-patch", src: "settings:w:nas-php-node-patch", key: "msg:settings:w:nas-php-node-patch", at: "2026-10-23T01:00:03.000Z", ts: "2026-10-23T01:00:00.000Z", updated: "2026-10-23T01:00:03.000Z" },
	{ ...base, id: "a1e47c00", kind: "alert", title: "알림", text: "NAS 디스크 공간이 10% 남았어요", open: "alert", src: "alert", at: "2026-10-23T00:50:00.000Z", ts: "2026-10-23T00:50:00.000Z", updated: "2026-10-23T00:50:00.000Z" },
	{ ...base, id: "5e551011", kind: "result", tone: "done", title: "메일 답장 초안", text: "머지했어요", open: "lane:mail-reply-drafts", src: "lane:mail-reply-drafts", key: "lane:mail-reply-drafts", ts: "2026-10-22T00:50:00.000Z", updated: "2026-10-22T00:50:00.000Z" },
];

const json = (v: unknown) => Response.json(v);
const unread = () => items.filter(n => !n.read).length;
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
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unread() });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: unread(), items });
		if (url.pathname === "/api/update") return json({ settings: { auto_apply: false } });
		if (url.pathname === "/api/notices/read") return req.json().then((b: { ids?: string[] }) => { for (const n of items) if (b.ids?.includes(n.id)) n.read = true; return json({ unread: unread() }); });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

const view = new Bun.WebView({ width: 1100, height: 800 } as ConstructorParameters<typeof Bun.WebView>[0]);
afterAll(() => { view.close(); server.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const alertCard = `[...document.querySelectorAll(".hc")].find(c => c.querySelector("h3").textContent === "알림")`;
const boot = async () => {
	for (const n of items) n.read = false;
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && S && current === "home" && ${alertCard} && ${alertCard}.querySelector(".hc-row")`);
};
const panel = () => view.evaluate(`JSON.stringify({ big: ${alertCard}.querySelector(".big").textContent, rows: [...${alertCard}.querySelectorAll(".hc-row")].map(r => r.querySelector(".t").textContent), unread: NT.unread })`).then(v => JSON.parse(v as string) as { big: string; rows: string[]; unread: number });

describe("the 알림 panel and its count", () => {
	test("lists only the alert; replies of conversations and sessions are not notices there", async () => {
		await boot();
		const p = await panel();
		expect(p.big).toBe("1개");
		expect(p.rows).toEqual(["NAS 디스크 공간이 10% 남았어요"]);
	});

	test("the alert opens the 알림 conversation", async () => {
		await boot();
		await view.evaluate(`noticeOpen(ntById("a1e47c00"))`);
		await waitFor(`current === "chat" && target === "alert"`);
	});

	test("a settings conversation reply still opens the monitor's conversation", async () => {
		await boot();
		await view.evaluate(`noticeOpen(ntById("de63c481"))`);
		await waitFor(`current === "chat" && target === "settings:w:nas-php-node-patch" && monCtx === target && ntById("de63c481").read`);
	});
});
