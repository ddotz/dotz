// Background work on the page (web/js/06-subagents.js, 08-home.js, 41-runstate.js, 14-slash-commands.js): a worker that failed is
// the agent's to take up (owner 2026-10-29), so 홈 and the run line say 이어서 처리 중 in blue with no button and drop it once a turn
// took it up; only work the owner stopped offers 다시 맡기기. A running one offers 중단 there and on the work line, the run
// line's button acts on the conversation it is shown in, and 지금 진행 중 lists only what runs now.
import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const ago = (min: number) => Date.now() - min * 60_000;
const agoIso = (min: number) => new Date(ago(min)).toISOString();
type Work = Record<string, unknown>;
const RUNNING: Work = { id: "st_run", description: "흐름도 그리기", status: "running", started_at: ago(3), model: "Opus 5.5 medium" };
const FAILED: Work = { id: "st_fail", description: "빌드 고치기", status: "failed", started_at: ago(20), ended_at: ago(10), reason: "작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요" };
const STOPPED: Work = { id: "st_stop", description: "로그 정리", status: "failed", cancelled: true, started_at: ago(15), ended_at: ago(12), reason: "직접 중단했어요" };
const TAKEN: Work = { id: "st_taken", description: "이미 다룬 실패", status: "failed", handled: true, started_at: ago(40), ended_at: ago(35), reason: "x" };
const DONE: Work = { id: "st_done", description: "요약 쓰기", status: "done", started_at: ago(30), ended_at: ago(25) };
let WORK: Work[] = [RUNNING, FAILED, DONE];
let RUNS: Record<string, Record<string, unknown>> = {};
let ORCH = "idle";
const LANES = [{ name: "fix", title: "기술부채 정리", status: "idle", startedAt: agoIso(60), lastText: "The WebView worker is done", model: "anthropic/claude-opus-5-5" }];
const posts: string[] = [];
// A POST the page sends, awaited by path: subscribed before the click, resolved by the fixture server when it arrives.
const waiters: [string, () => void][] = [];
const posted = (path: string) => new Promise<void>(res => (posts.includes(path) ? res() : waiters.push([path, res])));
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
		if (req.method === "POST" && /^\/api\/(workers|lanes|orchestrator)\//.test(p)) { posts.push(p); for (const [w, res] of waiters) if (w === p) res(); return json({ ok: true }); }
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: ORCH, lastText: "ok" }, lanes: LANES, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, work: WORK, work_now: Date.now(), runs: RUNS });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/todo") return json({ phases: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
let load = 0;
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T>(v: View, body: string): Promise<T> => JSON.parse(String(await v.evaluate(`JSON.stringify((() => { ${body} })())`))) as T;
const boot = async (hash: string) => {
	const v = new Bun.WebView({ width: 1280, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/?load=${++load}${hash}`);
	await waitFor(v, `S && S.runs && typeof target === "string"`);
	return v;
};
const sections = (v: View) => q<Record<string, string[]>>(v, `const out = {}; for (const box of document.querySelectorAll("#home-now .hn[data-k]")) out[box.dataset.k] = [...box.children].map(r => r.textContent.replace(/\\s+/g, " ").trim()); return out;`);

test("홈: 지금 진행 중 is only what runs; waiting rows say their state in Korean; failed work is taken up, stopped work offers 다시 맡기기, and a lane is drawn once", async () => {
	WORK = [RUNNING, FAILED, STOPPED, TAKEN, DONE];
	RUNS = { main: { kind: "done", since: agoIso(5) }, "lane:fix": { kind: "idle", reason: "unfinished", todos: 2 } };
	ORCH = "idle";
	posts.length = 0;
	const v = await boot("#home");
	await waitFor(v, `current === "home" && document.querySelector('#home-now .hn[data-k="ended-work"]')`);
	const s = await sections(v);
	expect(s.running).toHaveLength(1);
	expect(s.running![0]).toContain("흐름도 그리기");
	expect(s.running![0]).toContain("Opus 5.5 medium");
	expect(s.waiting!.some(r => r.includes("끝났어요"))).toBe(true);
	expect(s.waiting!.some(r => r.includes("쉬는 중 · 할 일 2개 남음"))).toBe(true);
	expect(s.waiting!.join("|")).not.toContain("The WebView worker");
	expect(s["ended-work"]!.find(r => r.includes("빌드 고치기"))).toContain("이어서 처리 중");
	expect(s["ended-work"]!.find(r => r.includes("빌드 고치기"))).toContain("실패 · 작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요");
	expect(s["ended-work"]!.some(r => r.includes("이미 다룬 실패"))).toBe(false);
	expect(await v.evaluate(`document.querySelector('#home-now [data-work="st_fail"] .dot').className`)).toBe("dot pri");
	expect(s["ended-work"]!.find(r => r.includes("요약 쓰기"))).toContain("완료");
	// The session is a row above, not also a card on the board.
	await waitFor(v, `document.querySelector('#home-cards [data-id="main"]')`);
	expect(await v.evaluate(`!!document.querySelector('#home-cards [data-id="lane:fix"], #home-cards [data-id="group:lane"]')`)).toBe(false);
	expect(await v.evaluate(`document.querySelectorAll('#home-now [data-act="retry"]').length`)).toBe(1);
	const p__api_workers_st_stop_retry = posted("/api/workers/st_stop/retry");
	await v.evaluate(`(document.querySelector('#home-now [data-work="st_stop"] [data-act="retry"]').click(), 0)`);
	await p__api_workers_st_stop_retry;
	// 중단 on the running row asks first, then ends that worker.
	await v.evaluate(`(setTimeout(() => document.querySelector('#home-now [data-work="st_run"] [data-act="cancel"]').click()), 0)`);
	await waitFor(v, `document.querySelector("dialog[open] .dact .danger")`);
	const p__api_workers_st_run_cancel = posted("/api/workers/st_run/cancel");
	await v.evaluate(`(setTimeout(() => document.querySelector("dialog[open] .dact .danger").click()), 0)`);
	await p__api_workers_st_run_cancel;
}, 30_000);

test("홈: nothing running says so instead of listing idle conversations under 지금 진행 중", async () => {
	WORK = [];
	RUNS = { main: { kind: "idle" } };
	const v = await boot("#home");
	await waitFor(v, `current === "home" && document.querySelector('#home-now .hn[data-k="running"]')`);
	const s = await sections(v);
	expect(s.running).toEqual(["진행 중인 작업이 없어요"]);
	expect(s.waiting!.length).toBe(2);
	expect(s["ended-work"]).toBeUndefined();
}, 20_000);

test("the run line says 이어서 처리 중 for a failed worker, in blue with no button, and the work line's 중단 ends the background worker", async () => {
	WORK = [FAILED];
	RUNS = { main: { kind: "waiting", reason: "recover", since: agoIso(10), detail: "빌드 고치기 · 작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요", work: "st_fail" } };
	posts.length = 0;
	const v = await boot("#chat");
	await v.evaluate(`(setTarget(MAIN), go("chat"), 0)`);
	await waitFor(v, `!$("#runstate").hidden`);
	expect(await v.evaluate(`$("#runstate-tx").textContent`)).toBe("이어서 처리 중 · 빌드 고치기 실패");
	expect(await v.evaluate(`$("#runstate-act").hidden`)).toBe(true);
	expect(await v.evaluate(`$("#runstate-dot").className`)).toBe("dot pri");

	WORK = [{ ...RUNNING, target: "web" }];
	RUNS = { main: { kind: "waiting", reason: "work", since: agoIso(3), detail: "흐름도 그리기 · Opus 5.5 medium", work: "st_run" } };
	await v.evaluate(`refreshState().then(() => true)`);
	// The send button is the one 중단 (owner 2026-10-28): it turns into stop for the background worker; the run line has no second button.
	await waitFor(v, `!$("#working").hidden && $("#send-btn").classList.contains("stop")`);
	expect(await v.evaluate(`$("#runstate-act").hidden`)).toBe(true);
	await v.evaluate(`(setTimeout(() => $("#send-btn").click()), 0)`);
	await waitFor(v, `document.querySelector("dialog[open] .dact .danger")`);
	const p__api_workers_st_run_cancel = posted("/api/workers/st_run/cancel");
	await v.evaluate(`(setTimeout(() => document.querySelector("dialog[open] .dact .danger").click()), 0)`);
	await p__api_workers_st_run_cancel;
	expect(posts).not.toContain("/api/orchestrator/abort");
}, 30_000);

test("the run line's button acts on its own conversation: a session restarts itself, a mail worker is handed over again, a feed gets nothing", async () => {
	const v = await boot("#chat");
	const act = (r: Record<string, unknown>, t: string) => v.evaluate(`(() => { const a = runAction(${JSON.stringify(r)}, ${JSON.stringify(t)}); return a ? a.label : null; })()`);
	const err = { kind: "error", detail: "모델 오류" };
	expect(await act(err, "main")).toBe("다시 시도");
	expect(await act(err, "lane:fix")).toBe("다시 시작");
	expect(await act({ kind: "stopped" }, "lane:fix")).toBe("다시 시작");
	expect(await act({ kind: "limited", reason: "rate" }, "lane:fix")).toBeNull();
	expect(await act({ kind: "error", reason: "work", cancelled: true, work: "st_stop" }, "mail:k1")).toBe("다시 맡기기");
	expect(await act({ kind: "waiting", reason: "recover", work: "st_fail" }, "mail:k1")).toBeNull();
	expect(await act({ kind: "working", work: "st_run" }, "mail:k1")).toBeNull();   // stopped by the send button, not the run line
	expect(await act(err, "mail:k1")).toBeNull();
	expect(await act(err, "alert")).toBeNull();
	expect(await act({ kind: "stopped" }, "worklog")).toBeNull();
	// A session's 다시 시작 calls that session's restart, never the assistant's.
	posts.length = 0;
	const p__api_lanes_fix_restart = posted("/api/lanes/fix/restart");
	await v.evaluate(`(runAction({ kind: "stopped" }, "lane:fix").run({ currentTarget: null }), 0)`);
	await p__api_lanes_fix_restart;
	expect(posts).not.toContain("/api/orchestrator/restart");
}, 20_000);
