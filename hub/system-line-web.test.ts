// The web chat draws a gateway system line (an event with `system`, hub/outbound.ts systemNote) as one small centered line with no
// bubble or author (web/js/11-todo-strip.js sysLine): it shows its worker's state from /api/state `work`, updated in place, opens that
// worker when tapped, and is never unread.
import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 6, min)).toISOString();
const SYS = { ts: at(2), kind: "out", source: "gateway", target: "web", text: "백그라운드 작업으로 맡겼어요: 홈 진행 중 목록 다듬기", system: "deferred", worker: "st_w1" };
const HISTORY = [
	{ ts: at(1), kind: "message", source: "web", channel: "web", text: "홈 진행 중 목록 좀 다듬어 줘", mid: "m1" },
	SYS,
	{ ts: at(3), kind: "out", source: "orchestrator", target: "web", text: "다듬었어요." },
];
let WORK: Record<string, unknown>[] = [{ id: "st_w1", status: "running", description: "홈 진행 중 목록 다듬기", target: "web", started_at: Date.now() - 60_000 }];
const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, work: WORK, work_now: Date.now(), runs: { main: { kind: "idle" } } });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/conversations") return json({ items: [{ target: "main", unread: 0, read: null, last: null }] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? HISTORY : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/todo") return json({ phases: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);

test("a system event is a compact line with its worker's live state, opens the worker, and is not unread", async () => {
	const v = new Bun.WebView({ width: 390, height: 800 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/?sys=1#chat`);
	await waitFor(v, `S && S.work && document.querySelector("#tl .cv-sys")`);
	const line = await v.evaluate(`(() => { const n = $("#tl .cv-sys"); return { tag: n.tagName, bubble: !!n.closest(".bm") || !!n.querySelector(".mn"), text: n.querySelector(".cv-sys-tx").textContent, st: n.querySelector(".cv-sys-st").hidden ? "" : n.querySelector(".cv-sys-st").textContent, bms: [...document.querySelectorAll("#tl .bm")].map(b => b.textContent).filter(t => t.includes("맡겼어요")).length }; })()`);
	expect(line).toEqual({ tag: "BUTTON", bubble: false, text: "백그라운드 작업으로 맡겼어요: 홈 진행 중 목록 다듬기", st: "진행 중", bms: 0 });
	expect(await v.evaluate(`convIncoming(${JSON.stringify(SYS)})`)).toBe(false);
	WORK = [{ ...WORK[0], status: "done", ended_at: Date.now() }];
	await v.evaluate(`refreshState().then(() => true)`);
	await waitFor(v, `$("#tl .cv-sys .cv-sys-st").textContent === "끝남"`);
	await v.evaluate(`($("#tl .cv-sys").click(), 0)`);
	await waitFor(v, `SUBD && SUBD.id === "st_w1"`);
}, 20_000);
