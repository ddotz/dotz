// 앱 (web/js/30-apps.js): the list shows a user app with its running dot and the monitoring apps, and opening it puts the
// gateway-proxied page in the frame under the dotz header (back, name, status, 새 탭, ⋯), at 390 and 1280.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.T7_SHOTS ?? "/var/folders/80/2k5mvzgd4bncllljjdswkq7c0000gn/T/ux2run.bWW2O3bIEF/shots/t7";
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown) => Response.json(v);
const items = [
	{ id: "hdocs", label: "한컴 문서", kind: "tool", source: "manifest", icon: "file", status: "running", off: false, health: "/", watches: [], settings: { port: 4417 }, web: { url: "http://127.0.0.1:4417", path: "/", mode: "rewrite", href: "/apps/hdocs/" }, start: { command: "bun src/server.ts", cwd: "~/Code/hdocs/hdocs-web-live" } },
	{ id: "kakao", label: "카카오톡", kind: "monitor", source: "registry", icon: "chat", status: "running" },
];
const errors = [{ id: "broken", dir: "/tmp/custom/apps/broken", reason: "app.json을 읽을 수 없어요: Unexpected token" }];
const PAGE = `<!doctype html><html><head><title>fake hdocs</title></head><body><h1>가짜 문서 앱</h1><button id="appbtn">앱 안의 버튼</button></body></html>`;
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/apps") return json({ items, errors });
		if (url.pathname === "/apps/hdocs/" || url.pathname === "/apps/hdocs/index.html") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {} });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
		if (url.pathname === "/api/monitors") return json({ items: [] });
		if (url.pathname === "/api/integrations") return json({ items: [{ key: "kakao", app: "kakao", label: "카카오톡", kind: "app", icon: "chat", conv: [], unread: 0, unreplied: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } }], available: [] });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

const errorsSeen: string[] = [];
const view = new Bun.WebView({ width: 390, height: 844, console: (type: string, ...args: unknown[]) => { if (type === "error") errorsSeen.push(args.map(String).join(" ")); } } as ConstructorParameters<typeof Bun.WebView>[0]);
afterAll(() => { view.close(); server.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);

async function boot() {
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`typeof current !== "undefined" && typeof APPS !== "undefined" && APPS.loaded && S`);
	await view.evaluate(`(go("apps"), 0)`);
	await waitFor(`current === "apps" && APPS.loaded && $("#apps-side").children.length`);
}

describe("앱 at 390px", () => {
	test("lists the user app with its status and the monitoring app, and opens it in a frame under the header", async () => {
		await view.resize?.(390, 844);
		errorsSeen.length = 0;
		await boot();
		const list = await view.evaluate(`(() => $("#apps-side").innerText)()`) as string;
		expect(list).toContain("사용자 앱");
		expect(list).toContain("한컴 문서");
		expect(list).toContain("실행 중");
		expect(list).toContain("모니터링 앱");
		expect(list).toContain("카카오톡");
		expect(list).toContain("불러오지 못한 앱");
		expect(list).toContain("broken");
		expect(await view.evaluate(`(() => document.querySelectorAll("#apps-side .cv-row").length)()`)).toBe(3);
		expect(await view.evaluate(`(() => !!document.querySelector("#apps-side .app-dot.ok"))()`)).toBe(true);
		await Bun.write(join(SHOTS, "apps-list-390.png"), await view.screenshot());
		await view.evaluate(`(() => { [...document.querySelectorAll("#apps-side .cv-row")].find(b => b.dataset.k === "hdocs").click(); return 0; })()`);
		await waitFor(`!!document.querySelector("#apps-pane .apps-frame")`);
		expect(await view.evaluate(`(() => $("#apps-pane .apps-n").textContent)()`)).toBe("한컴 문서");
		expect(await view.evaluate(`(() => $("#apps-pane .apps-p").textContent)()`)).toContain("실행 중");
		expect(await view.evaluate(`(() => $("#apps-pane .apps-frame").getAttribute("src"))()`)).toBe("/apps/hdocs/");
		expect(await view.evaluate(`(() => !!$("#apps-pane a[target=_blank]"))()`)).toBe(true);
		expect(await view.evaluate(`(() => [...$("#apps-pane").querySelectorAll("button[aria-label='앱 메뉴'], button.apps-menu")].length)()`)).toBe(1);
		await waitFor(`(() => { try { return document.querySelector("#apps-pane .apps-frame").contentDocument.body.innerText.includes("가짜 문서 앱"); } catch { return false; } })()`);
		await Bun.write(join(SHOTS, "apps-open-390.png"), await view.screenshot());
		expect(await view.evaluate(`(location.hash)`)).toBe("#apps/hdocs");
		expect(errorsSeen).toEqual([]);
	}, 25_000);

	test("the menu shows 설정 / 끄기 / 제거, and 설정 shows the start command and the app's settings", async () => {
		await view.evaluate(`(() => { $("#apps-pane button[aria-label='앱 메뉴']").click(); return 0; })()`);
		await waitFor(`document.querySelector(".menu") && document.querySelector(".menu").innerText.includes("제거")`);
		const menu = await view.evaluate(`(() => document.querySelector(".menu").innerText)()`) as string;
		expect(menu).toContain("설정");
		expect(menu).toContain("끄기");
		expect(menu).toContain("제거");
		await view.evaluate(`(() => { [...document.querySelectorAll(".menu .mi")].find(b => b.textContent.trim() === "설정").click(); return 0; })()`);
		await waitFor(`document.querySelector("dialog[open]") && document.querySelector("dialog[open]").innerText.includes("bun src/server.ts")`);
		const dl = await view.evaluate(`(() => document.querySelector("dialog[open]").innerText)()`) as string;
		expect(dl).toContain("~/Code/hdocs/hdocs-web-live");
		expect(dl).toContain("4417");
		await view.evaluate(`(() => { document.querySelector("dialog[open]").close(); return 0; })()`);
	}, 25_000);
});

describe("앱 at 1280px", () => {
	test("keeps the list beside the open app, the same row style as 모니터링", async () => {
		await view.resize?.(1280, 900);
		errorsSeen.length = 0;
		await view.evaluate(`(go("apps"), 0)`);
		await waitFor(`current === "apps" && !!document.querySelector("#apps-pane .apps-frame")`);
		expect(await view.evaluate(`(() => { const s = $("#apps-side").getBoundingClientRect(), p = $("#apps-pane").getBoundingClientRect(); return s.right <= p.left + 1 && s.width > 120; })()`)).toBe(true);
		expect(await view.evaluate(`(() => $("#apps-pane .apps-frame").getBoundingClientRect().height > 300)()`)).toBe(true);
		await waitFor(`(() => { try { return document.querySelector("#apps-pane .apps-frame").contentDocument.body.innerText.includes("가짜 문서 앱"); } catch { return false; } })()`);
		expect(await view.evaluate(`(() => !!$("#apps-pane button[aria-label='앱 목록']"))()`)).toBe(false);
		await Bun.write(join(SHOTS, "apps-open-1280.png"), await view.screenshot());
		expect(errorsSeen).toEqual([]);
	}, 25_000);
});
