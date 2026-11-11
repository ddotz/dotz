// Consecutive 백그라운드 작업 rows share one grid across the chat column: up to three per line by the column's width, the last line filling it.
import { afterAll, expect, test } from "bun:test";
import { appAsset, indexPage } from "./webapp.ts";

const NOW = Date.now(), iso = (ago: number) => new Date(NOW - ago).toISOString();
const LONG = "결과 파일을 모아서 정리한 뒤에 다음 주 회의 자료까지 함께 만들어 두는 아주 긴 이름의 작업이고 이 제목은 어떤 카드에서든 두 줄을 넘어가요";
let clock = 900_000;
const row = (id: string, title: string) => { clock -= 1000; return { ts: iso(clock), kind: "out", source: "gateway", target: "web", text: `백그라운드 작업으로 맡겼어요: ${title}`, system: "deferred", worker: id, work: { id, status: "running", at: NOW, created_at: NOW - 900_000 } }; };
const say = (text: string) => { clock -= 1000; return { ts: iso(clock), kind: "message", source: "web", channel: "web", text, mid: text }; };
const SIZES = [1, 2, 3, 4, 5];
const HISTORY = SIZES.flatMap(n => [say(`묶음 ${n}`), ...Array.from({ length: n }, (_, i) => row(`st_${n}_${i}`, i ? `일 ${i}` : LONG))]);

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return new Response(new ReadableStream({ start(c) { c.enqueue("retry: 20\n\nevent: reset\ndata: {}\n\n"); } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
		if (p === "/api/state") return Response.json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, work: [], work_now: Date.now(), runs: { main: { state: "idle" } } });
		if (p === "/api/notices") return Response.json({ unread: 0, items: [] });
		if (p === "/api/conversations") return Response.json({ items: [{ target: "main", unread: 0, read: null, last: null }] });
		if (p === "/api/history") return Response.json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? HISTORY : [] });
		if (p === "/api/activity") return Response.json({ items: [], more: false, history: false });
		if (p === "/api/todo") return Response.json({ phases: [] });
		return p.startsWith("/api/") ? Response.json({}) : new Response("not found", { status: 404 });
	},
});
const v = new Bun.WebView({ width: 1280, height: 900 });
afterAll(() => { v.close(); server.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const frames = () => v.evaluate(`new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(1))))`);
// A changed card scales and a new one rises for a moment, which would skew its box.
const settle = async () => { await v.evaluate(`(document.querySelectorAll("#tl .cv-task").forEach(c => c.getAnimations().forEach(a => a.finish())), 0)`); await frames(); };
type Line = { n: number; fills: boolean; even: boolean };
// Each group as its lines of cards: how many, whether they span the group's whole width, whether they share a height.
const lines = async () => await v.evaluate(`JSON.stringify([...document.querySelectorAll("#tl .cv-tasks")].map(g => {
	const box = g.getBoundingClientRect(), by = new Map();
	for (const c of g.children) { const r = c.getBoundingClientRect(), k = Math.round(r.top); by.set(k, [...(by.get(k) || []), r]); }
	return { full: Math.abs(box.width - document.querySelector("#tl").getBoundingClientRect().width) < 1, lines: [...by.values()].map(rs => ({ n: rs.length, fills: Math.abs(rs[0].left - box.left) < 1 && Math.abs(rs.at(-1).right - box.right) < 1, even: new Set(rs.map(r => Math.round(r.height))).size === 1 })) };
}))`).then(s => JSON.parse(String(s))) as { full: boolean; lines: Line[] }[];
const expectLayout = async (want: number[][]) => {
	await settle();
	const got = await lines();
	expect(got.map(g => g.lines.map(l => l.n))).toEqual(want);
	expect(got.every(g => g.full && g.lines.every(l => l.fills && l.even))).toBe(true);
};

test("1 to 5 rows lay out by the column's width, every line filling it", async () => {
	await v.navigate(`http://127.0.0.1:${server.port}/?grid=1#chat`);
	await waitFor(`document.querySelectorAll("#tl .cv-tasks").length === 5 && [...document.querySelectorAll("#tl .cv-sys-st")].every(s => !s.hidden)`);
	await expectLayout([[1], [2], [3], [3, 1], [3, 2]]);

	// A title stops at two lines and takes only the lines it has (no empty line under a short one), and the pill stays inside its card.
	const fit = await v.evaluate(`JSON.stringify([...document.querySelectorAll("#tl .cv-task")].map(c => { const t = c.querySelector(".ct-t"), p = c.querySelector(".ct-pill").getBoundingClientRect(), r = c.getBoundingClientRect(); return { long: t.textContent.includes("아주 긴"), tall: Math.round(t.getBoundingClientRect().height), inside: p.right <= r.right && p.left >= r.left }; }))`).then(s => JSON.parse(String(s))) as { long: boolean; tall: number; inside: boolean }[];
	expect(fit.every(f => f.tall === (f.long ? 44 : 22) && f.inside)).toBe(true);

	await v.resize(412, 900);
	await expectLayout([[1], [2], [2, 1], [2, 2], [2, 2, 1]]);

	// The column decides, not the window: a narrow column in a wide window, then one too thin for two.
	await v.resize(1280, 900);
	await v.evaluate(`(document.querySelector("#tl").style.width = "400px", 0)`);
	await expectLayout([[1], [2], [2, 1], [2, 2], [2, 2, 1]]);
	await v.evaluate(`(document.querySelector("#tl").style.width = "280px", 0)`);
	await expectLayout([[1], [1, 1], [1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1, 1]]);
	await v.evaluate(`(document.querySelector("#tl").style.width = "", 0)`);
}, 30_000);

test("a finished job keeps every card's height and the scroll position", async () => {
	await v.evaluate(`(timeline.style.scrollBehavior = "auto", timeline.scrollTop = 120, 0)`);
	await frames();
	const shape = `JSON.stringify({ top: timeline.scrollTop, boxes: [...document.querySelectorAll("#tl .cv-task")].map(c => { const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); }) })`;
	const before = await v.evaluate(shape);
	await v.evaluate(`(workRowsLive({ at: ${NOW + 1000}, items: [
		{ id: "st_5_0", status: "done", files: [{ path: "/tmp/회의-자료-묶음.pdf", name: "회의-자료-묶음.pdf", size: 2048 }] },
		{ id: "st_5_1", status: "done" }, { id: "st_5_2", status: "failed" }, { id: "st_5_3", status: "failed", cancelled: true },
	] }), 0)`);
	await waitFor(`document.querySelector("#tl .cv-tasks:last-child .ct-file")`);
	await settle();
	expect(await v.evaluate(shape)).toBe(before);
	expect(await v.evaluate(`[...document.querySelectorAll("#tl .cv-tasks:last-child .cv-task")].filter(c => c.querySelector(".ct-bar")).length`)).toBe(2);
});

test("a live row joins the last run, past a folded tool group, and a chat message starts the next one", async () => {
	const push = (e: unknown) => v.evaluate(`(chatPush({ m: ${JSON.stringify(e)} }), 0)`);
	await v.evaluate(`(chatPush({ a: { type: "tool_call", ts: ${JSON.stringify(iso(0))}, tool: "bash", id: "t1", args: {} } }), 0)`);
	expect(await v.evaluate(`document.querySelector("#tl").lastElementChild.matches("details.work")`)).toBe(true);
	await push({ ...row("st_new", "새로 맡긴 일"), ts: iso(0) });
	await expectLayout([[1], [2], [3], [3, 1], [3, 3]]);
	await push({ ...say("이어서 해 줘"), ts: iso(0) });
	await push({ ...row("st_after", "말 다음에 맡긴 일"), ts: iso(0) });
	await expectLayout([[1], [2], [3], [3, 1], [3, 3], [1]]);
});
