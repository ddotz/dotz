import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The owner's custom cards on 홈 (web/custom.js) are items of the home board, in a headless browser at 1100px: the same drag handle,
// resize grip and ⋯ menu as every other card, size and place kept in localStorage across a reload, and card values shown as people read
// them (an ISO date-time in local time, an empty value as 없음).
const lanes = [{ name: "lane0", status: "idle", live: true, alive: true }];
const longAgo = new Date(Date.now() - 30 * 3600_000).toISOString();
const cards = [
	{ id: "kakao", title: "카톡", view: "kv", data: { 연결: "켜짐", 설정: "진행 중: -", "마지막 확인": longAgo, "답장 대기": "-" }, actions: [{ label: "지금 확인" }], rev: "1" },
	{ id: "todo", title: "오늘 할 일", view: "stat", data: { value: "7", label: "남은 일", sub: longAgo }, actions: [], rev: "1" },
];

const live = process.env.DOTZ_WEB_LIVE;
beforeAll(() => { process.env.DOTZ_WEB_LIVE = "1"; });
afterAll(() => { if (live === undefined) delete process.env.DOTZ_WEB_LIVE; else process.env.DOTZ_WEB_LIVE = live; });

const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		if (url.pathname === "/custom.js") return new Response(Bun.file(new URL("../web/custom.js", import.meta.url).pathname), { headers: { "content-type": "text/javascript" } });
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
		if (url.pathname === "/api/custom") return json({ dir: "~/.dotz/custom", cards, projects: [], routines: [], links: [] });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

const view = new Bun.WebView({ width: 1100, height: 800 } as ConstructorParameters<typeof Bun.WebView>[0]);
afterAll(() => { view.close(); server.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else setTimeout(tick, 30); }; tick(); })`);
const frames = (n = 12) => view.evaluate(`new Promise(r => { let i = 0; const f = () => ++i >= ${n} ? r(1) : requestAnimationFrame(f); f(); })`);
const boot = async (card = "kakao") => {
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`current === "home" && S && document.querySelector('.bi[data-id="custom:${card}"] .cu-card')`);
	await frames();
};
const saved = () => view.evaluate(`JSON.parse(localStorage.getItem("dotz-board-home") || "{}")["custom:kakao"] || null`) as Promise<{ x: number; y: number; w: number; h: number } | null>;
const width = () => view.evaluate(`document.querySelector('.bi[data-id="custom:kakao"]').getBoundingClientRect().width`) as Promise<number>;
// A pointer gesture: down on the middle of `sel`, a move to each point (client coordinates), up at the last one.
const drag = (sel: string, points: [number, number][]) => view.evaluate(`(async () => {
	const ev = (type, x, y, t) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y }));
	const raf = () => new Promise(r => requestAnimationFrame(r));
	const el = document.querySelector(${JSON.stringify(sel)}), r = el.getBoundingClientRect();
	ev("pointerdown", r.left + r.width / 2, r.top + r.height / 2, el);
	for (const [x, y] of ${JSON.stringify(points)}) { ev("pointermove", x, y, window); await raf(); }
	const last = ${JSON.stringify(points)}.at(-1);
	ev("pointerup", last[0], last[1], window);
	await raf();
})()`);

describe("custom cards on 홈", () => {
	test("local time and empty values are formatted by generic rules", async () => {
		await boot();
		const out = (await view.evaluate(`(() => {
			const now = new Date(2026, 9, 22, 15, 0), at = (y, m, d, h, mi) => new Date(y, m, d, h, mi).toISOString();
			const f = (iso) => dotzCustom.fmt(iso, now);
			return JSON.stringify([f(at(2026, 9, 22, 14, 31)), f(at(2026, 9, 22, 9, 5)), f(at(2026, 9, 21, 9, 5)), f(at(2026, 0, 2, 9, 5)), f(at(2025, 11, 30, 9, 5)),
				dotzCustom.show("-"), dotzCustom.show(null), dotzCustom.show("진행 중: -"), dotzCustom.show("확인 " + at(2026, 9, 22, 9, 5) + " (실패 1번)"), dotzCustom.show("켜짐")]);
		})()`)) as string;
		expect(JSON.parse(out)).toEqual(["29분 전", "09:05", "어제 09:05", "1월 2일 09:05", "2025년 12월 30일 09:05", "없음", "없음", "진행 중: 없음", "확인 09:05 (실패 1번)", "켜짐"]);
	});

	test("a card shows no ISO text and no bare dash", async () => {
		await boot();
		const text = (await view.evaluate(`document.querySelector('.bi[data-id="custom:kakao"]').innerText`)) as string;
		expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
		expect(text).toContain("답장 대기");
		expect(text).toContain("없음");
	});

	test("the card is a board item with a grip, a drag handle and a ⋯ menu", async () => {
		await boot();
		expect(await view.evaluate(`!!document.querySelector('.bi[data-id="custom:kakao"] .brz.se') && !!document.querySelector('.bi[data-id="custom:kakao"] .cu-th.bhead') && !!document.querySelector('.bi[data-id="custom:kakao"] .cu-th .ib')`)).toBe(true);
		const w = await width(), main = (await view.evaluate(`document.querySelector('.bi[data-id="main"]').getBoundingClientRect().width`)) as number;
		expect(w).toBeLessThan(500);
		expect(Math.abs(w - main)).toBeLessThan(2);
	});

	test("resizing and moving the card persist across a reload", async () => {
		await view.evaluate(`localStorage.removeItem("dotz-board-home")`);
		await boot();
		const before = (await saved())!;
		const left = (await view.evaluate(`(() => { const w = document.querySelector('.bi[data-id="custom:kakao"]'), t = w.querySelector(".cu-t").getBoundingClientRect(), wr = w.getBoundingClientRect(), cr = document.querySelector("#home-cards").getBoundingClientRect(); return [cr.left + (t.left + t.width / 2 - wr.left) + 4, t.top + t.height / 2]; })()`)) as [number, number];
		await drag('.bi[data-id="custom:kakao"] .cu-th .cu-t', [[left[0] + 30, left[1] + 20], left]);
		await frames();
		expect((await saved())!.x).toBe(0);
		const w0 = await width();
		const grip = (await view.evaluate(`(() => { const r = document.querySelector('.bi[data-id="custom:kakao"] .brz.se').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)) as [number, number];
		await drag('.bi[data-id="custom:kakao"] .brz.se', [[grip[0] + 120, grip[1] + 40], [grip[0] + 240, grip[1] + 80]]);
		const resized = (await saved())!;
		expect(resized.w).toBeGreaterThan(before.w);
		expect(await width()).toBeGreaterThan(w0 + 50);
		const title = (await view.evaluate(`(() => { const t = document.querySelector('.bi[data-id="custom:kakao"] .cu-t').getBoundingClientRect(); return [t.left + t.width / 2, t.top + t.height / 2]; })()`)) as [number, number];
		await drag('.bi[data-id="custom:kakao"] .cu-th .cu-t', [[title[0] + 5, title[1] - 120], [title[0] + 5, title[1] - 300]]);
		await frames();
		const moved = (await saved())!;
		expect(moved.w).toBe(resized.w);
		expect(moved.y).toBeLessThan(resized.y);
		const w1 = await width();
		await boot();
		expect(await saved()).toEqual(moved);
		expect(Math.abs((await width()) - w1)).toBeLessThan(2);
	});

	test("the ⋯ menu lists size presets and hide, and 배치 초기화 brings a hidden card back", async () => {
		await view.evaluate(`localStorage.removeItem("dotz-board-home")`);
		await boot();
		const labels = (await view.evaluate(`dotzCustom.menuActs("kakao").map(a => a.label)`)) as string[];
		expect(labels).toEqual(["새로고침", "작게", "보통", "크게", "숨기기"]);
		await view.evaluate(`(() => { dotzCustom.menuActs("kakao").find(a => a.label === "숨기기").run(); })()`);
		await waitFor(`!document.querySelector('.bi[data-id="custom:kakao"]')`);
		await boot("todo");
		expect(await view.evaluate(`!!document.querySelector('.bi[data-id="custom:kakao"]')`)).toBe(false);
		await view.evaluate(`document.querySelector(".bbar .btn").click()`);
		await waitFor(`document.querySelector('.bi[data-id="custom:kakao"]')`);
	});
});
