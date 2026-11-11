import { afterAll, expect, test } from "bun:test";
import { now } from "./config.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 홈 답변 필요: the send approvals of every app are no rows of it; one 답장 대기 row (30-replies.js rqWaiting) counts them all and opens the 답장 대기 screen. Neutral fixtures.
const at = (minutesAgo: number) => new Date(Date.parse(now()) - minutesAgo * 60_000).toISOString();
const OPTIONS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기 …", desc: "", rec: false }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
const draft = (id: string, to: string, who: string, minutesAgo: number) => ({
	id, ts: at(minutesAgo), updated: at(minutesAgo), at: at(minutesAgo), kind: "decision", tone: "ask", title: "이 답장 보낼까요?", text: `> 받는이: ${who}\n>\n> 샘플 답장입니다`,
	open: to, src: to, read: false,
	decision: { options: OPTIONS, to, reply_to: at(minutesAgo), group: 1, state: "open", draft: { toLabel: "받는이", to: who, subject: "Re: 샘플", body: "샘플 답장입니다", ref: id } },
});
const NOTICES = [
	draft("m1", "mail:sample-1", "가나 <a@example.com>", 5),
	draft("m2", "mail:sample-2", "다라 <b@example.com>", 6),
	draft("m3", "mail:sample-3", "마바 <c@example.com>", 7),
	draft("y1", "main", "사샘플 댓글", 8),
	draft("y2", "main", "아샘플 댓글", 9),
	draft("k1", "main", "샘플 대화방", 10),
];
const app = (key: string, label: string, icon: string, notices: string[]) => ({ key, app: key, label, kind: "app", icon, conv: [], unread: notices.length, unreplied: 0, notices, needs: { drafts: notices.length, unread: 0, sentToday: 0, unreplied: 0 } });
const INTEGRATIONS = [app("mail", "메일", "mail", ["m1", "m2", "m3"]), app("youtube", "유튜브", "youtube", ["y1", "y2"]), app("kakao", "카카오톡", "kakao", ["k1"])];

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
		if (url.pathname === "/api/events") return new Response(new ReadableStream({}), { headers: { "content-type": "text/event-stream" } });
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: NOTICES.length });
		if (url.pathname === "/api/notices") return json({ items: NOTICES, unread: NOTICES.length });
		if (url.pathname === "/api/integrations") return json({ items: INTEGRATIONS, available: [] });
		if (url.pathname === "/api/monitors") return json({ items: [] });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

type Page = InstanceType<typeof Bun.WebView>;
const waitFor = (v: Page, expr: string) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), 10000); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T>(v: Page, code: string): Promise<T> => JSON.parse(String(await v.evaluate(`JSON.stringify((() => { ${code} })())`))) as T;

async function open(width: number, height: number) {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && typeof INTG !== "undefined" && INTG.items.length === 3 && document.querySelector('#home-now .hr[data-k="replies"]')`);
	return v;
}

test("the send approvals of every app are no 답변 필요 rows or groups; one 답장 초안 확인 row counts the items, and the nav badge is the same number", async () => {
	const v = await open(390, 900);
	const got = await q<{ groups: number; draftRows: number; row: string; rows: number; badge: string; waiting: number }>(v, `const box = document.querySelector("#home-now");
		return { groups: box.querySelectorAll(".ntg").length, draftRows: [...box.querySelectorAll(".hr")].filter(r => r.dataset.nid).length, row: box.querySelector('.hr[data-k="replies"] .nb').textContent, rows: box.querySelectorAll('.hr[data-k="replies"]').length,
			badge: document.querySelector("#nav-mon").textContent, waiting: rqWaiting() };`);
	expect(got.groups).toBe(0);
	expect(got.draftRows).toBe(0);
	expect(got.rows).toBe(1);
	expect(got.row).toBe("6");   // the total is the badge at the row's right
	expect(got.waiting).toBe(6);
	expect(got.badge).toBe("6");
});

test("the 답장 대기 row opens the 답장 대기 screen, which lists all six items", async () => {
	for (const [w, h] of [[390, 900], [1280, 900]] as const) {
		const v = await open(w, h);
		await v.evaluate(`(document.querySelector('#home-now .hr[data-k="replies"]').click(), 0)`);
		await waitFor(v, `current === "monitoring" && MON.sel === "replies" && document.querySelectorAll("#mon-tl .rq-r").length === 6`);
	}
}, 30_000);
