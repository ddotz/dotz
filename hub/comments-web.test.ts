import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// 모니터링 > 앱 > 유튜브 (web/js/30-monitoring-comments.js): the app entry's status line, the posts as conversations, the one reply card with
// 보내기 / 고치기 / 보내지 않기, a failed reply's 다시 보내기 / 지우기, run as shipped in a headless browser (Bun.WebView) against a stubbed
// /api/comments/* (docs/comments-api.md).
// Names and texts are placeholders. Screenshots are written only when COMMENTS_SHOTS names a folder.
const SHOTS = process.env.COMMENTS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

type Req = { method: string; path: string; body: Record<string, unknown> | null };
const at = (d: number, h: number, m: number) => Date.UTC(2026, 9, d, h, m);
const COMMENTS = [
	{ id: "cm:youtube:c1", parent: null, author: "가나", text: "영상 잘 봤어요! 자막은 언제 나와요?", at: at(22, 1, 0), mine: false, needsReply: true },
	{ id: "cm:youtube:c2", parent: null, author: "다라", text: "<b>굵게</b> & <img src=x onerror=alert(1)> 그대로 보여야 해요", at: at(22, 1, 30), mine: false, needsReply: true },
	{ id: "cm:youtube:c3", parent: "c1", author: "나", text: "다음 주에 올릴게요", at: at(22, 2, 0), mine: true, needsReply: false },
];
let drafts: { code: string; commentId: string; text: string; notes: string[]; clean: boolean; created: number }[] = [];
let sends: { id: string; commentId: string; text: string; state: string; reason?: string; at: number }[] = [];
let reqs: Req[] = [];
let waiters: { pred: (r: Req) => boolean; res: (r: Req) => void }[] = [];
const reset = () => { drafts = [{ code: "Dabc234", commentId: "cm:youtube:c1", text: "고마워요! 자막은 이번 주 안에 올릴게요.", notes: [], clean: true, created: at(22, 3, 0) }]; sends = []; reqs = []; waiters = []; };
const record = (r: Req) => { reqs.push(r); waiters = waiters.filter(w => (w.pred(r) ? (w.res(r), false) : true)); };
const expectReq = (pred: (r: Req) => boolean, ms = 3500): Promise<Req> => {
	const have = reqs.find(pred);
	if (have) return Promise.resolve(have);
	return new Promise((res, rej) => {
		const t = setTimeout(() => rej(new Error(`no matching request; got ${JSON.stringify(reqs.map(r => `${r.method} ${r.path}`))}`)), ms);
		waiters.push({ pred, res: r => { clearTimeout(t); res(r); } });
	});
};

const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let streamWaiters: (() => void)[] = [];
const te = new TextEncoder();
const streamOpen = () => new Promise<void>(r => streamWaiters.push(r));
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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/integrations") return json({ items: [{ key: "youtube", label: "유튜브", icon: "youtube", kind: "app", conv: [], notices: [], unread: 2, needs: { drafts: drafts.length, unread: 2, sentToday: 0 } }] });
		if (p === "/api/comments/sources") return json({ on: true, sources: [{ key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, autoSend: false, error: null, ranAt: at(22, 3, 0) }] });
		if (p === "/api/comments/threads") return json({ threads: [{ source: "youtube", thread: "v1", title: "첫 번째 영상", link: "https://video.example/v1", lastAt: at(22, 2, 0), lastText: "다음 주에 올릴게요", lastAuthor: "나", unread: 2, drafts: drafts.length }] });
		const body = req.method === "GET" ? null : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
		if (p === "/api/comments/thread/youtube/v1" && req.method === "GET")
			return json({ source: { key: "youtube", kind: "youtube", label: "유튜브 댓글" }, thread: { id: "v1", title: "첫 번째 영상", link: "https://video.example/v1" }, comments: COMMENTS, read: null, drafts, sends });
		if (p === "/api/comments/thread/youtube/v1/read") { record({ method: "POST", path: p, body }); return json({ ok: true }); }
		const sf = /^\/api\/comments\/sends\/([^/]+)\/(retry|dismiss)$/.exec(p);
		if (sf && req.method === "POST") {
			record({ method: "POST", path: p, body });
			const id = decodeURIComponent(sf[1]!);
			if (sf[2] === "retry") { sends = sends.map(s => (s.id === id ? { ...s, state: "sent", reason: undefined } : s)); return json({ id, state: "sending" }, 202); }
			sends = sends.filter(s => s.id !== id);
			return json({ ok: true });
		}
		const d = /^\/api\/comments\/drafts\/(\w+)\/(send|drop|revise)$/.exec(p);
		if (d && req.method === "POST") {
			record({ method: "POST", path: p, body });
			if (d[2] === "send") { sends = [{ id: "send:cm:youtube:c1", commentId: "cm:youtube:c1", text: drafts[0]!.text, state: "sent", at: Date.now() }]; drafts = []; return json({ id: "send:cm:youtube:c1", state: "sending" }, 202); }
			if (d[2] === "drop") { drafts = []; return json({ ok: true }); }
			drafts = [{ ...drafts[0]!, code: "Dnew999", text: "짧게 답할게요." }];
			return json({ ok: true, code: "Dnew999" });
		}
		return new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = (width: number, height: number): View => { const v = new Bun.WebView({ width, height }); views.push(v); return v; };
afterAll(() => { for (const v of views) v.close(); for (const c of streams) { try { c.close(); } catch { /* already closed */ } } server.stop(true); });
beforeEach(reset);

const waitFor = (v: View, expr: string, ms = 3500) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const boot = async (v: View) => {
	const opened = streamOpen();
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await waitFor(v, `typeof CM !== "undefined" && CM.apps.has("youtube")`);
	await run(v, `go("monitoring", "i:youtube")`);
	await waitFor(v, `!$("#cm").hidden && CM.loaded && document.querySelector("#cm .kk-row")`);
};

describe("댓글 on a phone (390x844)", () => {
	const v = open(390, 844);

	test("the app entry says what waits, the post is a conversation, and the draft sends once", async () => {
		await boot(v);
		const row = await q<{ name: string; badge: string }>(v, `const r = document.querySelector("#cm .kk-row"); return { name: r.querySelector(".cv-n").textContent, badge: r.querySelector(".nb").textContent }`);
		expect(row).toEqual({ name: "첫 번째 영상", badge: "초안 1" });
		await shot(v, "comments-list-390.png");

		await run(v, `document.querySelector("#cm .kk-row").click()`);
		await waitFor(v, `CM.open && !CM.loading && document.querySelector("#cm .kk-draft")`);
		const s = await q<{ names: string[]; texts: string[]; bubbles: number; xss: boolean; draft: string; buttons: string[]; overflow: boolean }>(v, `
			const ts = [...document.querySelectorAll("#cm .kk-bub")].map(b => b.textContent);
			return { names: [...document.querySelectorAll("#cm .kk-name")].map(n => n.textContent), texts: ts, bubbles: ts.length, xss: !!document.querySelector("#cm .kk-bub img, #cm .kk-bub b"),
				draft: document.querySelector("#cm .kk-dt").textContent, buttons: [...document.querySelectorAll("#cm .kk-draft .btn")].map(b => b.textContent), overflow: document.documentElement.scrollWidth > 390 }`);
		expect(s.names).toEqual(["가나", "다라"]);
		expect(s.bubbles).toBe(3);
		expect(s.texts[1]).toContain("<b>굵게</b>");
		expect(s.xss).toBe(false);
		expect(s.draft).toBe("고마워요! 자막은 이번 주 안에 올릴게요.");
		expect(s.buttons).toEqual(["보내기", "고치기", "보내지 않기"]);   // the one reply card's words (10-reply-card.js)
		expect(s.overflow).toBe(false);
		await shot(v, "comments-thread-390.png");

		await run(v, `document.querySelector('#cm [data-k="send"]').click(); document.querySelector('#cm [data-k="send"]').click()`);
		await expectReq(r => r.path === "/api/comments/drafts/Dabc234/send");
		await waitFor(v, `!document.querySelector("#cm .kk-draft") && document.querySelector("#cm .kk-m.me.pend.sent")`);
		expect(reqs.filter(r => r.path.endsWith("/send"))).toHaveLength(1);
		await shot(v, "comments-sent-390.png");
	});

	test("고치기 asks what to change and shows the rewritten draft; 보내지 않기 removes it", async () => {
		await boot(v);
		await run(v, `document.querySelector("#cm .kk-row").click()`);
		await waitFor(v, `CM.open && !CM.loading && document.querySelector("#cm .kk-draft")`);
		await run(v, `document.querySelector('#cm [data-k="edit"]').click()`);
		await waitFor(v, `document.querySelector('#cm [data-k="revise-go"]')`);
		await run(v, `const i = document.querySelector("#cm .rq-edit input"); i.value = "더 짧게"; i.dispatchEvent(new Event("input")); document.querySelector('#cm [data-k="revise-go"]').click()`);
		const req = await expectReq(r => r.path === "/api/comments/drafts/Dabc234/revise");
		expect(req.body).toEqual({ change: "더 짧게" });
		await waitFor(v, `document.querySelector("#cm .kk-dt") && document.querySelector("#cm .kk-dt").textContent === "짧게 답할게요."`);
		await run(v, `document.querySelector('#cm [data-k="drop"]').click()`);
		await expectReq(r => r.path === "/api/comments/drafts/Dnew999/drop");
		await waitFor(v, `!document.querySelector("#cm .kk-draft")`);
	});

	test("a reply that did not go out offers 다시 보내기 and 지우기, and each posts once", async () => {
		sends = [{ id: "send:cm:youtube:c2", commentId: "cm:youtube:c2", text: "곧 올릴게요", state: "failed", reason: "403 forbidden", at: at(22, 4, 0) }];
		const v = open(390, 844);
		await boot(v);
		await run(v, `document.querySelector("#cm .kk-row").click()`);
		await waitFor(v, `CM.view && CM.view.sends.length && document.querySelector('#cm [data-k="retry"]')`);
		const got = await q<{ state: string; buttons: string[] }>(v, `const s = document.querySelector("#cm .kk-m.pend.failed"); return { state: s.querySelector(".kk-state").textContent, buttons: [...s.querySelectorAll("button")].map(b => b.textContent) }`);
		expect(got.state).toBe("실패 · 403 forbidden");
		expect(got.buttons).toEqual(["다시 보내기", "지우기"]);
		await run(v, `document.querySelector('#cm [data-k="retry"]').click()`);
		await expectReq(r => r.path === "/api/comments/sends/send%3Acm%3Ayoutube%3Ac2/retry");
		await waitFor(v, `!document.querySelector("#cm [data-k=\\"retry\\"]")`);
		expect(reqs.filter(r => r.path.endsWith("/retry"))).toHaveLength(1);
		sends = [{ id: "send:cm:youtube:c2", commentId: "cm:youtube:c2", text: "곧 올릴게요", state: "failed", reason: "timeout", at: at(22, 4, 0) }];
		await run(v, `CM.view.sends = [{ id: "send:cm:youtube:c2", commentId: "cm:youtube:c2", text: "곧 올릴게요", state: "failed", reason: "timeout", at: ${at(22, 4, 0)} }]; cmPaintChat(false)`);
		await waitFor(v, `document.querySelector('#cm [data-k="dismiss"]')`);
		await run(v, `document.querySelector('#cm [data-k="dismiss"]').click()`);
		await expectReq(r => r.path === "/api/comments/sends/send%3Acm%3Ayoutube%3Ac2/dismiss");
		await waitFor(v, `!document.querySelector("#cm .kk-m.pend.failed")`);
		expect(reqs.filter(r => r.path.endsWith("/dismiss"))).toHaveLength(1);
		await shot(v, "comments-send-failed-390.png");
	});

	test("the app list row carries the status line", async () => {
		await boot(v);
		await run(v, `go("monitoring", "list")`);
		await waitFor(v, `document.querySelector("#mon-side") && document.querySelector("#mon-side").textContent.includes("답장 확인 1건 · 안 읽음 2")`);
	});
});
