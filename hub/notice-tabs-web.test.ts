// The filters of the 알림 screen #notices (전체 / 답변 필요 / 결과 / 새 소식 / 경고, each with its unread count by notice class) and the five per-class push
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
	mk("n1", 5, "news", "watch", "", "새 메일 도착", { app: "mail", watch: "mail-1" }),
	mk("n2", 6, "news", "watch", "", "메일 답장이 왔어요", { app: "mail", watch: "mail-1" }),
	mk("n3", 7, "news", "watch", "", "새 카톡이 왔어요", { app: "kakao", watch: "kakao-1" }),
	mk("n4", 8, "news", "watch", "", "읽은 메일 소식", { app: "mail", watch: "mail-1", read: true }),
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
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NT.items.length === ${notices.length} `);
	return v;
}
const shot = async (v: View, name: string) => Bun.write(join(SHOTS, name), await v.screenshot());
type Tab = { k: string; label: string; n: string; on: boolean };
const tabs = (v: View) => q<Tab[]>(v, `return [...document.querySelectorAll("#v-notices .nsc-fb")].map(b => ({ k: b.dataset.f, label: b.firstChild.textContent, n: b.querySelector(".n").textContent, on: b.classList.contains("on") }))`);
const openBell = async (v: View) => {
	await run(v, `go("notices")`);
	await waitFor(v, `current === "notices" && document.querySelector("#v-notices .nsc-r")`);
};
const pick = (v: View, k: string) => run(v, `document.querySelector('#v-notices .nsc-fb[data-f="${k}"]').click()`);
const rows = (v: View) => q<string[]>(v, `return [...document.querySelectorAll("#v-notices .nsc-r .hd")].map(x => x.textContent)`);

describe.each([[390, 844], [1280, 900]] as const)("at %ipx", (width, height) => {
	test("the filters carry the unread count of their class (log is not on the screen, conv is under 새 소식); 전체 is every group", async () => {
		const v = await boot(width, height);
		await openBell(v);
		const t = await tabs(v);
		expect(t.map(x => [x.k, x.label, x.n, x.on])).toEqual([["all", "전체", "8", true], ["ask", "답변 필요", "1", false], ["result", "결과", "2", false], ["news", "새 소식", "4", false], ["alert", "경고", "1", false]]);
		expect(await q<string[]>(v, `return [...document.querySelectorAll("#v-notices .sec")].map(x => x.textContent)`)).toEqual(["처리할 것", "새 소식", "지난 알림"]);
		expect(await q<number>(v, `return document.querySelectorAll("#v-notices .nsc-r").length`)).toBe(10);   // 12 notices less the two log
		// the conversation's unread answer is a row of its own under 새 소식, tagged 대화; the log ones are no row
		expect(await q<string[][]>(v, `return [...document.querySelectorAll("#v-notices .list[data-g]")].map(g => [g.dataset.g, ...[...g.querySelectorAll(".nsc-r")].map(r => r.dataset.nid)])`)).toEqual([["need", "q-open"], ["news", "m1", "a1", "n3", "n2", "n1", "r2", "r1"], ["past", "n4", "q-old"]]);
		expect(await q<string>(v, `return document.querySelector('#v-notices .nsc-r[data-nid="m1"] .tag').textContent`)).toBe("대화");
		expect(await q<number>(v, `return document.querySelectorAll('#v-notices .nsc-r[data-nid="l1"], #v-notices .nsc-r[data-nid="l2"]').length`)).toBe(0);
		expect(await q<boolean>(v, `const c = document.querySelector("#v-notices .nsc-f"); return c.scrollWidth <= c.clientWidth || getComputedStyle(c).overflowX === "auto"`)).toBe(true);
		await shot(v, `notices-all-${width}.png`);
	}, 30_000);

	test("답변 필요 lists what waits on top; 결과 and 경고 list their own class; log is in no filter; conv is only in 새 소식 and 전체", async () => {
		const v = await boot(width, height);
		await openBell(v);
		await pick(v, "ask");
		await waitFor(v, `document.querySelectorAll("#v-notices .nsc-r").length === 2`);
		expect(await rows(v)).toEqual(["배포할까요?", "예전 질문"]);
		expect(await q<string[]>(v, `return [...document.querySelectorAll("#v-notices .nsc-r .tag")].map(x => x.textContent)`)).toEqual(["결정", "결정"]);
		if (width === 390) await shot(v, "notices-ask-390.png");

		await pick(v, "result");
		await waitFor(v, `document.querySelectorAll("#v-notices .nsc-r").length === 2 && document.querySelector('#v-notices .nsc-fb[data-f="result"].on')`);
		expect(await rows(v)).toEqual(["야간 정리가 실패했어요", "세션 build 끝났어요"]);
		await pick(v, "alert");
		await waitFor(v, `document.querySelectorAll("#v-notices .nsc-r").length === 1`);
		expect(await rows(v)).toEqual(["게이트웨이가 멈췄어요"]);
		expect((await tabs(v)).filter(x => x.on).map(x => x.k)).toEqual(["alert"]);
		await pick(v, "all");
		await waitFor(v, `document.querySelectorAll("#v-notices .nsc-r").length === 10`);
	}, 30_000);

	test("새 소식 filter: unread first and newest first, the read one under 지난 알림, the tag from the app, no app headers", async () => {
		const v = await boot(width, height);
		await openBell(v);
		await pick(v, "news");
		await waitFor(v, `document.querySelectorAll("#v-notices .nsc-r").length === 5`);
		const got = await q<{ sec: string[]; groups: string[][]; tags: string[] }>(v, `return { sec: [...document.querySelectorAll("#v-notices .sec")].map(x => x.textContent), groups: [...document.querySelectorAll("#v-notices .list[data-g]")].map(g => [...g.querySelectorAll(".hd")].map(x => x.textContent)), tags: [...document.querySelectorAll("#v-notices .nsc-r .tag")].map(x => x.textContent) }`);
		expect(got.sec).toEqual(["새 소식", "지난 알림"]);
		expect(got.groups).toEqual([["프로젝트 대화에 새 답이 있어요", "새 카톡이 왔어요", "메일 답장이 왔어요", "새 메일 도착"], ["읽은 메일 소식"]]);
		expect(got.tags).toEqual(["대화", "카카오톡", "메일", "메일", "메일"]);
		expect(await q<boolean>(v, `const l = document.querySelector("#v-notices"); return l.scrollWidth <= l.clientWidth`)).toBe(true);
		await shot(v, `notices-news-${width}.png`);
	}, 30_000);

	test("설정 shows the six class switches, and a toggle PUTs /api/push/classes", async () => {
		puts = [];
		classes = { ask: true, alert: true, result: true, news: true, conv: true, log: false };
		const v = await boot(width, height);
		await run(v, `go("notifications")`);
		await waitFor(v, `document.querySelectorAll(".hs-sw[data-k]").length === 6`);
		expect(await q<string[][]>(v, `return [...document.querySelectorAll(".hs-sw[data-k]")].map(b => [b.dataset.k, b.getAttribute("aria-checked"), b.closest(".li").querySelector(".hd").textContent])`)).toEqual([
			["ask", "true", "답변 필요"], ["alert", "true", "경고"], ["result", "true", "결과"], ["news", "true", "새 소식"], ["conv", "true", "대화"], ["log", "false", "진행"]]);
		await run(v, `document.querySelector('.hs-sw[data-k="ask"]').scrollIntoView({ block: "start" })`);
		await shot(v, `push-${width}.png`);
		await run(v, `document.querySelector('.hs-sw[data-k="news"]').click()`);
		await hubState(() => puts.length === 1);
		expect(puts).toEqual([{ classes: { news: false } }]);
		await waitFor(v, `document.querySelector('.hs-sw[data-k="news"]').getAttribute("aria-checked") === "false"`);
		expect(await q<boolean>(v, `const s = document.querySelector(".hs-sw[data-k]").closest(".list"); return s.scrollWidth <= s.clientWidth`)).toBe(true);
	}, 30_000);
});
