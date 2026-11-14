import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The comment pane of another computer (web/js/30-monitoring-comments.js CM.pc): its sources, posts and thread are read through /api/peer/proxy, its
// drafted replies and read marks map to one act for that computer (hub/peer-monitor.ts act "comments", web/js/34-peer-monitoring.js pqAct), and its draft
// is that computer's queue card, acted on through act "reply" (raAct). Headless; the other computer is a fixture.
const SHOTS = process.env.COMMENTS_PEER_SHOTS ?? join(tmpdir(), "comments-peer-shots");
mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const at = (h: number, m: number) => Date.UTC(2026, 9, 22, h, m);
const COMMENTS = [
	{ id: "cm:youtube:c1", parent: null, author: "가나", text: "자막은 언제 나와요?", at: at(1, 0), mine: false, needsReply: true },
	{ id: "cm:youtube:c3", parent: "c1", author: "나", text: "곧 올릴게요", at: at(2, 0), mine: true, needsReply: false },
];
const DRAFTS = [{ code: "D1", commentId: "cm:youtube:c1", text: "고마워요! 이번 주 안에 올릴게요.", notes: [], clean: true, created: at(3, 0) }];
const SENDS = [{ id: "send:cm:youtube:c3", commentId: "cm:youtube:c3", text: "곧 올릴게요", state: "failed", reason: "403 forbidden", at: at(2, 5) }];
const YT = { key: "youtube", app: "youtube", label: "유튜브", icon: "chat", kind: "app", unread: 1, notices: [], needs: { drafts: 1, unread: 1, sentToday: 0 } };
// The draft as an item of the other computer's reply queue (its snapshot's `reply` part).
const D1 = { item: "comment:D1", ref: "D1", kind: "comment", app: "youtube", label: "유튜브", conv: "i:youtube", at: at(3, 0), can: { send: true, revise: true, edit: false, drop: true, restore: false }, draft: { state: "pending", toLabel: "대상", to: "가나", text: DRAFTS[0]!.text } };
const snapshot = () => ({ name: "맥미니", rev: "r1", monitors: [], notices: [], integrations: [YT], available: [], conversations: [], reply: { items: [D1] } });

const acts: { action: string; args: Record<string, unknown> }[] = [];
const gets: string[] = [];
const localPosts: { path: string; body: unknown }[] = [];
const json = (v: unknown, status = 200) => Response.json(v, { status });
const peerGet = (p: string): Response | null => {
	if (p === "/api/comments/sources") return json({ on: true, sources: [{ key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, autoSend: false, error: null, ranAt: at(3, 0) }] });
	if (p === "/api/comments/threads?app=youtube") return json({ threads: [{ source: "youtube", thread: "v1", title: "첫 번째 영상", link: "https://video.example/v1", lastAt: at(2, 0), lastText: "곧 올릴게요", lastAuthor: "나", unread: 1, drafts: 1 }] });
	if (p === "/api/comments/thread/youtube/v1") return json({ source: { key: "youtube", kind: "youtube", label: "유튜브 댓글" }, thread: { id: "v1", title: "첫 번째 영상", link: "https://video.example/v1" }, comments: COMMENTS, read: 1, drafts: DRAFTS, sends: SENDS });
	return null;
};
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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 1 });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, { name: "맥미니", url: MINI, self: false, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 1, items: [] });
		if (p === "/api/integrations") return json({ items: [], available: [] });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitoring/peers") return json([{ name: "맥미니", url: MINI, online: true, stale: false, items: snapshot() }]);
		if (p === "/api/peer/proxy") {
			if (req.method === "POST") { acts.push((await req.json()) as (typeof acts)[number]); return json({ ok: true }); }
			const pp = url.searchParams.get("p") ?? "";
			gets.push(pp);
			return peerGet(pp) ?? json({});
		}
		if (req.method !== "GET") { localPosts.push({ path: p, body: await req.json().catch(() => null) }); return json({ ok: true }); }
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <R = unknown>(v: View, code: string): Promise<R> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as R;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const KEY = `p:${MINI}|i:youtube`;
const boot = async (width: number, height: number) => {
	gets.length = 0; localPosts.length = 0; acts.length = 0;
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh && PQ.loaded && monItems().some(i => i.key === ${JSON.stringify(KEY)})`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring", ${JSON.stringify(KEY)})`);
	await waitFor(v, `!$("#cm").hidden && CM.pc && CM.pc.url === ${JSON.stringify(MINI)} && CM.loaded && document.querySelector("#cm .kk-row")`);
	return v;
};

describe.each([[390, 844], [1280, 900]])("another computer's comment app at %ipx", (width, height) => {
	test("its sources, post and draft come through the proxy, and its draft card is the one queue card", async () => {
		const v = await boot(width, height);
		expect(gets).toContain("/api/comments/sources");
		expect(gets).toContain("/api/comments/threads?app=youtube");
		await run(v, `document.querySelector("#cm .kk-row").click()`);
		await waitFor(v, `CM.open && !CM.loading && document.querySelector("#cm .ra-card")`);
		const got = await q<{ text: string; acts: string[]; tabs: number; overflow: boolean }>(v, `
			const c = document.querySelector("#cm .ra-card"), txt = e => e ? e.textContent.trim() : "";
			return { text: txt(c.querySelector(".rq-text")), acts: [...c.querySelectorAll(".rq-acts button")].map(txt), tabs: document.querySelectorAll("#cm .cm-tabs").length, overflow: document.documentElement.scrollWidth > innerWidth };`);
		expect(got).toEqual({ text: "고마워요! 이번 주 안에 올릴게요.", acts: ["보내기", "고치기", "보내지 않기"], tabs: 0, overflow: false });
		await Bun.write(join(SHOTS, `comment-peer-${width}.png`), await v.screenshot());
	}, 20000);

	test("its draft's 보내기 is one reply act for that computer; its drafted replies and read marks one comments act; a failed reply has no buttons of its own", async () => {
		const v = await boot(width, height);
		await run(v, `document.querySelector("#cm .kk-row").click()`);
		await waitFor(v, `CM.open && !CM.loading && document.querySelector("#cm .ra-card")`);
		const got = await q<{ routes: string[][]; sends: number }>(v, `
			const r = (p, b = {}) => pqRoute(p, "POST", b);
			const cid = encodeURIComponent("cm:youtube:c1");
			return { routes: [r("/api/comments/comment/" + cid + "/draft"), r("/api/comments/thread/youtube/v1/read")], sends: document.querySelectorAll("#cm .kk-m.pend.failed button").length };`);
		expect(got.sends).toBe(0);
		expect(got.routes.every(r => /^\/api\/peer\/proxy\?pc=[^&]+&p=%2Fapi%2Fpeer%2Fact$/.test(r[0]!))).toBe(true);
		expect(got.routes.map(r => r[2])).toEqual([
			{ action: "comments", args: { op: "draft", commentId: "cm:youtube:c1" } },
			{ action: "comments", args: { op: "read", source: "youtube", thread: "v1" } },
		]);
		acts.length = 0;
		await run(v, `document.querySelector('#cm .ra-card [data-k="send"]').click()`);
		await waitFor(v, `!RA.busy.size`);
		expect(acts.filter(a => a.action === "reply")).toEqual([{ action: "reply", args: { ref: "D1", action: "send" } }]);
		expect(localPosts).toEqual([]);
	}, 20000);
});
