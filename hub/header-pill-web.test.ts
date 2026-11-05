// The status tag of a bot message (`[done]` -> 완료, `[ask]` -> 확인 필요, `[fail]` -> 실패, `[run]` -> 진행 중, web/js/02-basic-markdown.js toneLead) in a
// headless Bun.WebView: owner 2026-11-04, the marker is not shown raw and no longer sits in the meta line; the tag starts the first line of the
// message body (prototype .bub .st), and a lane report's image attachment shows as a thumbnail served by the real /api/file route.
// HEADER_PILL_SHOTS=<dir> keeps the screenshots (default: a temp dir).
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileRoute } from "./files.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.HEADER_PILL_SHOTS ?? join(tmpdir(), "dotz-shots", "header-pill");
mkdirSync(SHOTS, { recursive: true });
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "pill-web-")));
const SHOT = join(ROOT, "bell-all-390.png");
copyFileSync(join(import.meta.dir, "..", "web", "icons", "icon-192.png"), SHOT);
const ts = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
// one lane each: a lane's next report right after its last one folds its header away
const report = (min: number, lane: string, text: string) => ({ ts: ts(min), kind: "lane_report", lane, source: `lane:${lane}`, text });
const HIST = [
	report(9, "bell-tabs", "[done] 벨 탭을 끝냈어요"),
	report(7, "alert-color", "[ask] 경고 색을 빨강으로 할까요?"),
	report(5, "push-tests", "[fail] 테스트 하나가 깨졌어요"),
	report(3, "notify-update", `[run] 벨 탭과 분류별 푸시 설정을 적용했어요.\n[file] ${SHOT}`),
];
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
		if (p === "/api/file") return fileRoute(req, url, [ROOT], new Set());
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, runs: { "lane:notify-update": { kind: "working" } } });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: HIST });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); rmSync(ROOT, { recursive: true, force: true }); });
const waitOn = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);

for (const [width, height] of [[390, 844], [1280, 900]] as const) test(`each status tag starts the first line of its message, the meta line has none, and the image attachment shows (${width}px)`, async () => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/#chat`);
	await waitOn(v, `document.querySelectorAll("#timeline .bm > .md .st-tag").length === 4 && [...document.querySelectorAll("#timeline .thumb img")].some(i => i.complete && i.naturalWidth > 0)`);
	await v.evaluate(`(document.querySelector("#timeline .thumb").scrollIntoView({ block: "center" }), 0)`);
	await Bun.write(join(SHOTS, `header-pill-${width}.png`), await v.screenshot());
	const tags = JSON.parse(await v.evaluate(`JSON.stringify([...document.querySelectorAll("#timeline .bm > .md .st-tag")].map(t => {
		const p = t.parentElement, r = t.getBoundingClientRect(), pr = p.getBoundingClientRect();
		return { text: t.textContent, lead: p.firstChild === t, firstLine: r.top - pr.top < 12, raw: /^\\[/.test(p.textContent) };
	}))`) as string);
	expect(tags).toEqual(["완료", "확인 필요", "실패", "진행 중"].map(text => ({ text, lead: true, firstLine: true, raw: false })));
	expect(await v.evaluate(`document.querySelectorAll("#timeline .bm > .mt > .tag").length`)).toBe(0);
}, 30_000);
