// The 캔버스 (web/js/30-canvas.js) in a headless Bun.WebView against the real /api/canvas route (hub/files.ts canvasRoute): an HTML
// result file in the chat opens beside the conversation (a full-screen sheet on a phone) under the 앱 screen's header, the page's own
// script does not run, and Cmd+click picks its elements into the composer like the 앱 frame (15-picker.js).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasRoute, fileRoute } from "./files.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.CANVAS_SHOTS ?? join(tmpdir(), "dotz-shots", "canvas");
mkdirSync(SHOTS, { recursive: true });
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "canvas-web-")));
const PAGE = join(ROOT, "report.html");
writeFileSync(PAGE, `<!doctype html><html><head><title>주간 보고서</title><style>body{font:15px/1.6 sans-serif;margin:28px;color:#191f28}h1{font-size:24px}button{padding:10px 16px;border:0;border-radius:10px;background:#3182f6;color:#fff;font-size:15px}</style></head><body>
<h1>주간 보고서</h1><p id="intro">이번 주 처리한 일을 정리했어요.</p><button id="save" onclick="window.saved=(window.saved||0)+1">저장</button>
<script>window.ran = 1; document.body.dataset.ran = "1";</script></body></html>`);
writeFileSync(join(ROOT, "notes.txt"), "not html");
const json = (v: unknown) => Response.json(v);
const HIST = [{ ts: new Date(Date.now() - 60_000).toISOString(), kind: "out", source: "orchestrator", text: `[done] 보고서를 만들었어요\n[file] ${PAGE}` }];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/canvas") return canvasRoute(req, url, [ROOT], new Set());
		if (p === "/api/file") return fileRoute(req, url, [ROOT], new Set());
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {} });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: HIST });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/apps") return json({ items: [], errors: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); rmSync(ROOT, { recursive: true, force: true }); });
const waitOn = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const get = async (v: InstanceType<typeof Bun.WebView>, body: string) => JSON.parse(await v.evaluate(`JSON.stringify((() => { ${body} })())`) as string);
const FD = `const f = document.querySelector("#canvas .apps-frame"), d = f.contentDocument, w = d.defaultView;`;
const AT = `const at = id => { const r = d.getElementById(id).getBoundingClientRect(); return { clientX: r.left + 8, clientY: r.top + 8, bubbles: true, cancelable: true, composed: true }; };`;
const CHIP = `[...document.querySelectorAll("#timeline .fatt")].find(c => c.textContent.includes("report.html"))`;

async function open(width: number, height: number, theme: "light" | "dark") {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/#chat`);
	await waitOn(v, `typeof canvasOpen === "function" && ${CHIP} && !${CHIP}.classList.contains("off")`);
	await v.evaluate(`(document.documentElement.dataset.theme = ${JSON.stringify(theme)}, ${CHIP}.click(), 0)`);
	await waitOn(v, `(() => { try { const d = document.querySelector("#canvas .apps-frame").contentDocument; return d.body.innerText.includes("주간 보고서") && d.__pkBound; } catch { return false; } })()`);
	return v;
}
const head = (v: InstanceType<typeof Bun.WebView>) => get(v, `const c = document.querySelector("#canvas"), r = c.getBoundingClientRect(), h = c.querySelector(".apps-hd");
	return { name: h.querySelector(".apps-n").textContent, sub: h.querySelector(".apps-p").textContent, hint: (h.querySelector(".pk-hint") || {}).textContent || "",
		buttons: [...h.querySelectorAll(".ib")].map(b => b.getAttribute("aria-label")), font: getComputedStyle(h.querySelector(".apps-n")).fontSize,
		box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], ran: !!document.querySelector("#canvas .apps-frame").contentDocument.body.dataset.ran };`);

describe("캔버스 at 1280px", () => {
	for (const theme of ["light", "dark"] as const) test(`an HTML result opens beside the conversation under the 앱 header (${theme})`, async () => {
		const v = await open(1280, 900, theme);
		const h = await head(v);
		expect({ ...h, box: undefined }).toEqual({ name: "report.html", sub: expect.stringMatching(/^HTML · .*report\.html$/), hint: "⌘+클릭으로 요소 고르기", buttons: ["새 탭에서 열기", "캔버스 닫기"], font: "18px", box: undefined, ran: false });
		const comp = await get(v, `const c = document.querySelector("#composer").getBoundingClientRect(); return { right: Math.round(c.right), shown: c.width > 300 };`);
		expect(comp.shown).toBe(true);
		expect(h.box[0]).toBeGreaterThanOrEqual(comp.right);
		await Bun.write(join(SHOTS, `canvas-open-1280-${theme}.png`), await v.screenshot());
	}, 30_000);

	test("Cmd held outlines, Cmd+click picks into the composer chip without the element's handler, and the canvas closes", async () => {
		const v = await open(1280, 900, "light");
		const held = await get(v, `${FD} ${AT}
			d.getElementById("save").dispatchEvent(new PointerEvent("pointermove", { ...at("save"), pointerType: "mouse" }));
			w.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }));
			const box = document.querySelector("#pick-box");
			return { shown: !box.hidden, label: box.textContent };`);
		expect(held).toEqual({ shown: true, label: "button · 저장" });
		await Bun.write(join(SHOTS, "canvas-cmd-hover-1280.png"), await v.screenshot());
		const picked = await get(v, `${FD} ${AT}
			const el = d.getElementById("save"), o = { ...at("save"), metaKey: true };
			el.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerType: "mouse" })); el.dispatchEvent(new MouseEvent("mousedown", o));
			el.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerType: "mouse" })); el.dispatchEvent(new MouseEvent("mouseup", o));
			const notCancelled = el.dispatchEvent(new MouseEvent("click", o));
			w.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
			return { notCancelled, saved: w.saved || 0, picks: pkItems().map(p => [p.n, p.tag, p.text, p.view]) };`);
		expect(picked).toEqual({ notCancelled: false, saved: 0, picks: [[1, "button", "저장", "canvas:report.html"]] });
		await waitOn(v, `document.querySelectorAll("#pick-marks .pk-mark:not([hidden])").length === 1 && document.querySelector("#atray .pk-chip") && document.querySelector("#atray").getClientRects().length > 0`);
		expect(await get(v, `return [...document.querySelectorAll("#atray .pk-chip")].map(c => c.querySelector(".pk-n").textContent + " " + c.querySelector(".fi-n").textContent);`)).toEqual(["1 저장"]);
		await Bun.write(join(SHOTS, "canvas-pick-1280.png"), await v.screenshot());
		await v.evaluate(`(document.querySelector('#canvas [aria-label="캔버스 닫기"]').click(), 0)`);
		await waitOn(v, `document.querySelector("#canvas").hidden && !document.querySelector("#v-chat").classList.contains("canvas-open") && !document.querySelector("#pick-marks .pk-mark:not([hidden])")`);
		expect(await get(v, `return document.querySelectorAll("#atray .pk-chip").length;`)).toBe(1);
	}, 30_000);
});

describe("캔버스 at 390px", () => {
	for (const theme of ["light", "dark"] as const) test(`a full-screen sheet with the 앱 header and a back button (${theme})`, async () => {
		const v = await open(390, 844, theme);
		const h = await head(v);
		expect({ name: h.name, buttons: h.buttons, font: h.font, box: h.box, ran: h.ran }).toEqual({ name: "report.html", buttons: ["캔버스 닫기", "새 탭에서 열기"], font: "18px", box: [0, 0, 390, 844], ran: false });
		const fr = await get(v, `const r = document.querySelector("#canvas .apps-frame").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.bottom)];`);
		expect(fr[0]).toBeGreaterThan(340);
		expect(fr[1]).toBeLessThanOrEqual(844);
		await Bun.write(join(SHOTS, `canvas-open-390-${theme}.png`), await v.screenshot());
		await v.evaluate(`(document.querySelector('#canvas [aria-label="캔버스 닫기"]').click(), 0)`);
		await waitOn(v, `document.querySelector("#canvas").hidden && document.querySelector("#composer").getClientRects().length > 0`);
	}, 30_000);
});

test("/api/canvas serves only HTML inside the roots, sandboxed with no script", async () => {
	const at = (p: string) => fetch(`http://127.0.0.1:${server.port}/api/canvas?path=${encodeURIComponent(p)}`);
	const ok = await at(PAGE);
	expect(ok.status).toBe(200);
	expect(ok.headers.get("content-type")).toBe("text/html; charset=utf-8");
	const csp = ok.headers.get("content-security-policy") ?? "";
	expect(csp.startsWith("sandbox allow-same-origin;")).toBe(true);
	expect(csp).not.toContain("allow-scripts");
	expect((await at(join(ROOT, "notes.txt"))).status).toBe(415);
	expect((await at("/etc/hosts")).status).toBeGreaterThanOrEqual(400);
});
