// Cleanup after work (ux3 T4): an ended session keeps its unread and 답변 필요 marks in the folded 끝난 세션 group, the 알림 conversation has
// 모두 읽음 in its head and 지우기 on each alert (the hub dismiss route), and a pulled update that waits for its restart keeps the badge as
// 재시작 필요 while the toast's 보기 lands on the 업데이트 section. Headless (Bun.WebView) against a fake hub.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { broadcast, sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.CLEANUP_SHOTS ?? join(tmpdir(), "dotz-cleanup-web");
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown) => Response.json(v);
const iso = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 27, h, m)).toISOString();
const A1 = iso(1), A2 = iso(2), A3 = iso(3);

type N = { id: string; kind: string; tone: string; title: string; text: string; open: string; src: string; at: string; ts: string; updated: string; read: boolean; dismissed?: boolean; decision?: unknown };
const alertN = (id: string, at: string, text: string): N => ({ id, kind: "alert", tone: "", title: "알림", text, open: "alert", src: "alert", at, ts: at, updated: at, read: false });
let notices: N[] = [], reads: unknown[] = [], dismissed: string[] = [];
const reset = () => {
	notices = [
		alertN("a1", A1, "NAS 디스크 공간이 10% 남았어요"),
		alertN("a2", A2, "백업이 끝났어요"),
		{ id: "q1", kind: "decision", tone: "ask", title: "어느 쪽으로 할까요?", text: "어느 쪽으로 할까요?", open: "lane:old-b", src: "lane:old-b", at: A3, ts: A3, updated: A3, read: false,
			decision: { options: [{ n: 1, label: "A", desc: "", rec: true }, { n: 2, label: "B", desc: "", rec: false }], to: "lane:old-b", reply_to: A3, group: 1, state: "open" } },
	];
	reads = []; dismissed = [];
};
reset();
// Resolves once the fake hub's state satisfies `ok` (checked after every request it handles).
const waiters = new Set<{ ok: () => boolean; done: () => void }>();
const hubState = (ok: () => boolean) => new Promise<void>(done => { if (ok()) done(); else waiters.add({ ok, done }); });
const settle = () => { for (const w of waiters) if (w.ok()) { waiters.delete(w); w.done(); } };
const shown = () => notices.filter(n => !n.dismissed);
const unread = () => shown().filter(n => !n.read).length;
const lane = (name: string, h: number) => ({ name, title: name, cwd: "/w", status: "exited", live: false, startedAt: iso(h) });
const alertEvent = (ts: string, text: string) => ({ ts, kind: "out", source: "gateway", target: "alert", text });
const sha = (s: string) => ({ sha: s.repeat(40), short: s.repeat(7), date: iso(0) });

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		try { return await handle(req); } finally { queueMicrotask(settle); }
	},
});
async function handle(req: Request): Promise<Response> {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [lane("old-a", 1), lane("old-b", 2), lane("old-c", 0)], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unread() });
		if (p === "/api/conversations") return json({ items: [
			{ target: "lane:old-a", unread: 3, read: iso(0), last: { ts: iso(4), text: "끝났어요", from: "bot" } },
			{ target: "lane:old-b", unread: 0, read: iso(5), last: { ts: iso(2), text: "물어봤어요", from: "bot" } },
			{ target: "lane:old-c", unread: 0, read: iso(5), last: { ts: iso(0), text: "끝", from: "bot" } },
			{ target: "alert", unread: 2, read: iso(0), last: { ts: A2, text: "백업이 끝났어요", from: "bot" } }] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "alert" ? [alertEvent(A1, "NAS 디스크 공간이 10% 남았어요"), alertEvent(A2, "백업이 끝났어요")] : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/notices") return json({ items: shown(), unread: unread(), gone: notices.filter(n => n.dismissed && n.src === "alert").map(n => n.at) });
		if (p === "/api/notices/read") { const b = (await req.json()) as { ids?: string[] }; reads.push({ notices: b.ids }); for (const n of notices) if (b.ids?.includes(n.id)) n.read = true; return json({ unread: unread() }); }
		if (p === "/api/read") { const b = await req.json(); reads.push({ read: b }); return json({ ok: true }); }
		const dm = req.method === "POST" && /^\/api\/notices\/([^/]+)\/dismiss$/.exec(p);
		if (dm) { const n = notices.find(x => x.id === dm[1]); if (!n) return json({ ok: false }); n.dismissed = true; n.read = true; dismissed.push(n.id); return json({ ok: true, unread: unread() }); }
		if (p === "/api/accounts") return Response.json({ error: "no accounts here" }, { status: 404 });
		if (p === "/api/update") return json({ running: { kind: "git", branch: "main", commit: sha("a") }, disk: { kind: "git", branch: "main", commit: sha("b") }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
}

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
async function boot(width: number, height: number) {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && S.lanes.length === 3 && CONV.has("lane:old-a")`);
	return v;
}

describe.each([[390, 844], [1280, 900]] as const)("at %ipx", (width, height) => {
	test("the folded 끝난 세션 line counts what waits, and each ended row keeps its unread and 답변 필요", async () => {
		reset();
		const v = await boot(width, height);
		await run(v, `endedOpen = true; go("chat", narrowChat() ? "list" : "main"); convSig = ""; convSchedule()`);
		const ended = `[...document.querySelectorAll("details.ended")].find(d => d.offsetParent)`;
		await waitFor(v, `${ended} && ${ended}.querySelector(".erow")`);
		const got = await q<{ head: string[]; rows: Record<string, { nb: string | null; need: boolean }> }>(v, `const d = ${ended};
			return { head: [...d.querySelectorAll("summary .ecount")].map(s => s.textContent),
				rows: Object.fromEntries([...d.querySelectorAll(".erow .er")].map(r => [r.querySelector(".en").textContent, { nb: r.querySelector(".nb") && r.querySelector(".nb").textContent, need: !!r.querySelector(".tag.warn") }])) }`);
		expect(got.head).toEqual(["답변 필요 1", "안 읽음 1"]);
		expect(got.rows).toEqual({ "old-a": { nb: "3", need: false }, "old-b": { nb: null, need: true }, "old-c": { nb: null, need: false } });
		await Bun.write(join(SHOTS, `ended-${width}.png`), await v.screenshot());
		await run(v, `endedOpen = false; refreshEnded()`);
		await waitFor(v, `!${ended}.open`);
		expect(await q<boolean>(v, `const c = ${ended}.querySelector(".ecounts"); return c.scrollWidth <= c.clientWidth`)).toBe(true);
		await Bun.write(join(SHOTS, `ended-closed-${width}.png`), await v.screenshot());
	}, 30_000);

	test("the 알림 conversation: 모두 읽음 reads the conversation and its alerts, 지우기 dismisses one alert on the hub and it stays gone", async () => {
		reset();
		const v = await boot(width, height);
		await run(v, `go("chat", "alert")`);
		await waitFor(v, `document.querySelectorAll("#tl > [data-ts] > .al-x").length === 2`);
		// 모두 읽음 is visible: the conversation's head on a wide screen, the app bar on a phone
		const readAll = `[...document.querySelectorAll(".cv-readall")].find(b => b.offsetParent)`;
		await waitFor(v, `${readAll} && !${readAll}.disabled`);
		await Bun.write(join(SHOTS, `alert-${width}.png`), await v.screenshot());
		await run(v, `${readAll}.click()`);
		await hubState(() => notices.filter(n => n.src === "alert").every(n => n.read) && reads.some(r => JSON.stringify(r) === JSON.stringify({ read: { target: "alert", ts: A2 } })));
		await waitFor(v, `${readAll}.disabled`);
		expect(notices.find(n => n.id === "q1")!.read).toBe(false);   // the question elsewhere is untouched

		await run(v, `document.querySelector('#tl > [data-ts="${A1}"] > .al-x').click()`);
		await waitFor(v, `document.querySelector('#tl > [data-ts="${A1}"]').hidden && !ntById("a1")`);
		expect(dismissed).toEqual(["a1"]);
		expect(await q<boolean>(v, `return document.querySelector('#tl > [data-ts="${A2}"]').hidden`)).toBe(false);
		await Bun.write(join(SHOTS, `alert-dismissed-${width}.png`), await v.screenshot());

		// another page (or a reload) hides the same alert
		const w = await boot(width, height);
		await run(w, `go("chat", "alert")`);
		await waitFor(w, `document.querySelector('#tl > [data-ts="${A2}"] > .al-x')`);
		expect(await q<boolean>(w, `return document.querySelector('#tl > [data-ts="${A1}"]').hidden`)).toBe(true);
	}, 30_000);

	test("a pulled update waiting for its restart keeps the badge as 재시작 필요; the toast's 보기 opens the 업데이트 section in view", async () => {
		reset();
		const v = await boot(width, height);
		await waitFor(v, `UPD.info && !$("#nav-upd").hidden`);
		expect(await q<string>(v, `return $("#nav-upd").textContent`)).toBe("재시작 필요");
		broadcast({ ts: new Date().toISOString(), kind: "update_available", source: "gateway", text: "새 버전이 있어요" });
		await waitFor(v, `[...document.querySelectorAll("button")].some(b => b.textContent === "보기" && b.matches(".snack .sa"))`);
		await run(v, `[...document.querySelectorAll("button")].find(b => b.textContent === "보기" && b.matches(".snack .sa")).click()`);
		await waitFor(v, `current === "settings" && $("#upd-sec")`);
		await waitFor(v, `(() => { const r = $("#upd-sec").getBoundingClientRect(); return $("#views").scrollTop > 0 && r.top >= 0 && r.top < innerHeight - 80; })()`);
		expect(await q<string>(v, `return $("#upd-sec .upd-new").textContent`)).toBe("재시작 필요");
		await Bun.write(join(SHOTS, `update-${width}.png`), await v.screenshot());
	}, 30_000);
});
