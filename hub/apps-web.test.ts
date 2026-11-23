import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.T7_SHOTS ?? join(tmpdir(), "dotz-shots", "apps");
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown) => Response.json(v);
const items = [
	{ id: "mydocs", label: "문서 도구", kind: "tool", source: "manifest", icon: "file", status: "running", off: false, health: "/", watches: [], settings: { port: 4417 }, web: { url: "http://127.0.0.1:4417", path: "/", mode: "rewrite", href: "/apps/mydocs/" }, start: { command: "bun src/server.ts", cwd: "~/Code/my-docs" } },
	{ id: "kakao", label: "카카오톡", kind: "monitor", source: "registry", icon: "chat", status: "running" },
];
const errors = [{ id: "broken", dir: "/tmp/custom/apps/broken", reason: "app.json을 읽을 수 없어요: Unexpected token" }];
const PAGE = `<!doctype html><html><head><title>fake docs tool</title></head><body><h1>가짜 문서 앱</h1><button id="appbtn">앱 안의 버튼</button></body></html>`;
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
		if (url.pathname === "/apps/mydocs/" || url.pathname === "/apps/mydocs/index.html") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
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
	await view.evaluate(`(go("monitoring"), 0)`);
	await waitFor(`current === "monitoring" && MON.list && document.querySelector('#mon-side [data-k="x:mydocs"]')`);
}

describe("앱 tab at 390px", () => {
	test("lists the web app with its status word and the app that failed to load, and opens the web app in a frame under the header", async () => {
		await view.resize?.(390, 844);
		errorsSeen.length = 0;
		await boot();
		const list = await view.evaluate(`(() => $("#mon-side").innerText)()`) as string;
		expect(list).toContain("문서 도구");
		expect(list).toContain("실행 중");
		expect(list).toContain("카카오톡");
		expect(list).toContain("broken");
		expect(list).toContain("오류");
		expect(list).toContain("app.json을 읽을 수 없어요");
		expect(await view.evaluate(`(() => ["x:mydocs", "i:kakao", "xe:broken"].map(k => !!document.querySelector('#mon-side .cv-row[data-k="' + k + '"]')))()`)).toEqual([true, true, true]);
		expect(await view.evaluate(`(() => !!document.querySelector("#mon-side .cv-row .tag.ok") && !document.querySelector("#mon-side .app-dot"))()`)).toBe(true);
		await Bun.write(join(SHOTS, "apps-list-390.png"), await view.screenshot());
		await view.evaluate(`(() => { document.querySelector('#mon-side .cv-row[data-k="x:mydocs"]').click(); return 0; })()`);
		await waitFor(`!!document.querySelector("#mon-app .apps-frame") && $("#mon-app").offsetWidth > 0`);
		expect(await view.evaluate(`(() => $("#title").textContent)()`)).toBe("문서 도구");
		expect(await view.evaluate(`(() => $("#mon-app .apps-p").textContent)()`)).toContain("실행 중");
		expect(await view.evaluate(`(() => $("#mon-app .apps-frame").getAttribute("src"))()`)).toBe("/apps/mydocs/");
		expect(await view.evaluate(`(() => !!$("#mon-app a[target=_blank]"))()`)).toBe(true);
		expect(await view.evaluate(`(() => [...$("#mon-app").querySelectorAll("button[aria-label='앱 메뉴'], button.apps-menu")].length)()`)).toBe(1);
		await waitFor(`(() => { try { return document.querySelector("#mon-app .apps-frame").contentDocument.body.innerText.includes("가짜 문서 앱"); } catch { return false; } })()`);
		await Bun.write(join(SHOTS, "apps-open-390.png"), await view.screenshot());
		expect(await view.evaluate(`(location.hash)`)).toBe("#monitoring/x%3Amydocs");
		expect(errorsSeen).toEqual([]);
	}, 25_000);

	test("the menu shows 설정 / 끄기 / 제거, and 설정 shows the start command and the app's settings", async () => {
		await view.evaluate(`(() => { $("#mon-app button[aria-label='앱 메뉴']").click(); return 0; })()`);
		await waitFor(`document.querySelector(".menu") && document.querySelector(".menu").innerText.includes("제거")`);
		const menu = await view.evaluate(`(() => document.querySelector(".menu").innerText)()`) as string;
		expect(menu).toContain("설정");
		expect(menu).toContain("끄기");
		expect(menu).toContain("제거");
		await view.evaluate(`(() => { [...document.querySelectorAll(".menu .mi")].find(b => b.textContent.trim() === "설정").click(); return 0; })()`);
		await waitFor(`document.querySelector("dialog[open]") && document.querySelector("dialog[open]").innerText.includes("bun src/server.ts")`);
		const dl = await view.evaluate(`(() => document.querySelector("dialog[open]").innerText)()`) as string;
		expect(dl).toContain("~/Code/my-docs");
		expect(dl).toContain("4417");
		await view.evaluate(`(() => { document.querySelector("dialog[open]").close(); return 0; })()`);
	}, 25_000);

	test("the app that failed to load opens in the pane with why and where, and 다시 확인 asks the gateway again", async () => {
		await view.evaluate(`(go("monitoring"), 0)`);
		await waitFor(`MON.list && document.querySelector('#mon-side .cv-row[data-k="xe:broken"]')`);
		await view.evaluate(`(() => { document.querySelector('#mon-side .cv-row[data-k="xe:broken"]').click(); return 0; })()`);
		await waitFor(`!!document.querySelector("#mon-app .apps-err") && $("#mon-app").offsetWidth > 0`);
		expect(await view.evaluate(`(() => $("#title").textContent)()`)).toBe("broken");
		const card = await view.evaluate(`(() => $("#mon-app .apps-err").innerText)()`) as string;
		expect(card).toContain("앱을 불러오지 못했어요");
		expect(card).toContain("app.json을 읽을 수 없어요: Unexpected token");
		expect(card).toContain("/tmp/custom/apps/broken");
		expect(await view.evaluate(`(() => $("#mon-app .apps-err .btn").textContent)()`)).toBe("다시 확인");
		await view.evaluate(`(() => { window.__reads = 0; const ask = api; api = (...a) => { if (String(a[0]).startsWith("/api/apps")) window.__reads++; return ask(...a); }; $("#mon-app .apps-err .btn").click(); return 0; })()`);
		await waitFor(`window.__reads > 0 && !$("#mon-app .apps-err .btn").disabled`);
		expect(await view.evaluate(`(() => !!$("#mon-app .apps-err"))()`)).toBe(true);
	}, 25_000);

	test("다시 확인 after the manifest was fixed opens the app in the same pane at #monitoring/x:<id>", async () => {
		const failed = errors.splice(0, 1);
		items.push({ ...items[0]!, id: "broken", label: "고친 앱", web: { ...items[0]!.web!, href: "/apps/mydocs/" } });
		try {
			await view.evaluate(`(() => { $("#mon-app .apps-err .btn").click(); return 0; })()`);
			await waitFor(`MON.sel === "x:broken" && !MON.list && !!document.querySelector("#mon-app iframe.apps-frame") && location.hash.endsWith("broken")`);
			expect(await view.evaluate(`(() => [location.hash, $("#title").textContent, !!$("#mon-app .apps-err")])()`)).toEqual(["#monitoring/x%3Abroken", "고친 앱", false]);
		} finally {
			items.pop();
			errors.push(...failed);
			await view.evaluate(`(loadApps(), 0)`);
		}
	}, 25_000);
});

describe("앱 tab at 1280px", () => {
	test("keeps the list beside the open web app, the same row style as 모니터링", async () => {
		await view.resize?.(1280, 900);
		errorsSeen.length = 0;
		await view.evaluate(`(go("monitoring", "x:mydocs"), 0)`);
		await waitFor(`current === "monitoring" && !!document.querySelector("#mon-app .apps-frame") && $("#mon-app").offsetWidth > 0`);
		expect(await view.evaluate(`(() => { const s = $("#mon-side").getBoundingClientRect(), p = $("#mon-app").getBoundingClientRect(); return s.right <= p.left + 1 && s.width > 120; })()`)).toBe(true);
		expect(await view.evaluate(`(() => $("#mon-app .apps-frame").getBoundingClientRect().height > 300)()`)).toBe(true);
		expect(await view.evaluate(`(() => $("#mon-app .apps-n").textContent)()`)).toBe("문서 도구");
		expect(await view.evaluate(`(() => $("#mon-app .apps-p").textContent)()`)).toContain("실행 중");
		await waitFor(`(() => { try { return document.querySelector("#mon-app .apps-frame").contentDocument.body.innerText.includes("가짜 문서 앱"); } catch { return false; } })()`);
		expect(await view.evaluate(`(() => $("#mon-app .apps-hd").querySelectorAll(".ib").length)()`)).toBe(2);
		await Bun.write(join(SHOTS, "apps-open-1280.png"), await view.screenshot());
		expect(errorsSeen).toEqual([]);
	}, 25_000);
});

describe("old #apps addresses", () => {
	const fresh: InstanceType<typeof Bun.WebView>[] = [];
	afterAll(() => { for (const v of fresh) v.close(); });
	const waitOn = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
		v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
	const open = async (width: number, height: number, hash = "") => {
		const v = new Bun.WebView({ width, height });
		fresh.push(v);
		await v.navigate(`http://127.0.0.1:${server.port}/${hash}`);
		await waitOn(v, `typeof APPS !== "undefined" && APPS.loaded && S && typeof current === "string"`);
		return v;
	};
	const state = async (v: InstanceType<typeof Bun.WebView>) => JSON.parse(await v.evaluate(`JSON.stringify({ current, list: MON.list, sel: MON.list ? "" : MON.sel, lit: !!document.querySelector("#v-monitoring .cv-row.on"), frame: !!document.querySelector("#mon-app .apps-frame"), tab: [...document.querySelectorAll("#nav .ni.on")].map(b => b.dataset.view) })`) as string);

	test("a stored #apps/<id> opens the web app in the 앱 tab, and #apps opens the list", async () => {
		const v = await open(1280, 900, "#apps/mydocs");
		await waitOn(v, `current === "monitoring" && !!document.querySelector("#mon-app .apps-frame")`);
		expect(await state(v)).toEqual({ current: "monitoring", list: false, sel: "x:mydocs", lit: true, frame: true, tab: ["monitoring"] });
		expect(await v.evaluate(`location.hash`)).toBe("#monitoring/x%3Amydocs");
		await v.evaluate(`(location.hash = "#apps", true)`);
		await waitOn(v, `MON.list && location.hash === "#monitoring"`);
		expect(await state(v)).toMatchObject({ current: "monitoring", list: true, lit: false, tab: ["monitoring"] });
	}, 25_000);

	test("an #apps/<id> that names no installed app opens the list with nothing selected", async () => {
		const v = await open(1280, 900, "#apps/nope");
		await waitOn(v, `current === "monitoring" && MON.list && document.querySelector('#mon-side [data-k="x:mydocs"]')`);
		expect(await state(v)).toEqual({ current: "monitoring", list: true, sel: "", lit: false, frame: false, tab: ["monitoring"] });
	}, 25_000);
});

describe("앱 is drawn only while shown", () => {
	const fresh: InstanceType<typeof Bun.WebView>[] = [];
	afterAll(() => { for (const v of fresh) v.close(); });
	const waitOn = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
		v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
	const open = async (width: number, height: number) => {
		const v = new Bun.WebView({ width, height });
		fresh.push(v);
		await v.navigate(`http://127.0.0.1:${server.port}/`);
		await waitOn(v, `typeof APPS !== "undefined" && APPS.loaded && S && current === "home"`);
		return v;
	};

	test("the bar has four tabs and the 앱 tab is the third", async () => {
		const v = await open(1280, 900);
		const got = JSON.parse(await v.evaluate(`JSON.stringify({ order: [...document.querySelectorAll("#nav .ni")].map(b => b.dataset.view), apps: !!document.querySelector('#nav .ni[data-view="apps"]') })`) as string);
		expect(got).toEqual({ order: ["home", "chat", "monitoring", "settings"], apps: false });
	}, 25_000);

	test("wide: nothing is built behind 홈, and the app draws its frame as soon as it is entered", async () => {
		const v = await open(1280, 900);
		expect(await v.evaluate(`!!document.querySelector("#mon-app .apps-frame")`)).toBe(false);
		expect(await v.evaluate(`(go("monitoring", "x:mydocs"), !!document.querySelector("#mon-app .apps-frame"))`)).toBe(true);
	}, 25_000);

	test("phone: an open app, then 홈, then 앱 shows the list", async () => {
		const v = await open(390, 844);
		expect(await v.evaluate(`!!document.querySelector("#mon-app .apps-frame")`)).toBe(false);
		await v.evaluate(`(go("monitoring", "x:mydocs"), 0)`);
		await waitOn(v, `!!document.querySelector("#mon-app .apps-frame") && $("#mon-app").offsetWidth > 0`);
		await v.evaluate(`(go("home"), 0)`);
		const got = JSON.parse(await v.evaluate(`(go("monitoring"), JSON.stringify({ list: MON.list, hash: location.hash, side: document.querySelector("#mon-side").getBoundingClientRect().width > 0, app: $("#mon-app").offsetWidth > 0 }))`) as string);
		expect(got).toEqual({ list: true, hash: "#monitoring", side: true, app: false });
	}, 25_000);
});
