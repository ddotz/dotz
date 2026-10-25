import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { now } from "./config.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 홈 답변 필요: the send approvals of one monitoring app instance are one row ("메일 답장 확인 3건"); the count is of items, a lone approval stays a plain row,
// and an expanded group lists its items, each opening its own sheet. Neutral fixtures.
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
const SNAP = "/tmp/dotz-notice-group";

type Page = InstanceType<typeof Bun.WebView>;
const waitFor = (v: Page, expr: string) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), 10000); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
type Rows = { groups: { key: string; title: string; open: boolean; items: number }[]; plain: string[]; badge: string };
const rowsOf = async (v: Page): Promise<Rows> =>
	JSON.parse(String(await v.evaluate(`JSON.stringify({ groups: [...document.querySelectorAll("#home-now .ntg")].map(g => ({ key: g.dataset.group, title: g.querySelector(".nm").textContent, open: g.classList.contains("open"), items: g.querySelectorAll(".ntg-l .hr").length })), plain: [...document.querySelector("#home-now .hn").children].filter(r => r.classList.contains("hr")).map(r => r.querySelector(".nm").textContent), badge: document.querySelector("#home-now .hn-h .sup").textContent })`)));

async function open(width: number, height: number) {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && typeof INTG !== "undefined" && INTG.items.length === 3 && document.querySelector("#home-now .ntg")`);
	return v;
}

test("approvals of one app are one row with the item count; a lone approval stays a row; the badge counts items", async () => {
	const got = await rowsOf(await open(390, 900));
	expect(got.groups.map(g => [g.key, g.title, g.open, g.items])).toEqual([["mail", "메일 답장 확인 3건", false, 0], ["youtube", "유튜브 댓글 답글 2건", false, 0]]);
	expect(got.plain).toHaveLength(1);
	expect(got.badge).toBe("6");
});

test("a group unfolds to its items, each opening its own sheet, and shows in screenshots at 390 and 1280", async () => {
	mkdirSync(SNAP, { recursive: true });
	for (const [w, h] of [[390, 900], [1280, 900]] as const) {
		const v = await open(w, h);
		await v.evaluate(`(document.querySelector('#home-now .ntg[data-group="mail"] .ntg-h').click(), 0)`);
		await waitFor(v, `document.querySelectorAll('#home-now .ntg[data-group="mail"] .ntg-l .hr').length === 3`);
		const got = await rowsOf(v);
		expect(got.groups.find(g => g.key === "mail")).toMatchObject({ open: true, items: 3 });
		expect(got.groups.find(g => g.key === "youtube")).toMatchObject({ open: false, items: 0 });
		expect(got.badge).toBe("6");
		await Bun.write(`${SNAP}/grouped-${w}.png`, await v.screenshot());
		await v.evaluate(`(document.querySelector('#home-now .ntg[data-group="mail"] .ntg-l .hrx-m').click(), 0)`);
		await waitFor(v, `DK.node && DK.nid`);
		expect(String(await v.evaluate(`DK.nid`))).toMatch(/^m[123]$/);
	}
}, 30_000);
