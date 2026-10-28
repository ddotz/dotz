// The run state line above the composer (web/js/41-runstate.js) in a headless browser against a stub gateway: every kind
// renders its own words and action, and an idle conversation with plan tasks left always names why (a question, background
// work, the last turn ending with work left, unknown). Screenshots go to RUNSTATE_SHOTS when it is set.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.RUNSTATE_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
type Run = { kind: string; reason?: string; since?: string; detail?: string; todos?: number };
const ts = (minusMin: number) => new Date(Date.UTC(2026, 9, 26, 3, 0) - minusMin * 60_000).toISOString();
let RUN: Run = { kind: "idle" };
let ORCH: Record<string, unknown> = { status: "idle" };
let ITEMS: unknown[] = [];
let posted: (body: Record<string, unknown>) => void = () => {};
let resumed = 0, restarted = 0;
let resumeHit: () => void = () => {}, restartHit: () => void = () => {};
const hit = (fn: "resume" | "restart") => new Promise<void>(res => { if (fn === "resume") resumeHit = res; else restartHit = res; });
const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: ORCH, runs: { main: RUN }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() });
		if (p === "/api/notices") return json({ unread: 0, items: ITEMS });
		if (p === "/api/todo") return json({ phases: [] });
		if (p === "/api/history") return json({ target: "main", events: [{ ts: ts(30), kind: "out", source: "orchestrator", text: "지난 답변이에요." }] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/message") { posted(await req.json()); return json({ ok: true }); }
		if (p === "/api/orchestrator/resume") { resumed++; resumeHit(); return json({ ok: true }); }
		if (p === "/api/orchestrator/restart") { restarted++; restartHit(); return json({ ok: true }); }
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
let load = 0;
const waitFor = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const boot = async (width = 390, height = 844) => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/?load=${++load}#chat`);
	await waitFor(v, `typeof target === "string" && target === "main" && !document.querySelector("#runstate").hidden`);
	return v;
};
// Elapsed time is measured by the gateway's clock (/api/state work_now, which this stub sets from Date.now), so "7 minutes ago" starts there.
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const show = async (v: InstanceType<typeof Bun.WebView>, run: Run, orch: Record<string, unknown> = { status: "idle" }) => {
	RUN = run;
	ORCH = orch;
	await v.evaluate(`refreshState().then(() => true)`);
	await waitFor(v, `document.querySelector("#runstate").hidden === false && document.querySelector("#runstate-tx").textContent.length > 0`);
	return v.evaluate(`(() => ({ text: document.querySelector("#runstate-tx").textContent, act: document.querySelector("#runstate-act").hidden ? "" : document.querySelector("#runstate-act").textContent }))()`);
};
const shot = async (v: InstanceType<typeof Bun.WebView>, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };

test("working says what it is doing and for how long, with no action", async () => {
	const v = await boot();
	const r = await show(v, { kind: "working", since: ago(7), detail: "테스트 실행하는 중" }, { status: "working" });
	expect(r.text).toBe("작업 중 · 테스트 실행하는 중 · 7분");
	expect(r.act).toBe("");
	await shot(v, "run-working-390.png");
}, 20_000);

test("working at 1280px shows the same line", async () => {
	const v = await boot(1280, 900);
	const r = await show(v, { kind: "working", since: ago(2), detail: "커밋 정리하는 중" }, { status: "working" });
	expect(r.text).toBe("작업 중 · 커밋 정리하는 중 · 2분");
	await shot(v, "run-working-1280.png");
}, 20_000);

test("a question waiting on the owner: 답을 기다려요 with 질문으로 가기, which opens the decision", async () => {
	ITEMS = [{ id: "d1", ts: ts(3), updated: ts(3), kind: "decision", tone: "ask", title: "지금 배포할까요?", text: "지금 배포할까요?", open: "main", src: "main", at: ts(3), key: "dec:main:1", read: false,
		decision: { options: [{ n: 1, label: "지금", desc: "", rec: false }, { n: 2, label: "나중에", desc: "", rec: false }], to: "main", group: 1, state: "open" } }];
	const v = await boot();
	const r = await show(v, { kind: "waiting", reason: "ask", since: ts(3), detail: "지금 배포할까요?", todos: 2 });
	expect(r.text).toBe("답을 기다려요 · 지금 배포할까요? · 할 일 2개 남음");
	expect(r.act).toBe("질문으로 가기");
	await shot(v, "run-waiting-390.png");
	await v.evaluate(`document.querySelector("#runstate-act").click()`);
	await waitFor(v, `document.querySelector('.fs-card[role="dialog"] #ds-t') && document.querySelector("#ds-t").textContent.includes("배포할까요")`);
	ITEMS = [];
}, 20_000);

test("waiting at 1280px names the question too", async () => {
	ITEMS = [{ id: "d2", ts: ts(5), updated: ts(5), kind: "decision", tone: "ask", title: "어느 쪽으로 할까요?", text: "어느 쪽으로 할까요?", open: "main", src: "main", at: ts(5), key: "dec:main:2", read: false,
		decision: { options: [{ n: 1, label: "가", desc: "", rec: false }, { n: 2, label: "나", desc: "", rec: false }], to: "main", group: 1, state: "open" } }];
	const v = await boot(1280, 900);
	await show(v, { kind: "waiting", reason: "ask", since: ts(5), detail: "어느 쪽으로 할까요?" });
	await shot(v, "run-waiting-1280.png");
	ITEMS = [];
}, 20_000);

// Owner 2026-10-28: the 계속하기 button was in the way; the line only says why it stopped, a message continues it.
test("idle with tasks left and a turn that ended: the reason, and no button", async () => {
	const v = await boot();
	const r = await show(v, { kind: "idle", reason: "unfinished", since: ts(12), detail: "테스트", todos: 2 });
	expect(r.text).toBe("쉬는 중 · 할 일 2개 남음 · 이번 턴이 끝났는데 할 일이 남아 있어요");
	expect(await v.evaluate(`$("#runstate-act").hidden`)).toBe(true);
	await shot(v, "run-idle-todos-390.png");
}, 20_000);

test("idle at 1280px with tasks left", async () => {
	const v = await boot(1280, 900);
	await show(v, { kind: "idle", reason: "unfinished", since: ts(20), todos: 3 });
	await shot(v, "run-idle-todos-1280.png");
}, 20_000);

test("idle with tasks left and no known turn: 이유를 알 수 없어요, and no button", async () => {
	const v = await boot();
	const r = await show(v, { kind: "idle", reason: "unknown", todos: 1 });
	expect(r.text).toBe("쉬는 중 · 할 일 1개 남음 · 이유를 알 수 없어요");
	expect(await v.evaluate(`$("#runstate-act").hidden`)).toBe(true);
}, 20_000);

test("idle waiting on background work or a deferred answer names it", async () => {
	const v = await boot();
	expect((await show(v, { kind: "waiting", reason: "work", since: ago(4), detail: "LiveStatusLine 구현", todos: 1 })).text)
		.toBe("맡긴 작업 진행 중 · LiveStatusLine 구현 · 4분 · 할 일 1개 남음");
	expect((await show(v, { kind: "waiting", reason: "later", todos: 2 })).text).toBe("맡긴 작업 진행 중 · 할 일 2개 남음");
}, 20_000);

test("a usage limit says until when and offers 지금 다시 시도", async () => {
	const v = await boot();
	const until = new Date(Date.now() + 40 * 60_000).toISOString();
	const r = await show(v, { kind: "limited", reason: "rate", since: ts(1), detail: until }, { status: "rate-limited", pauseKind: "rate", rateLimitedUntil: until });
	expect(r.text).toMatch(/^한도에 걸렸어요 · .+까지$/);
	expect(r.act).toBe("지금 다시 시도");
	const hitOnce = hit("resume");
	await v.evaluate(`document.querySelector("#runstate-act").click()`);
	await hitOnce;
	expect(resumed).toBe(1);
}, 20_000);

test("a stopped turn on an error says the plain reason and offers 다시 시도", async () => {
	const v = await boot();
	const r = await show(v, { kind: "error", since: ts(9), detail: "네트워크 연결이 계속 끊겨요" }, { status: "idle", error: { text: "네트워크 연결이 계속 끊겨요", since: ts(9) } });
	expect(r.text).toBe("오류로 멈췄어요 · 네트워크 연결이 계속 끊겨요");
	expect(r.act).toBe("다시 시도");
}, 20_000);

test("stopped by the owner offers 다시 시작; a finished turn says 끝났어요 with no action", async () => {
	const v = await boot();
	const stopped = await show(v, { kind: "stopped", reason: "owner", since: ts(6) }, { status: "stopped", stoppedBy: "owner" });
	expect(stopped).toEqual({ text: "멈춤 · 직접 멈췄어요", act: "다시 시작" });
	const hitOnce = hit("restart");
	await v.evaluate(`document.querySelector("#runstate-act").click()`);
	await hitOnce;
	expect(restarted).toBe(1);
	const done = await show(v, { kind: "done", since: ts(15) });
	expect(done.text.startsWith("끝났어요")).toBe(true);
	expect(done.act).toBe("");
}, 20_000);
