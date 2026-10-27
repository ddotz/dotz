// A mail reply draft leaves 확인 대기 for good when it is answered 보내지 않기 or a newer draft of the same mail replaced it (owner 2026-10-27:
// "안보내기로 했으면 해당 카드 사라져야해"), and the same holds for a draft of the other computer's mail once its decision reaches this page.
// Nothing waiting is drawn under any filter, and the 확인 대기 count follows. Headless (Bun.WebView) against a fake hub.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { broadcast, sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.MAIL_GONE_SHOTS ?? "/tmp/dotz-mail-gone";
mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const json = (v: unknown) => Response.json(v);
const iso = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 27, h, m)).toISOString();

const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
type Dec = { id: string; to: string; at: string; subject: string; state: string; answer?: string };
const decisions: Dec[] = [];
const notice = (d: Dec) => ({ id: d.id, ts: d.at, updated: d.at, kind: "decision", tone: "ask", title: "이 답장 보낼까요?", text: "이 답장 보낼까요?", open: d.to, src: d.to, at: d.at, read: d.state !== "open", decision: { options: OPTS, to: d.to, reply_to: d.at, group: 1, state: d.state, ...(d.answer ? { answer: d.answer, answered_at: d.at } : {}), draft: { toLabel: "받는이", to: "Kim <kim@example.com>", subject: d.subject, body: "안녕하세요.\n\n보내 드립니다." } } });
// The hub's own count: one waiting draft per mail (the newest), exactly what 확인 대기 lists.
const waiting = () => { const newest = new Map<string, Dec>(); for (const d of decisions) if (d.state === "open" && (!newest.get(d.to) || d.at > newest.get(d.to)!.at)) newest.set(d.to, d); return newest.size; };
const mail = (key: string, subject: string, h: number) => ({ subject, from: "Kim <kim@example.com>", source: "kdb", at: iso(h), summary: `${subject} 요약이에요.`, reply: "draft", unreplied: true });
const app = (ids: string[], drafts: number) => ({ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: ids, unread: 0, unreplied: 1, needs: { drafts, unread: 0, sentToday: 0, unreplied: 1 } });
const localApp = () => app(decisions.map(d => d.id), waiting());
const ROWS = ["fx-a", "fx-b", "fx-c"].map((key, i) => ({ target: `mail:${key}`, unread: 0, read: iso(1), mail: mail(key, ["견적 요청", "일정 조율", "자료 요청"][i]!, 9 - i), last: { ts: iso(9 - i), text: "메일", from: "bot" } }));

let peerNote = { id: "peer-1", to: "mail:px-1", at: iso(5), subject: "Re: 견적 문의", state: "open" } as Dec;
const peerConv = { target: "mail:px-1", unread: 0, read: iso(5), mail: mail("px-1", "견적 문의", 5), last: { ts: iso(5), text: "견적 문의", from: "bot" } };
const peerView = () => ({ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: `p-${peerNote.state}`, monitors: [], available: [], notices: [notice(peerNote)], integrations: [app(["peer-1"], peerNote.state === "open" ? 1 : 0)], conversations: [peerConv] } });

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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: waiting() });
		if (p === "/api/notices") return json({ items: decisions.map(notice), unread: waiting() });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }]);
		if (p === "/api/monitoring/peers") return json([peerView()]);
		if (p === "/api/integrations") return json({ items: [localApp()], available: [] });
		if (p === "/api/conversations") return json({ items: ROWS });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [] });
		if (/^\/api\/notices\/[^/]+\/answer$/.test(p) && req.method === "POST") {
			const b = (await req.json()) as { n: number }, id = decodeURIComponent(p.split("/")[3]!);
			const d = decisions.find(x => x.id === id), o = d && OPTS.find(x => x.n === b.n);
			if (!d || !o) return json({ error: "unknown" }, 404);
			d.state = "answered";
			d.answer = `${o.n}) ${o.label}`;
			return json({ ok: true, item: notice(d), unread: waiting() });
		}
		if (p === "/api/peer/proxy") {
			if (req.method === "POST") return json({ ok: true, item: notice(peerNote), unread: 0 });
			return json({});
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const seen = (v: View) => q<{ chips: string[]; cards: string[] }>(v, `return {
	chips: [...document.querySelectorAll("#mon-tl .mr-f")].map(b => b.textContent),
	cards: [...document.querySelectorAll("#mon-tl .bm.dr")].map(c => c.querySelector(".dr-sub")?.textContent ?? "") }`);
const pick = async (v: View, f: string) => {
	await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="${f}"]').click()`);
	await waitFor(v, `document.querySelector('#mon-tl .mr-f.on').dataset.filter === ${JSON.stringify(f)}`);
};
async function boot(width: number, height: number, key: string): Promise<View> {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await waitFor(v, `typeof INTG !== "undefined" && INTG.items.length === 1 && PQ.loaded`);
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	await waitFor(v, `document.querySelector("#mon-tl .mr-f")`);
	return v;
}

const reset = () => {
	decisions.splice(0, decisions.length,
		{ id: "old-a", to: "mail:fx-a", at: iso(3), subject: "Re: 옛 초안", state: "open" },
		{ id: "new-a", to: "mail:fx-a", at: iso(4), subject: "Re: 고친 초안", state: "open" },
		{ id: "drop-b", to: "mail:fx-b", at: iso(2), subject: "Re: 일정 조율", state: "open" });
	peerNote = { id: "peer-1", to: "mail:px-1", at: iso(5), subject: "Re: 견적 문의", state: "open" };
};

describe.each([[390, 844], [1280, 900]] as const)("mail drafts at %ipx", (width, height) => {
	test("one card per mail: the older draft is stale; 보내지 않기 removes its card from every view and the count", async () => {
		reset();
		const v = await boot(width, height, "i:mail");
		await pick(v, "pending");
		await waitFor(v, `document.querySelectorAll("#mon-tl .bm.dr").length > 0`);
		const before = await seen(v);
		expect(before.chips).toEqual(["전체", "안 읽음", "답장 필요3", "확인 대기2", "답장함", "보낸 메일"]);
		expect(before.cards.sort()).toEqual(["Re: 고친 초안", "Re: 일정 조율"]);
		await Bun.write(join(SHOTS, `pending-before-${width}.png`), await v.screenshot());

		await run(v, `[...document.querySelectorAll("#mon-tl .bm.dr")].find(c => c.querySelector(".dr-sub").textContent === "Re: 일정 조율").querySelector(".dr-drop").click()`);
		await waitFor(v, `!document.querySelector('#mon-tl [data-nid="drop-b"]')`);
		expect((await seen(v)).cards).toEqual(["Re: 고친 초안"]);
		expect((await seen(v)).chips).toEqual(["전체", "안 읽음", "답장 필요3", "확인 대기1", "답장함", "보낸 메일"]);
		expect(await q<boolean>(v, `return document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
		await pick(v, "all");
		expect((await seen(v)).cards).toEqual([]);
		await Bun.write(join(SHOTS, `pending-after-${width}.png`), await v.screenshot());

		// the stale draft never comes back, whatever the view
		expect(await q<string[]>(v, `return [...document.querySelectorAll("#mon-tl .bm.dr")].filter(c => c.querySelector(".dr-sub")?.textContent === "Re: 옛 초안").length ? ["stale"] : []`)).toEqual([]);
	}, 30_000);
});

test("a peer's answered 보내지 않기 reaches this page: the card leaves 확인 대기 and 전체 without a reload", async () => {
	reset();
	peerNote = { ...peerNote, state: "open" };
	const v = await boot(390, 844, `p:${MINI}|i:mail`);
	await pick(v, "pending");
	await waitFor(v, `document.querySelector('#mon-tl [data-nid="peer-1"]')`);
	expect((await seen(v)).chips).toContain("확인 대기1");

	// the owner answered it on the other computer: its stream reports the change and the snapshot is read again
	peerNote = { ...peerNote, state: "answered", answer: "3) 보내지 않기" };
	broadcast({ ts: new Date().toISOString(), kind: "peer_counts", source: "gateway", url: MINI, name: "맥미니", online: true, unread: 0, need: 0 });
	await waitFor(v, `!document.querySelector('#mon-tl [data-nid="peer-1"]')`, 15_000);
	expect((await seen(v)).chips).toContain("확인 대기");
	expect((await seen(v)).chips).not.toContain("확인 대기1");
	await pick(v, "all");
	expect((await seen(v)).cards).toEqual([]);
	await Bun.write(join(SHOTS, "peer-after-390.png"), await v.screenshot());
}, 30_000);
