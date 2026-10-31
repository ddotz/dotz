// A conversation counts as read as soon as a message's bottom is on screen while it is open and the page is visible (owner 2026-10-31:
// "들어가서 해당 메시지 하단까지 내 화면에 보이면 숫자 사라지게"): on opening, when a message arrives at the bottom, after the layout settles -
// never waiting for a scroll. The read position goes up to the last message whose bottom is visible, and a hidden page reads nothing until it
// shows. Headless (Bun.WebView) against a fake hub; the read position is posted like the real page does (POST /api/read).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { emit, sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.CHAT_READ_SHOTS ?? "/tmp/dotz-chat-read";
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown) => Response.json(v);
const iso = (m: number) => new Date(Date.UTC(2026, 9, 31, 1, m)).toISOString();

type Ev = { kind: string; ts: string; source: string; channel: string; text: string };
const say = (m: number, text: string, owner = false): Ev => ({ kind: owner ? "message" : "out", ts: iso(m), source: owner ? "owner" : "orchestrator", channel: "web", text });
// The main chat: what the fake hub holds, its read position and every read the page posted.
let msgs: Ev[] = [];
let read: string | null = null;
const posts: { target: string; ts: string }[] = [];
const unread = () => msgs.filter(e => e.kind === "out" && (!read || e.ts > read)).length;
function reset(list: Ev[], at: string | null) { msgs = list; read = at; posts.length = 0; }

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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }]);
		if (p === "/api/conversations") {
			const last = msgs.at(-1);
			return json({ items: [{ target: "main", unread: unread(), read, last: last ? { ts: last.ts, text: last.text, from: last.kind === "out" ? "bot" : "owner" } : null }] });
		}
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" && !url.searchParams.get("before") ? msgs : [] });
		if (p === "/api/read" && req.method === "POST") {
			const b = (await req.json()) as { target: string; ts: string };
			posts.push(b);
			if (b.target === "main" && (!read || b.ts > read)) read = b.ts;
			return json({ ok: true, target: b.target, ts: read, moved: true });
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
// each test's pages close with it, so none of them reads (or hears) the next test's conversation
afterEach(() => { for (const v of views.splice(0)) v.close(); });
afterAll(() => server.stop(true));
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
// A bounded wait for a post the page makes to the fake hub (no fixed sleep decides anything).
const until = async (ok: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timeout waiting for the hub"); await Bun.sleep(20); } };

// The page boots on the conversation list; `hidden` makes it report a hidden page before the conversation opens. Scroll events are counted
// so a test can say none was needed.
// `churn` keeps the content changing size (a live session's progress, cards loading), which re-places the opening's anchor every few frames.
async function boot(width: number, height: number, hidden = false, churn = false): Promise<View> {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && CV.loaded`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle();
		window.__scrolls = 0; timeline.addEventListener("scroll", () => window.__scrolls++);
		window.__vis = "visible";
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis });
		Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__vis !== "visible" });
		window.__vis = ${JSON.stringify(hidden ? "hidden" : "visible")};
		if (${churn}) { let n = 0; setInterval(() => { let g = document.getElementById("churn"); if (!g) { g = document.createElement("div"); g.id = "churn"; tl.append(g); } g.style.height = (n++ % 2 ? 0 : 2) + "px"; }, 50); }
		setTarget(MAIN); go("chat");`);
	await waitFor(v, `current === "chat" && target === MAIN && CV.placed && tl.querySelectorAll("[data-ts]").length > 0`);
	return v;
}
// The last message whose bottom is inside the timeline's visible box.
const lastVisible = (v: View) => q<string>(v, `const b = timeline.getBoundingClientRect().bottom; return [...tl.querySelectorAll("[data-ts]")].filter(m => m.getBoundingClientRect().bottom <= b + 1).at(-1)?.dataset.ts ?? ""`);

beforeEach(() => reset([], null));

describe.each([[412, 915], [1280, 900]] as const)("at %ipx", (width, height) => {
	test("unread messages that fit on screen are read on opening, with no scroll", async () => {
		reset([say(0, "어제 정리한 내용이에요."), say(1, "확인했어요", true), say(2, "첫 번째 새 소식"), say(3, "두 번째 새 소식"), say(4, "세 번째 새 소식")], iso(1));
		const v = await boot(width, height);
		await until(() => posts.length > 0);
		expect(posts).toEqual([{ target: "main", ts: iso(4) }]);
		await waitFor(v, `ts(MAIN).unread === 0`);
		expect(await q<number>(v, `return window.__scrolls`)).toBe(0);
		await Bun.write(join(SHOTS, `fit-${width}.png`), await v.screenshot());
	}, 30_000);
});

test("content that keeps changing size does not hold the read back", async () => {
	reset([say(0, "어제 얻기"), say(1, "새 소식 하나"), say(2, "새 소식 둘")], iso(0));
	const v = await boot(1280, 900, false, true);
	await until(() => posts.length > 0);
	expect(posts).toEqual([{ target: "main", ts: iso(2) }]);
	await waitFor(v, `ts(MAIN).unread === 0`);
}, 30_000);

test("a long unread run is read only up to the last message whose bottom shows, and the rest as it comes on screen", async () => {
	const long = Array.from({ length: 40 }, (_, i) => say(i, `${i + 1}번째 메시지\n\n${"내용이 길어요. ".repeat(12)}`));
	reset(long, iso(4));
	const v = await boot(412, 915);
	await until(() => posts.length > 0);
	const seen = await lastVisible(v);
	expect(seen > iso(4) && seen < iso(39)).toBe(true);
	expect(posts.at(-1)).toEqual({ target: "main", ts: seen });
	// the badge counts only what is still below the view
	await waitFor(v, `ts(MAIN).unread === ${long.filter(e => e.ts > seen).length}`);
	await run(v, `timeline.scrollTop = timeline.scrollHeight`);
	await until(() => posts.at(-1)?.ts === iso(39));
	await waitFor(v, `ts(MAIN).unread === 0`);
}, 30_000);

test("a message arriving while the owner sits at the bottom is read at once", async () => {
	reset([say(0, "안녕하세요"), say(1, "네", true)], iso(1));
	const v = await boot(1280, 900);
	await waitFor(v, `chatStick`);
	const at = new Date().toISOString();
	emit("outbox", { kind: "out", ts: at, source: "orchestrator", channel: "web", text: "방금 온 답이에요" });
	await until(() => posts.some(x => x.ts === at));
	await waitFor(v, `ts(MAIN).unread === 0`);
}, 30_000);

test("a hidden page reads nothing; it reads once it shows", async () => {
	reset([say(0, "어제 얘기"), say(1, "새 소식 하나"), say(2, "새 소식 둘")], iso(0));
	const v = await boot(1280, 900, true);
	await waitFor(v, `ts(MAIN).unread === 2`);
	// the first paint and the frames after it are done, still hidden: nothing posted
	await v.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))`);
	expect(posts).toEqual([]);
	await run(v, `window.__vis = "visible"; document.dispatchEvent(new Event("visibilitychange"))`);
	await until(() => posts.length > 0);
	expect(posts.at(-1)).toEqual({ target: "main", ts: iso(2) });
	await waitFor(v, `ts(MAIN).unread === 0`);
}, 30_000);
