import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// Where a conversation sits after a jump, in a headless browser at 390px against a fixture conversation with tall images (their bytes are held
// back by the test, so they land late), code blocks and a "새 메시지" divider. The rule (web/js/31-conversations.js chatJump): a jump target
// (notice / toast / push / 답변 필요 / ?m=) is placed at a fixed place - its top just under the app bar, ntInset() - wins over the divider, and
// stays there while late content changes the layout, until the owner touches the timeline.
const ts = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, i)).toISOString();
const N = 70;
const IMG_AT = new Set([3, 7, 10, 14, 16, 22, 28, 40, 55, 60]);
const events = Array.from({ length: N }, (_, i) =>
	IMG_AT.has(i)
		? { ts: ts(i), kind: "message", source: "web", text: `사진 ${i}`, files: [{ path: `/fx/p${i}.png`, name: `p${i}.png` }] }
		: { ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: i % 3 === 0 ? `코드 ${i}\n\n\`\`\`ts\n${Array.from({ length: 9 }, (_, k) => `const line${k} = ${i} + ${k};`).join("\n")}\n\`\`\`` : `메시지 ${i}번이에요. 조금 길게 써서 한 줄을 넘기도록 합니다. 폰 화면 폭에서 줄바꿈이 생겨야 합니다.` },
	);
const svg = (n: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${200 + (n % 4) * 60}"><rect width="100%" height="100%" fill="#8ac"/></svg>`;

// per scenario knobs
let read = "";   // READ position of main ("" = never opened / nothing unread)
let unread = 0;
let holdImages = true;
let release = () => {};
let gate: Promise<void> = Promise.resolve();
let imageHits = 0;
const arm = () => { holdImages = true; gate = new Promise(r => { release = () => { holdImages = false; r(); }; }); };

const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 1 });
		if (url.pathname === "/api/history") {
			const t = url.searchParams.get("target");
			return json({ target: t, events: t === "main" ? events : [] });
		}
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") {
			const last = events[N - 1]!;
			return json({ items: [{ target: "main", last: { ts: last.ts, text: String(last.text), from: "bot" }, unread, read: read || null }] });
		}
		if (url.pathname === "/api/notices") return json({ unread: 1, items: [{ id: "n1", kind: "message", tone: "", src: "main", open: "main", at: jumpAt, title: "알림이에요", read: false }] });
		if (url.pathname === "/api/file") {
			imageHits++;
			if (holdImages) await gate;
			return new Response(svg(Number(/p(\d+)\.png/.exec(url.searchParams.get("path") ?? "")?.[1] ?? 0)), { headers: { "Content-Type": "image/svg+xml" } });
		}
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
let jumpAt = ts(12);

const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { release(); view.close(); server.stop(true); });
beforeEach(() => { arm(); imageHits = 0; });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
// Frames until every image has loaded and the scroll position held for 6 frames in a row.
const settle = () => view.evaluate(`new Promise(res => { let last = -1, same = 0; const tick = () => { const st = timeline.scrollTop, done = [...document.images].every(i => i.complete); same = done && st === last ? same + 1 : 0; last = st; if (same >= 6) res(true); else requestAnimationFrame(tick); }; tick(); })`);
const stable = () => view.evaluate(`new Promise(res => { let last = -1, same = 0; const tick = () => { const st = timeline.scrollTop; same = st === last ? same + 1 : 0; last = st; if (same >= 6) res(true); else requestAnimationFrame(tick); }; tick(); })`);
// the jump has finished when its message is highlighted (ntFlash) and the view holds still
const landed = async () => { await waitFor(`tl.querySelector(".nt-hl")`); await stable(); };
type M = { off: number; inset: number; divOff: number | null; stick: boolean; top: number };
const measure = async (at: string): Promise<M> => JSON.parse((await view.evaluate(`JSON.stringify((() => {
	const n = [...tl.querySelectorAll("[data-ts]")].find(m => m.dataset.ts === ${JSON.stringify(at)}), a = timeline.getBoundingClientRect(), bar = $("#appbar").getBoundingClientRect();
	return { off: n ? Math.round(n.getBoundingClientRect().top - a.top) : -9999, inset: Math.round(Math.max(0, bar.bottom - a.top) + 20), divOff: CV.divNode ? Math.round(CV.divNode.getBoundingClientRect().top - a.top) : null, stick: chatStick, top: Math.round(timeline.scrollTop) };
})())`)) as string);
const boot = async () => {
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && NT.items.length === 1 && S`);
};
const tap = () => view.evaluate(`(noticeOpen(NT.items[0]), 0)`);
const near = (m: M) => Math.abs(m.off - m.inset);

describe("jump from a notice at 390px", () => {
	test("with an unread divider: the target (above it) sits at the fixed place, before and after the images land", async () => {
		read = ts(30); unread = 39; jumpAt = ts(12);
		await boot();
		await tap();
		await landed();
		const early = await measure(jumpAt);
		expect(near(early)).toBeLessThanOrEqual(2);
		release();
		await settle();
		const late = await measure(jumpAt);
		expect(imageHits).toBeGreaterThan(0);
		expect(near(late)).toBeLessThanOrEqual(2);
	});

	test("with an unread divider: a target below the divider sits at the same place", async () => {
		read = ts(30); unread = 39; jumpAt = ts(50);
		await boot();
		await tap();
		await landed();
		release();
		await settle();
		expect(near(await measure(jumpAt))).toBeLessThanOrEqual(2);
	});

	test("without a divider (nothing unread): the target sits at the same place", async () => {
		read = ts(N - 1); unread = 0; jumpAt = ts(20);
		await boot();
		await tap();
		await landed();
		release();
		await settle();
		const m = await measure(jumpAt);
		expect(m.divOff).toBeNull();
		expect(near(m)).toBeLessThanOrEqual(2);
	});

	test("the conversation is already open at its divider: the jump still wins", async () => {
		read = ts(30); unread = 39; jumpAt = ts(8);
		await boot();
		await view.evaluate(`(go("chat", "main"), 0)`);
		await waitFor(`CV.placed && CV.divNode`);
		await tap();
		await landed();
		release();
		await settle();
		const m = await measure(jumpAt);
		expect(m.divOff).not.toBeNull();
		expect(near(m)).toBeLessThanOrEqual(2);
	});

	test("a live message arriving after the jump does not move the target", async () => {
		read = ts(N - 1); unread = 0; jumpAt = ts(N - 12);
		await boot();
		await tap();
		await landed();
		release();
		await settle();
		await view.evaluate(`(ingestMsg({ ts: new Date(Date.UTC(2026, 9, 20, 5, 0)).toISOString(), kind: "out", source: "orchestrator", target: "main", text: "새로 온 메시지예요" }), 0)`);
		await settle();
		expect(near(await measure(jumpAt))).toBeLessThanOrEqual(2);
	});

	test("opening a conversation without a jump still lands on the divider", async () => {
		read = ts(30); unread = 39;
		await boot();
		await view.evaluate(`(go("chat", "main"), 0)`);
		await waitFor(`CV.placed && CV.divNode`);
		release();
		await settle();
		const m = await measure(ts(0));
		expect(m.divOff).not.toBeNull();
		expect(m.divOff!).toBeGreaterThanOrEqual(0);
		expect(m.divOff!).toBeLessThanOrEqual(60);
	});
});
