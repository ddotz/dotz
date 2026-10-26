import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 구성 (settings > 구성, 27/28-harness*.js) in a headless browser at 390 / 768 / 1280 / 1512px: the five stages are a responsive
// flow of cards (3 columns from 1200px, 2 from 700px, stacked below), nothing pushes the page sideways, and the long lists (34
// support chips in 전체, 34 personal features in 커스텀) scroll inside their card. Screenshots go to HARNESS_SHOTS when it names a folder.
const SHOTS = process.env.HARNESS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const LONG = "브라우저 로그인 유지와 자동 재시도를 함께 처리하는 아주 긴 이름의 기능";
const node = (id: string, group: string, label: string, extra: Record<string, unknown> = {}) => ({ id, kind: group === "flow" ? id : "system", group, label, status: "ok", summary: `${label} 요약 문장이에요. 길게 이어지는 설명이 카드 안에서 줄을 바꿔야 해요.`, desc: "", facts: [], settings: [], ...extra });
const channels = ["discord", "web", "terminal", "schedule", "watch", "mail"].map((id, i) => node(id, "flow", ["Discord", "웹", "터미널", "예약", "모니터링", "메일"][i]!, { kind: "channel" }));
const nodes = [
	...channels,
	node("gateway", "flow", "게이트웨이", { custom: [{ key: "web_port", label: "웹 포트", value: 8790, default: 8787 }] }),
	node("orchestrator", "flow", "어시스턴트 (맞춤)", { origin: "personal" }),
	node("lanes", "flow", "세션"),
	node("workers", "flow", "서브에이전트"),
	...["mode", "identity", "rules", "lessons"].map((id, i) => node(id, "files", ["MODE.md", "IDENTITY.md", "RULES.md", "LESSONS.md"][i]!, { kind: "file", anchor: "orchestrator", order: i + 1 })),
	...["outlang", "update", "audit", "reflect"].map((id, i) => node(id, "support", ["출력 언어 맞춤", "자동 업데이트", "토큰 점검", "하루 돌아보기"][i]!, { anchor: "gateway", order: i + 1 })),
	...Array.from({ length: 34 }, (_, i) => node(`skill${i}`, "support", i % 5 ? `스킬 ${i + 1}` : `${LONG} ${i + 1}`, { anchor: "workers", order: i + 1 })),
];
const edges = [
	...channels.map(c => ({ from: c.id, to: "gateway", label: "메시지" })),
	{ from: "gateway", to: "orchestrator", label: "들어온 글 전달" },
	{ from: "orchestrator", to: "lanes", label: "작업 맡김" },
	{ from: "lanes", to: "workers", label: "서브에이전트 호출" },
	...nodes.filter(n => n.group !== "flow").map(n => ({ from: n.id, to: (n as { anchor: string }).anchor, label: "함께 실행" })),
];
const harness = { name: "dotz", origin_view: true, data_dir: "~/.dotz", nodes, edges, projects: [] };
const features = {
	harness: { name: "omp", dirs: ["~/.omp/agent/extensions"] },
	features: Array.from({ length: 34 }, (_, i) => ({ id: `f${i}`, name: i % 4 ? `기능 ${i + 1}` : `${LONG} ${i + 1}`, form: "기능 폴더", stage: "orchestrator", strength: i % 2 ? "advisory" : "enforced", origin: "personal", enabled: true, source: { label: `~/.dotz/features/browser-aside-keep-login-${i + 1}/feature.md` } })),
};

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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/harness") return json(harness);
		if (p === "/api/features") return json(features);
		if (p === "/api/update" || p === "/api/runtimes") return json({ error: "stub" }, 500);
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 8000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);

const open = async (w: number, h: number, mode: "all" | "custom", theme = "light") => {
	const v = new Bun.WebView({ width: w, height: h });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await run(v, `localStorage.setItem("dotz-honly", "${mode === "custom" ? "1" : "0"}"); localStorage.setItem("dotz-hdetail", "0"); localStorage.setItem("dotz-hfeat", "0"); hOnly = ${mode === "custom"}; hDetail = false; hFeat = false; if (dotzTheme.get() !== "${theme}") dotzTheme.toggle(); go("harness");`);
	await waitFor(v, `current === "harness" && document.querySelectorAll("#harness .hm-simple > .hm-st").length === 5 && FC`);
	return v;
};
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};

// What the layout reports: page/scroller overflow, every element wider than the screen, the card grid, the toolbar rows.
type Fit = { vw: number; doc: number; docW: number; views: number; viewsW: number; over: string[]; cols: number; lefts: number[]; tops: number[]; head: { top: number; bottom: number }; vh: number; barRows: number; barOver: string[]; clipped: string[]; untitled: string[] };
const fit = (v: View) => q<Fit>(v, `
	const vw = document.documentElement.clientWidth, box = $("#harness"), cards = [...box.querySelectorAll(".hm-simple > .hm-st")];
	const over = [...box.querySelectorAll("*")].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 1 || r.left < -1) && !e.closest(".hm-list"); }).map(e => e.className.baseVal ?? e.className).slice(0, 5);
	const rc = cards.map(c => c.getBoundingClientRect()), lefts = [...new Set(rc.map(r => Math.round(r.left)))];
	const head = cards[0].querySelector(".hm-sh").getBoundingClientRect();
	const bar = box.querySelector(".hm-bar"), barR = bar.getBoundingClientRect(), kids = [...bar.children].filter(k => k.getBoundingClientRect().width);
	const barRows = new Set(kids.map(k => Math.round(k.getBoundingClientRect().top))).size;
	const barOver = kids.filter(k => k.getBoundingClientRect().right > barR.right + 1 || k.scrollWidth > k.clientWidth + 1).map(k => k.textContent);
	// wrapping text must show whole: title lines and row names are never cut (scrollWidth fits); ellipsized names carry a title
	const clipped = [...box.querySelectorAll(".hm-sh .l, .hm-cr .m1, .hm-from")].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
	const untitled = [...box.querySelectorAll(".hm-chip .l, .hm-row .l, .hm-cr .m2")].filter(e => e.scrollWidth > e.clientWidth + 1 && !(e.title || e.closest("[title]"))).map(e => e.textContent);
	return { vw, doc: document.documentElement.scrollWidth, docW: document.documentElement.clientWidth, views: $("#views").scrollWidth, viewsW: $("#views").clientWidth, over, cols: lefts.length, lefts, tops: rc.map(r => Math.round(r.top)), head: { top: head.top, bottom: head.bottom }, vh: innerHeight, barRows, barOver, clipped, untitled };`);

const WIDTHS = [[390, 844, 1], [768, 1000, 2], [1280, 900, 3], [1512, 945, 3]] as const;
for (const mode of ["all", "custom"] as const) {
	describe(`구성 ${mode === "all" ? "전체" : "커스텀"}`, () => {
		for (const [w, h, cols] of WIDTHS) {
			test(`${w}px: ${cols} column(s), nothing wider than the screen, long list scrolls inside its card`, async () => {
				const v = await open(w, h, mode);
				const f = await fit(v);
				expect(f.doc).toBeLessThanOrEqual(f.docW);
				expect(f.views).toBeLessThanOrEqual(f.viewsW);
				expect(f.over).toEqual([]);
				expect(f.cols).toBe(cols);
				expect(f.clipped).toEqual([]);
				expect(f.untitled).toEqual([]);
				expect(f.barOver).toEqual([]);
				if (w === 390) {
					// stacked steps, each below the last; the first stage's header is on screen; the toolbar wraps onto more rows
					expect(f.tops).toEqual([...f.tops].sort((a, b) => a - b));
					expect(f.head.top).toBeGreaterThanOrEqual(0);
					expect(f.head.bottom).toBeLessThanOrEqual(f.vh);
					expect(f.barRows).toBeGreaterThan(1);
				}
				expect(await q<number>(v, `return $("#harness").querySelectorAll(".hm-simple > .hm-st .hm-ar").length`)).toBe(4);
				if (mode === "all") {
					// the 34 support chips of 서브에이전트: one inner list that scrolls, the page does not
					const s = await q<{ n: number; sh: number; ch: number }>(v, `const l = [...$("#harness").querySelectorAll(".hm-list")].find(x => x.querySelectorAll(".hm-chip").length === 34); return { n: l.querySelectorAll(".hm-chip").length, sh: l.scrollHeight, ch: l.clientHeight };`);
					expect(s.n).toBe(34);
					expect(s.sh).toBeGreaterThan(s.ch);
					await shot(v, `compose-all-${w}.png`);
				} else {
					// 더 보기 opens the 34 features inside the same card height; the opened list scrolls internally
					const before = await q<{ h: number; sh: number; ch: number }>(v, `const c = $("#harness").querySelector(".hm-cs.fix").closest(".hm-st"), l = c.querySelector(".hm-cs"); return { h: c.getBoundingClientRect().height, sh: l.scrollHeight, ch: l.clientHeight };`);
					await run(v, `$("#harness").querySelector(".hm-cs.fix .hm-more").click()`);
					await waitFor(v, `$("#harness").querySelectorAll(".hm-cs.fix .hm-cr").length >= 34`);
					const after = await q<{ h: number; sh: number; ch: number; paths: string[] }>(v, `const c = $("#harness").querySelector(".hm-cs.fix").closest(".hm-st"), l = c.querySelector(".hm-cs"); return { h: c.getBoundingClientRect().height, sh: l.scrollHeight, ch: l.clientHeight, paths: [...l.querySelectorAll(".m2.mono")].slice(0, 2).map(m => m.textContent + "|" + m.title) };`);
					expect(after.h).toBe(before.h);
					expect(after.sh).toBeGreaterThan(after.ch);
					expect(after.paths[0]).toBe("…/browser-aside-keep-login-1/feature.md|~/.dotz/features/browser-aside-keep-login-1/feature.md");
					const g = await fit(v);
					expect(g.doc).toBeLessThanOrEqual(g.docW);
					expect(g.over).toEqual([]);
					await shot(v, `compose-custom-${w}.png`);
				}
				v.close();
			});
		}
	});
}

test("dark theme at 1280px keeps the same layout", async () => {
	const v = await open(1280, 900, "all", "dark");
	expect(await q<string>(v, `return document.documentElement.dataset.theme`)).toBe("dark");
	const f = await fit(v);
	expect(f.doc).toBeLessThanOrEqual(f.docW);
	expect(f.cols).toBe(3);
	await shot(v, "compose-all-1280-dark.png");
	v.close();
});
