// A chat's 백그라운드 작업 row changes in place when its job ends, over the stream, after a reload and after a gateway restart: the jobs here
// are not in /api/state `work` (another session's, or ended more than an hour ago), so only hub/workrows.ts can say how they went.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { omoWorkById } from "./bgwork.ts";
import { appAsset, indexPage } from "./webapp.ts";
import { createWorkRows, type WorkRow } from "./workrows.ts";

const dir = mkdtempSync(join(tmpdir(), "dz-work-row-")), tasks = join(dir, "projects", "p1", "senpi-task", "tasks");
mkdirSync(tasks, { recursive: true });
const NOW = Date.now(), iso = (ago: number) => new Date(NOW - ago).toISOString();
const record = (id: string, over: Record<string, unknown> = {}) =>
	writeFileSync(join(tasks, `${id}.json`), JSON.stringify({ task_id: id, status: "running", root_session_id: "elsewhere", created_at: iso(600_000), updated_at: iso(1000), pid: process.pid, description: "일", ...over }));
const row = (ago: number, worker: string, title: string) => ({ ts: iso(ago), kind: "out", source: "gateway", target: "web", text: `백그라운드 작업으로 맡겼어요: ${title}`, system: "deferred", worker });
const HISTORY = [
	{ ts: iso(600_000), kind: "message", source: "web", channel: "web", text: "해 줘", mid: "m1" },
	row(590_000, "st_live", "끝나는 일"),
	row(580_000, "st_twice", "두 줄 일 처음"),
	row(570_000, "st_twice", "두 줄 일 다음"),
	row(560_000, "st_down", "꺼진 사이 끝나는 일"),
	row(550_000, "st_gone", "기록이 없는 일"),
	row(540_000, "st_again", "이어받힌 일"),
	row(530_000, "st_fail", "실패하는 일"),
	row(520_000, "st_stop", "멈춘 일"),
	{ ts: iso(500_000), kind: "out", source: "orchestrator", target: "web", text: "맡겼어요." },
];
for (const id of ["st_live", "st_twice", "st_down", "st_fail", "st_stop"]) record(id);
record("st_again", { created_at: iso(10_000) });

const streams = new Set<ReadableStreamDefaultController<string>>();
let onStream = () => {};
const streamOpen = () => (streams.size ? Promise.resolve() : new Promise<void>(res => { onStream = res; }));
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const gateway = () => createWorkRows({
	find: id => omoWorkById(id, [join(dir, "projects")]),
	answer: w => (w.target ? { at: iso(500_000), conv: "main", exact: true } : undefined),
	replyOf: () => undefined,
	push: (items: WorkRow[], at: number) => { for (const s of streams) s.enqueue(frame({ kind: "work", items, at })); },
});
let rows = gateway(), up = true;
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
		if (!up) return new Response("down", { status: 503 });
		if (p === "/api/events") {
			let mine: ReadableStreamDefaultController<string>;
			return new Response(new ReadableStream<string>({
				start(c) { mine = c; streams.add(c); c.enqueue("retry: 20\n\nevent: reset\ndata: {}\n\n"); onStream(); },
				cancel() { streams.delete(mine); },
			}), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
		}
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, work: [], work_now: Date.now(), runs: { main: { state: "idle" } } });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/conversations") return json({ items: [{ target: "main", unread: 0, read: null, last: null }] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? rows.stamp(HISTORY) : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/todo") return json({ phases: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const v = new Bun.WebView({ width: 760, height: 900 });
afterAll(() => { v.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); });

const waitFor = (expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const pills = `[...document.querySelectorAll("#tl .cv-task")].map(n => n.querySelector(".ct-t").textContent + ":" + (n.querySelector(".cv-sys-st").hidden ? "" : n.querySelector(".cv-sys-st").textContent))`;
const expected = (live: string, twice: string, down: string, fail: string, stop: string) => [`끝나는 일:${live}`, `두 줄 일 처음:${twice}`, `두 줄 일 다음:${twice}`, `꺼진 사이 끝나는 일:${down}`, "기록이 없는 일:끝남", "이어받힌 일:중단됨", `실패하는 일:${fail}`, `멈춘 일:${stop}`];
const seen = (want: string[]) => waitFor(`JSON.stringify(${pills}) === ${JSON.stringify(JSON.stringify(want))}`);

test("rows change in place over the stream, stay right after a reload, and a job that ended during a gateway restart is reconciled", async () => {
	await v.navigate(`http://127.0.0.1:${server.port}/?row=1#chat`);
	await seen(expected("진행 중", "진행 중", "진행 중", "진행 중", "진행 중"));
	await streamOpen();

	// Live: the same nodes, in the same places, no new row and no reload.
	await v.evaluate(`(window.__rows = [...document.querySelectorAll("#tl .cv-task")], window.__page = 1, 0)`);
	record("st_live", { status: "completed", terminal_at: iso(2000) });
	record("st_twice", { status: "completed", terminal_at: iso(2000) });
	record("st_fail", { status: "error", terminal_at: iso(2000), error_message: "boom" });
	record("st_stop", { status: "cancelled", terminal_at: iso(2000) });
	rows.sweep();
	await seen(expected("완료", "완료", "진행 중", "실패", "중단됨"));
	expect(await v.evaluate(`window.__page === 1 && [...document.querySelectorAll("#tl .cv-task")].every((n, i) => n === window.__rows[i])`)).toBe(true);
	expect(await v.evaluate(`document.querySelector("#tl .cv-task .ct-hd").title`)).toBe("결과 보기");
	await v.evaluate(`(ntJump = j => (window.__jump = j), document.querySelector("#tl .cv-task .ct-hd").click(), 0)`);
	await waitFor(`window.__jump && window.__jump.src === "main" && window.__jump.at === ${JSON.stringify(iso(500_000))}`);

	// Reload: the same words, though /api/state knows none of these jobs.
	await v.navigate(`http://127.0.0.1:${server.port}/?row=2#chat`);
	await seen(expected("완료", "완료", "진행 중", "실패", "중단됨"));

	// The gateway goes down, the job ends meanwhile, and a new gateway comes up: the open page learns it from the reset.
	up = false;
	for (const s of streams) s.close();
	streams.clear();
	record("st_down", { status: "completed", terminal_at: iso(1000) });
	rows = gateway();
	up = true;
	await seen(expected("완료", "완료", "완료", "실패", "중단됨"));
	expect(await v.evaluate(`document.querySelectorAll("#tl .cv-task").length`)).toBe(8);
}, 30_000);
