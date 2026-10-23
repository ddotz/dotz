import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// 프로젝트 삭제 (web/js/19-project-main.js) as shipped, in a headless Bun.WebView at 390px against a stub gateway. Screenshots are written
// only when PROJECT_DELETE_SHOTS names a folder. Names are placeholders.
const SHOTS = process.env.PROJECT_DELETE_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const PLAN = {
	key: "ch:7001", channel: "ch:7001", name: "유튜브",
	monitors: ["유튜브 감시 1", "댓글 확인"],
	logins: [{ name: "login-studio-youtube-com", shared: false }, { name: "login-google-com", shared: true }],
	standing: "새 영상 알림", notices: 3, messages: 41, running: [], archive: "/data/archive/projects/유튜브-7001.jsonl",
};
const deletes: { path: string; body: unknown }[] = [];
let running: string[] = [];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let streamWaiters: (() => void)[] = [];
const te = new TextEncoder();
const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") {
			let ctl: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({
				start(c) { ctl = c; streams.add(c); c.enqueue(te.encode(": open\n\n")); const w = streamWaiters; streamWaiters = []; for (const f of w) f(); },
				cancel() { streams.delete(ctl); },
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
		}
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [{ channel: "ch:7001", name: "유튜브" }] }, discord: {}, notices_unread: 0 });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [{ key: "ch:7001", name: "유튜브", pinned: false, lanes: [], newest: 0, channel: { id: "7001", name: "유튜브" }, recordKey: "ch:7001" }], routines: [], links: [] });
		if (p === "/api/custom/project") return json({ key: "ch:7001", monitors: [], lanes: [], work: [], results: [], routines: [], schedules: [], watches: [] });
		if (p === "/api/projects/ch%3A7001/delete-plan") return json({ ...PLAN, running });
		if (p === "/api/projects/ch%3A7001" && req.method === "DELETE") {
			deletes.push({ path: p, body: await req.json() });
			return json({ ok: true, channel: "ch:7001", name: "유튜브", removed: { monitors: 2, logins: 1, notices: 3 }, archive: PLAN.archive, discord: { ok: true } });
		}
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); for (const c of streams) { try { c.close(); } catch { /* already closed */ } } server.stop(true); });

const waitFor = (v: View, expr: string, ms = 4000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const shot = async (v: View, name: string) => { if (SHOTS) { await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`); await Bun.write(join(SHOTS, name), await v.screenshot()); } };

async function boot(): Promise<View> {
	const v = new Bun.WebView({ width: 390, height: 844 });
	views.push(v);
	const opened = new Promise<void>(r => streamWaiters.push(r));
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof S !== "undefined" && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("project", "ch:7001")`);
	await waitFor(v, `document.querySelector(".pmv-more")`);
	return v;
}

test("the project menu opens a confirm sheet that lists exactly what goes, and 삭제 sends the archive choice", async () => {
	const v = await boot();
	await run(v, `document.querySelector(".pmv-more").click()`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await run(v, `document.querySelector(".menu .mi").click()`);
	await waitFor(v, `document.querySelector(".pmd .as-rml")`);
	const lines = await q<string[]>(v, `return [...document.querySelectorAll(".pmd .as-rml li")].map(li => li.textContent)`);
	expect(lines[0]).toBe("#유튜브 채널을 Discord에서 지워요");
	expect(lines.join("|")).toContain("모니터링 2개를 지워요: 유튜브 감시 1, 댓글 확인");
	expect(lines.join("|")).toContain("login-google-com(다른 채널도 써서 남겨요)");
	expect(lines.join("|")).toContain("알림 3개를 치워요");
	expect(await q(v, `return document.querySelector('.pmd [data-k="drop-archive"]').checked`)).toBe(false);
	expect(await q(v, `return document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
	await shot(v, "01-confirm-sheet-390.png");
	await run(v, `document.querySelector('.pmd [data-k="drop-archive"]').click()`);
	await run(v, `document.querySelector('.fs-ft [data-k="delete"]').click()`);
	await waitFor(v, `!document.querySelector(".fs-card")`);
	expect(deletes).toEqual([{ path: "/api/projects/ch%3A7001", body: { archive: false } }]);
});

test("a running session blocks the 삭제 button and is named in the sheet", async () => {
	running = ["yt-upload"];
	const v = await boot();
	await run(v, `document.querySelector(".pmv-more").click()`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await run(v, `document.querySelector(".menu .mi").click()`);
	await waitFor(v, `document.querySelector(".pmd .as-rml")`);
	expect(await q(v, `return document.querySelector('.fs-ft [data-k="delete"]').disabled`)).toBe(true);
	expect(await q(v, `return document.querySelector(".pmd .note.err").textContent`)).toContain("yt-upload");
	await shot(v, "02-running-refused-390.png");
});
