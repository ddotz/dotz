import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// A project's conversation in 채팅 (web/js/31-conversations.js): the same ⋯ menu as the project page, in a headless Bun.WebView against a stub gateway.
// Screenshots are written only when PROJECT_CHAT_HEAD_SHOTS names a folder. Names are placeholders.
const SHOTS = process.env.PROJECT_CHAT_HEAD_SHOTS;
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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [{ name: "yt-upload", status: "idle", alive: true, home: "ch:7001" }], terminals: {}, channels: { work: { "7001": { name: "유튜브" } } }, discord: {}, notices_unread: 0 });
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

// The menu button lives in the app bar on a phone and in the conversation head on a wide screen.
const BTN = { 390: "#pjmenu:not([hidden])", 1280: ".cv-head .cvmenu" } as const;
type W = keyof typeof BTN;

async function boot(width: W, tgt: string): Promise<View> {
	const v = new Bun.WebView({ width, height: 844 });
	views.push(v);
	const opened = new Promise<void>(r => streamWaiters.push(r));
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof S !== "undefined" && S && typeof PRJ !== "undefined"`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `prjLoad()`);
	await waitFor(v, `PRJ`);
	await run(v, `go("chat", ${JSON.stringify(tgt)})`);
	await waitFor(v, `target === ${JSON.stringify(tgt)} && current === "chat"`);
	return v;
}
// Any project menu button that is on screen (hidden ones and the project page's own do not count).
const SHOWN = `window.shown = () => [...document.querySelectorAll("button[aria-label='프로젝트 메뉴']")].some(b => b.getClientRects().length > 0)`;
const items = (v: View) => q<string[]>(v, `return [...document.querySelectorAll(".menu .mi")].map(m => m.textContent)`);
const pick = (v: View, label: string) => run(v, `[...document.querySelectorAll(".menu .mi")].find(m => m.textContent.includes(${JSON.stringify(label)})).click()`);

for (const w of [390, 1280] as const) {
	test(`${w}px: only a project's conversation shows the project menu`, async () => {
		const v = await boot(w, "ch:7001");
		await run(v, SHOWN);
		await waitFor(v, `document.querySelector(${JSON.stringify(BTN[w])})`);
		await shot(v, `01-project-chat-${w}.png`);
		await run(v, `document.querySelector(${JSON.stringify(BTN[w])}).click()`);
		await waitFor(v, `document.querySelector(".menu .mi")`);
		expect(await items(v)).toEqual(["프로젝트 수정", "프로젝트 삭제"]);
		await shot(v, `02-project-chat-menu-${w}.png`);
		for (const t of ["main", "worklog", "alert", "lane:yt-upload"]) {
			await run(v, `closeMenu(false); go("chat", ${JSON.stringify(t)})`);
			await waitFor(v, `target === ${JSON.stringify(t)}`);
			await waitFor(v, `!shown()`);
			expect(await q(v, `return shown()`)).toBe(false);
		}
	});
}

test("수정 opens that project's page in the 프로젝트 tab", async () => {
	const v = await boot(390, "ch:7001");
	await waitFor(v, `document.querySelector("#pjmenu:not([hidden])")`);
	await run(v, `document.querySelector("#pjmenu").click()`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await pick(v, "수정");
	await waitFor(v, `current === "project" && ppCur === "ch:7001" && document.querySelector(".pmv-title")`);
	expect(await q(v, `return document.querySelector(".pmv-title").textContent`)).toBe("유튜브");
	await shot(v, "03-edit-opens-project-390.png");
});

test("삭제 runs the project page's pmDeleteAsk, then returns to the main chat", async () => {
	const v = await boot(390, "ch:7001");
	await run(v, `window.__asked = []; const o = pmDeleteAsk; pmDeleteAsk = q => { __asked.push(q.key); return o(q); }`);
	await waitFor(v, `document.querySelector("#pjmenu:not([hidden])")`);
	await run(v, `document.querySelector("#pjmenu").click()`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await pick(v, "삭제");
	await waitFor(v, `document.querySelector(".pmd .as-rml")`);
	expect(await q(v, `return __asked`)).toEqual(["ch:7001"]);
	expect((await q<string[]>(v, `return [...document.querySelectorAll(".pmd .as-rml li")].map(li => li.textContent)`))[0]).toBe("#유튜브 채널을 Discord에서 지워요");
	await shot(v, "04-confirm-sheet-from-chat-390.png");
	await run(v, `document.querySelector('.fs-ft [data-k="delete"]').click()`);
	await waitFor(v, `!document.querySelector(".fs-card") && target === "main"`);
	expect(deletes).toEqual([{ path: "/api/projects/ch%3A7001", body: { archive: true } }]);
	expect(await q(v, `return current`)).toBe("chat");
});
