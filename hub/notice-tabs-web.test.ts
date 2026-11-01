// The tabs of the 알림 conversation (전체 / 답변 필요 / 결과 / 새 소식 / 경고, each with its unread count by notice class) and the five per-class push
// switches in 설정 (GET/PUT /api/push/classes). Headless (Bun.WebView) against a fake hub; classes come from the hub as `cls` (hub/notice-class.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.NOTICE_SHOTS ?? join(tmpdir(), "dotz-notice-tabs");
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown) => Response.json(v);
const iso = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 1, h, m)).toISOString();

type N = { id: string; cls: string; kind: string; tone: string; title: string; text: string; open: string; src: string; at: string; ts: string; updated: string; read: boolean; app?: string; watch?: string; decision?: unknown };
const mk = (id: string, h: number, cls: string, kind: string, tone: string, title: string, o: Partial<N> = {}): N => ({ id, cls, kind, tone, title, text: title, open: "alert", src: "alert", at: iso(h), ts: iso(h), updated: iso(h), read: false, ...o });
const ask = (id: string, h: number, title: string, state: string, read: boolean): N =>
	mk(id, h, "ask", "decision", "ask", title, { open: "lane:s1", src: "lane:s1", read,
		decision: { options: [{ n: 1, label: "예", desc: "", rec: true }, { n: 2, label: "아니요", desc: "", rec: false }], to: "lane:s1", reply_to: iso(h), group: 1, state } });
// unread: ask 1 (the answered one is read) + result 2 + news 3 + alert 1 + conv 1 = 8; the two "log" notices are unread and counted nowhere.
const notices: N[] = [
	ask("q-old", 1, "예전 질문", "answered", true),
	ask("q-open", 2, "배포할까요?", "open", false),
	mk("r1", 3, "result", "result", "done", "세션 build 끝났어요", { src: "lane:build", open: "lane:build" }),
	mk("r2", 4, "result", "worklog", "fail", "야간 정리가 실패했어요", { src: "worklog", open: "worklog" }),
	mk("n1", 5, "news", "watch", "", "새 메일 도착", { app: "메일", watch: "mail-1" }),
	mk("n2", 6, "news", "watch", "", "메일 답장이 왔어요", { app: "메일", watch: "mail-1" }),
	mk("n3", 7, "news", "watch", "", "새 카톡이 왔어요", { app: "카카오톡", watch: "kakao-1" }),
	mk("n4", 8, "news", "watch", "", "읽은 메일 소식", { app: "메일", watch: "mail-1", read: true }),
	mk("a1", 9, "alert", "alert", "fail", "게이트웨이가 멈췄어요", { src: "alert" }),
	mk("m1", 10, "conv", "message", "", "프로젝트 대화에 새 답이 있어요", { src: "proj:p1", open: "proj:p1" }),
	mk("l1", 11, "log", "worklog", "run", "진행 중인 기록", { src: "worklog", open: "worklog" }),
	mk("l2", 12, "log", "alert", "", "토큰 누수 점검 이상 없음", { src: "alert" }),
];
const unread = () => notices.filter(n => !n.read).length;
let classes: Record<string, boolean> = { ask: true, alert: true, result: true, news: true, conv: true, log: false };
let puts: unknown[] = [];
const waiters = new Set<{ ok: () => boolean; done: () => void }>();
const hubState = (ok: () => boolean) => new Promise<void>(done => { if (ok()) done(); else waiters.add({ ok, done }); });
const settle = () => { for (const w of waiters) if (w.ok()) { waiters.delete(w); w.done(); } };
const alertEvent = (ts: string, text: string) => ({ ts, kind: "out", source: "gateway", target: "alert", text });

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
	if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unread() });
	if (p === "/api/conversations") return json({ items: [{ target: "alert", unread: 0, read: iso(13), last: { ts: iso(9), text: "게이트웨이가 멈췄어요", from: "bot" } }] });
	if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "alert" ? [alertEvent(iso(9), "게이트웨이가 멈췄어요"), alertEvent(iso(12), "토큰 누수 점검 이상 없음")] : [] });
	if (p === "/api/activity") return json({ items: [], more: false, history: false });
	if (p === "/api/notices") return json({ items: notices, unread: unread(), gone: [] });
	if (p === "/api/accounts") return Response.json({ error: "no accounts here" }, { status: 404 });
	if (p === "/api/update") {
		const at = { sha: "a".repeat(40), short: "a".repeat(7), date: iso(0) };
		return json({ running: { kind: "git", branch: "main", commit: at }, disk: { kind: "git", branch: "main", commit: at }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [] });
	}
	if (p === "/api/push/classes") {
		if (req.method === "PUT") { const b = (await req.json()) as { classes: Record<string, boolean> }; puts.push(b); classes = { ...classes, ...b.classes }; }
		return json({ classes });
	}
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
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NT.items.length === ${notices.length} && CONV.has("alert")`);
	return v;
}
const shot = async (v: View, name: string) => Bun.write(join(SHOTS, name), await v.screenshot());
type Tab = { k: string; label: string; n: string | null; cls: string | null; on: boolean };
const tabs = (v: View) => q<Tab[]>(v, `return [...document.querySelectorAll("#bell-tabs .chip")].map(c => { const b = c.querySelector(".nb"); return { k: c.dataset.k, label: c.querySelector(".tx").textContent, n: b && b.textContent, cls: b && b.className, on: c.classList.contains("on") }; })`);
const openBell = async (v: View) => {
	await run(v, `go("chat", "alert")`);
	await waitFor(v, `!$("#bell-tabs").hidden && $("#bell-tabs .chip") && document.querySelector("#tl > [data-ts]")`);
};
const pick = (v: View, k: string) => run(v, `document.querySelector('#bell-tabs .chip[data-k="${k}"]').click()`);
const rows = (v: View) => q<string[]>(v, `return [...document.querySelectorAll("#bell-list .hrx-m .nm")].map(x => x.textContent)`);

describe.each([[390, 844], [1280, 900]] as const)("at %ipx", (width, height) => {
	test("the tabs carry the unread count of their class (log counts nowhere); ask is orange, alert is red; 전체 is the timeline", async () => {
		const v = await boot(width, height);
		await openBell(v);
		const t = await tabs(v);
		expect(t.map(x => [x.k, x.label, x.n, x.on])).toEqual([["all", "전체", "8", true], ["ask", "답변 필요", "1", false], ["result", "결과", "2", false], ["news", "새 소식", "3", false], ["alert", "경고", "1", false]]);
		expect(t.find(x => x.k === "ask")!.cls).toBe("nb warn");
		expect(t.find(x => x.k === "alert")!.cls).toBe("nb err");
		expect(t.find(x => x.k === "news")!.cls).toBe("nb");
		const colors = await q<{ ask: string; alert: string; warn: string; err: string }>(v, `const bg = e => getComputedStyle(e).backgroundColor, dot = c => { const d = document.createElement("span"); d.className = "dot " + c; document.body.append(d); const x = bg(d); d.remove(); return x; };
			return { ask: bg(document.querySelector('#bell-tabs .chip[data-k="ask"] .nb')), alert: bg(document.querySelector('#bell-tabs .chip[data-k="alert"] .nb')), warn: dot("att"), err: dot("err") }`);
		expect(colors.ask).toBe(colors.warn);
		expect(colors.alert).toBe(colors.err);
		expect(colors.ask).not.toBe(colors.alert);
		expect(await q<[boolean, number]>(v, `return [$("#bell-list").hidden, document.querySelectorAll("#tl > [data-ts]").length]`)).toEqual([true, 2]);
		expect(await q<boolean>(v, `const c = $("#bell-tabs"); return c.scrollWidth <= c.clientWidth`)).toBe(true);
		await shot(v, `bell-all-${width}.png`);
	}, 30_000);

	test("답변 필요 lists what waits on top; 결과 and 경고 list their own class; log is in no tab", async () => {
		const v = await boot(width, height);
		await openBell(v);
		await pick(v, "ask");
		await waitFor(v, `$("#bell-list .hrx-m")`);
		expect(await rows(v)).toEqual(["배포할까요?", "예전 질문"]);
		expect(await q<string[]>(v, `return [...document.querySelectorAll("#bell-list .hrx-m")].map(b => b.querySelector(".hs") ? b.querySelector(".hs").textContent : "")`)).toEqual(["답변 필요", ""]);
		expect(await q<boolean>(v, `return getComputedStyle(document.querySelector("#v-chat > .chatbox")).display === "none" && !$("#bell-list").hidden`)).toBe(true);
		if (width === 390) await shot(v, "bell-ask-390.png");

		await pick(v, "result");
		await waitFor(v, `document.querySelectorAll("#bell-list .hrx-m").length === 2`);
		expect(await rows(v)).toEqual(["야간 정리가 실패했어요", "세션 build 끝났어요"]);
		await pick(v, "alert");
		await waitFor(v, `document.querySelectorAll("#bell-list .hrx-m").length === 1`);
		expect(await rows(v)).toEqual(["게이트웨이가 멈췄어요"]);
		expect((await tabs(v)).filter(x => x.on).map(x => x.k)).toEqual(["alert"]);
		await pick(v, "all");
		await waitFor(v, `$("#bell-list").hidden && getComputedStyle(document.querySelector("#v-chat > .chatbox")).display !== "none"`);
	}, 30_000);

	test("새 소식 is grouped by app, newest group first, with a small header per app", async () => {
		const v = await boot(width, height);
		await openBell(v);
		await pick(v, "news");
		await waitFor(v, `document.querySelectorAll("#bell-list .bell-gh").length === 2`);
		const got = await q<{ gh: string[]; groups: string[][] }>(v, `return { gh: [...document.querySelectorAll("#bell-list .bell-gh")].map(x => x.textContent), groups: [...document.querySelectorAll("#bell-list .hn")].map(g => [...g.querySelectorAll(".nm")].map(x => x.textContent)) }`);
		expect(got.gh).toEqual(["메일", "카카오톡"]);
		expect(got.groups).toEqual([["읽은 메일 소식", "메일 답장이 왔어요", "새 메일 도착"], ["새 카톡이 왔어요"]]);
		expect(await q<boolean>(v, `const l = $("#bell-list"); return l.scrollWidth <= l.clientWidth`)).toBe(true);
		await shot(v, `bell-news-${width}.png`);
	}, 30_000);

	test("설정 shows the five class switches, and a toggle PUTs /api/push/classes", async () => {
		puts = [];
		classes = { ask: true, alert: true, result: true, news: true, conv: true, log: false };
		const v = await boot(width, height);
		await run(v, `go("settings")`);
		await waitFor(v, `document.querySelectorAll(".hs-sw[data-k]").length === 5`);
		expect(await q<string[][]>(v, `return [...document.querySelectorAll(".hs-sw[data-k]")].map(b => [b.dataset.k, b.getAttribute("aria-checked"), b.closest(".li").querySelector(".hd").textContent])`)).toEqual([
			["ask", "true", "답변 필요"], ["alert", "true", "경고"], ["result", "true", "결과"], ["news", "true", "새 소식"], ["conv", "true", "대화"]]);
		await run(v, `document.querySelector('.hs-sw[data-k="ask"]').scrollIntoView({ block: "start" })`);
		await shot(v, `push-${width}.png`);
		await run(v, `document.querySelector('.hs-sw[data-k="news"]').click()`);
		await hubState(() => puts.length === 1);
		expect(puts).toEqual([{ classes: { news: false } }]);
		await waitFor(v, `document.querySelector('.hs-sw[data-k="news"]').getAttribute("aria-checked") === "false"`);
		expect(await q<boolean>(v, `const s = document.querySelector(".hs-sw[data-k]").closest(".list"); return s.scrollWidth <= s.clientWidth`)).toBe(true);
	}, 30_000);
});
