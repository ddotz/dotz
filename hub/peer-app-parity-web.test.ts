import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// An app opened from the other computer looks and works exactly like the same app opened on its own computer (owner 2026-10-27): the mail app's
// reply-draft approval card and the KakaoTalk pane are drawn once as this computer's items and once as the Mac mini's, from the same data, and
// compared; only the machine chip may differ. A peer's card answers on the Mac mini (/api/peer/act), once. Headless; both computers are fixtures.
const SHOTS = process.env.PARITY_SHOTS ?? "/tmp/parity-shots";
mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const now = new Date(Date.now() - 5 * 60_000).toISOString();
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const Q = "이 답장 보낼까요?";
const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
const DRAFT = { toLabel: "받는이", to: "Kim <kim@example.com>", subject: "Re: 견적 요청", body: "안녕하세요.\n\n견적서를 보내 드려요.\n\n감사합니다." };
const LOCAL_T = "mail:kdb-local", PEER_T = "mail:kdb-peer";
const draft = (id: string, t: string, state = "open", extra: object = {}) => ({ id, ts: now, updated: now, kind: "decision", tone: "ask", title: `${Q} (RSE5J5F)`, text: `[ask] 답장 초안을 만들었어요.\n\n> 받는이: Kim <kim@example.com>\n> 제목: Re: 견적 요청\n\n${Q}`, open: t, src: t, at: now, read: false,
	decision: { options: OPTS, to: t, reply_to: now, group: 1, state, draft: DRAFT, ...extra } });
const mail = (key: string) => ({ key, subject: "견적 요청", from: "Kim <kim@example.com>", source: "kdb", at: now, summary: "다음 주까지 견적을 받고 싶어요.", reply: "draft", unreplied: true });
const conv = (t: string) => ({ target: t, mail: mail(t.slice(5)), last: { ts: now, text: "견적 요청 메일", via: "kdb" }, unread: 0 });
const KAKAO_W = { name: "kakao 새 소식", watch: "kakao-new", kind: "watch", last_run: now, last_result: "ok", next_run: later(1), every: "1분마다", last_ok: now, fails: 0 };
const app = (key: string, label: string, icon: string, notices: string[], extra: object = {}) => ({ key, label, icon, kind: "app", unread: 0, notices, needs: { drafts: notices.length, unread: 0, sentToday: 0 }, ...extra });
const MAIL_APP = (id: string) => app("mail", "메일", "mail", [id], { conv: ["mail:"] });
const KAKAO_APP = app("kakao", "카카오톡", "chat", [], { conv: [], own: ["kakao-new"] });
const ROOMS = { on: true, rooms: [{ chatId: "100", name: "가나다 모임", kind: "group", watched: true, autoDraft: false, unread: 0, lastAt: Date.parse(now) }] };
const ROOM = { room: { chatId: "100", name: "가나다 모임", kind: "group", group: true, watched: true }, messages: [{ logId: "1", authorId: "u1", sender: "가나", text: "안녕하세요", type: 1, sentAt: Date.parse(now), fromMe: false, unread: 0 }], read: "1", kakaoUnread: 0, drafts: [], sends: [] };
const labelField = { key: "label", label: "앱 이름", type: "text", help: "", max: 30, switch: true, value: "카카오톡" };

let peerNote = draft("dp", PEER_T);
const acts: { action: string; args: Record<string, unknown> }[] = [];
const localPosts: { path: string; body: unknown }[] = [];
const snapshot = () => ({ name: "맥미니", rev: "r1", monitors: [KAKAO_W], notices: [peerNote], integrations: [MAIL_APP("dp"), KAKAO_APP], available: [], conversations: [conv(PEER_T)] });
const json = (v: unknown, status = 200) => Response.json(v, { status });
// The same app routes on both computers: a peer's are reached through /api/peer/proxy.
function appGet(p: string): Response | null {
	if (p === "/api/kakao/rooms") return json(ROOMS);
	if (p.startsWith("/api/kakao/chat/100/head")) return json({ logId: "1" });
	if (p.startsWith("/api/kakao/chat/100/reads")) return json({ counts: {} });
	if (p.startsWith("/api/kakao/chat/100")) return json(ROOM);
	if (/^\/api\/integrations\/(kakao|mail)\/settings$/.test(p)) return json({ key: "kakao", fields: [labelField] });
	if (p.startsWith("/api/history")) return json({ target: new URL(p, MINI).searchParams.get("target"), events: [] });
	return null;
}
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
		if (p === "/api/monitors") return json({ items: [KAKAO_W] });
		if (p === "/api/notices") return json({ unread: 1, items: [draft("dl", LOCAL_T)] });
		if (p === "/api/integrations") return json({ items: [MAIL_APP("dl"), KAKAO_APP] });
		if (p === "/api/conversations") return json({ items: [conv(LOCAL_T)] });
		if (p === "/api/monitoring/peers") return json([{ name: "맥미니", url: MINI, online: true, stale: false, items: snapshot() }]);
		if (p === "/api/peer/proxy") {
			const pp = url.searchParams.get("p") ?? "";
			if (req.method === "POST") {
				const a = (await req.json()) as (typeof acts)[number];
				acts.push(a);
				if (a.action === "answer") { peerNote = draft("dp", PEER_T, "answered", { answer: "1) 보내기", answered_at: now }); return json({ ok: true, item: peerNote, unread: 0 }); }
				return json({ ok: true });
			}
			return appGet(pp) ?? json({});
		}
		if (req.method === "POST") { localPosts.push({ path: p, body: await req.json().catch(() => null) }); return json({ ok: true }); }
		return appGet(`${p}${url.search}`) ?? (p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 }));
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const KEYS = { mail: { local: "i:mail", peer: `p:${MINI}|i:mail` }, kakao: { local: "i:kakao", peer: `p:${MINI}|i:kakao` } };
const boot = async (width: number, height: number, key: string, ready: string) => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && PQ.list.length && monItems().some(i => i.key === ${JSON.stringify(key)})`);
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	await waitFor(v, ready);
	return v;
};
// The machine chip (.mon-pc, a tag naming 맥미니) is the one allowed difference; ids and keys differ by construction.
const NORMALIZE = `
const clean = n => {
	const c = n.cloneNode(true);
	for (const x of c.querySelectorAll(".mon-pc")) x.remove();
	for (const x of c.querySelectorAll(".tag")) if (x.textContent === "맥미니") x.remove();
	for (const x of [c, ...c.querySelectorAll("*")]) for (const a of [...x.attributes]) if (/^(data-k|data-t|data-nid|data-as-open|data-as-more|data-sig|data-watch|id|aria-labelledby)$/.test(a.name)) x.removeAttribute(a.name);
	return c.outerHTML;
};`;
const DRAFT_READY = `document.querySelector("#mon-tl .bm.dr .dr-send")`;
const KAKAO_READY = `document.querySelector("#kk-rooms .kk-own .as-stat") && document.querySelector("#kk-rooms .kk-watch .kk-row")`;

describe.each([[390, 844], [1280, 900]])("the same app on this computer and on the Mac mini at %ipx", (width, height) => {
	test("the mail reply-draft card is the same structured card with the same buttons", async () => {
		const parts = async (v: View) => q<{ card: string; buttons: string[]; orig: boolean; chip: string }>(v, `${NORMALIZE}
			const c = document.querySelector("#mon-tl .bm.dr");
			return { card: clean(c), buttons: [...c.querySelectorAll("button")].map(b => b.textContent.trim()), orig: !!c.querySelector(".dr-orig"), chip: c.querySelector(".dr-chip").textContent };`);
		const lv = await boot(width, height, KEYS.mail.local, DRAFT_READY);
		const local = await parts(lv);
		await Bun.write(join(SHOTS, `local-mail-draft-${width}.png`), await lv.screenshot());
		const pv = await boot(width, height, KEYS.mail.peer, DRAFT_READY);
		const peer = await parts(pv);
		await Bun.write(join(SHOTS, `peer-mail-draft-${width}.png`), await pv.screenshot());
		expect(local.buttons).toEqual(["보내기", "고치기", "보내지 않기"]);
		expect(local.orig).toBe(true);
		expect(peer).toEqual(local);
		expect(await q(pv, `return document.querySelector("#mon-tl").textContent.includes("RSE5J5F")`)).toBe(false);
		expect(await q<number>(pv, `return document.documentElement.scrollWidth`)).toBeLessThanOrEqual(width);
	});

	test("the KakaoTalk pane starts with the watch status row on both computers, and the open room has the same head", async () => {
		const parts = (v: View) => q<{ rooms: string; stat: string }>(v, `${NORMALIZE}
			return { rooms: clean(document.querySelector("#kk-rooms")), stat: document.querySelector("#kk-rooms > .kk-own .as-stat").textContent };`);
		const lv = await boot(width, height, KEYS.kakao.local, KAKAO_READY);
		const local = await parts(lv);
		await Bun.write(join(SHOTS, `local-kakao-${width}.png`), await lv.screenshot());
		const pv = await boot(width, height, KEYS.kakao.peer, KAKAO_READY);
		const peer = await parts(pv);
		await Bun.write(join(SHOTS, `peer-kakao-${width}.png`), await pv.screenshot());
		expect(local.stat).toContain("kakao 새 소식");
		expect(local.stat).toContain("마지막 정상");
		expect(peer).toEqual(local);
		const head = async (v: View) => {
			await run(v, `kkOpen("100")`);
			await waitFor(v, `document.querySelector("#kk-head .cv-n") && document.querySelector("#kk-head .as-hd")`);
			return q<string>(v, `${NORMALIZE} return clean(document.querySelector("#kk-head"))`);
		};
		expect(await head(pv)).toBe(await head(lv));
	});
});

test("a peer's draft card answers on the Mac mini once and turns to 보냄; nothing is posted to this computer", async () => {
	const v = await boot(1280, 900, KEYS.mail.peer, DRAFT_READY);
	acts.length = 0; localPosts.length = 0;
	await run(v, `document.querySelector("#mon-tl .bm.dr .dr-send").click()`);
	await waitFor(v, `document.querySelector('#mon-tl .bm.dr .dr-st[data-state="send"]')`);
	expect(acts).toEqual([{ action: "answer", args: { id: "dp", n: 1 } }]);
	expect(localPosts.filter(x => x.path.startsWith("/api/notices"))).toEqual([]);
	expect(await q(v, `return document.querySelectorAll("#mon-tl .bm.dr .dr-send").length`)).toBe(0);
});
