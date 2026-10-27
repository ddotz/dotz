// The mail list's 확인 대기 filter: a reply draft waiting on the owner (the send-approval card) shows only there, with its count on the chip,
// for this computer's mail and a peer's alike; 전체 / 답장함 and the other views show the mails without it. Headless (Bun.WebView) against a fake hub.
// Screenshots go to MAIL_PENDING_SHOTS (default /tmp/dotz-mail-pending): 390x844 and 1280x900, under 전체 and 확인 대기.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.MAIL_PENDING_SHOTS ?? "/tmp/dotz-mail-pending";
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown) => Response.json(v);
const iso = (h: number) => new Date(Date.UTC(2026, 9, 27, h, 0)).toISOString();
const MAIL = { key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: ["open-1", "open-2", "sent-1"], unread: 0, unreplied: 1, needs: { drafts: 2, unread: 0, sentToday: 1, unreplied: 1 } };
const card = (subject: string, from: string, h: number, extra: Record<string, unknown> = {}) => ({ subject, from, source: "mail", at: iso(h), summary: `${subject} 요약이에요.`, ...extra });
const ROWS = [
	{ id: "a", h: 2, card: card("자료 요청", "Park <park@example.com>", 2, { reply: "draft", unreplied: true, suggest: { kind: "reply-draft", label: "답장 초안", ref: "d1" } }) },
	{ id: "b", h: 1, card: card("회의 일정 문의", "Kim <kim@example.com>", 1, { reply: "draft", unreplied: true }) },
	{ id: "c", h: 0, card: card("일정 조율", "Han <han@example.com>", 0, { reply: "replied", sentAt: iso(0) }) },
];
const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
const draft = (id: string, t: string, h: number, subject: string, state = "open", extra: object = {}) => ({
	id, ts: iso(h), updated: iso(h), kind: "decision", tone: "ask", title: "이 답장 보낼까요?", text: "이 답장 보낼까요?", open: t, src: t, at: iso(h), read: false,
	decision: { options: OPTS, to: t, reply_to: iso(h), group: 1, state, draft: { toLabel: "받는이", to: "Park <park@example.com>", subject, body: "안녕하세요.\n\n자료 보내 드립니다.\n\n감사합니다." }, ...extra },
});
const NOTES = [
	draft("open-1", "mail:fx-a", 3, "Re: 자료 요청"),
	draft("open-2", "mail:fx-b", 4, "Re: 회의 일정 문의"),
	draft("sent-1", "mail:fx-c", 1, "Re: 일정 조율", "answered", { answer: "1) 보내기", answered_at: iso(1) }),
];
// another computer's mail app with one pending draft of its own
const PEER_T = "mail:px-1";
const peers = (port: number) => [{ name: "맥미니", url: `http://127.0.0.1:${port}/mini`, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: [], available: [],
	notices: [draft("peer-1", PEER_T, 5, "Re: 견적 요청")], integrations: [{ ...MAIL, notices: ["peer-1"] }],
	conversations: [{ target: PEER_T, mail: card("견적 요청", "Lee <lee@example.com>", 5, { reply: "draft", unreplied: true }), last: { ts: iso(5), text: "견적 요청", from: "bot" }, unread: 0 }] } }];

let settled = false;
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
		if (p === "/api/notices") return json({ items: settled ? NOTES.map(n => ({ ...n, decision: { ...n.decision, state: "answered", answer: "3) 보내지 않기", answered_at: n.ts } })) : NOTES, unread: 0 });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json(peers(server.port as number));
		if (p === "/api/integrations") return json({ items: [MAIL], available: [] });
		if (p === "/api/conversations") return json({ items: ROWS.map(r => ({ target: `mail:fx-${r.id}`, unread: 0, read: null, mail: r.card, last: { ts: iso(r.h), text: r.card.subject, from: "bot" } })) });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 5000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const pick = async (v: View, f: string) => {
	await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="${f}"]').click()`);
	await waitFor(v, `document.querySelector('#mon-tl .mr-f.on').dataset.filter === ${JSON.stringify(f)}`);
};
// what the list shows now: the chips, the approval cards (their subjects) and the mail rows (their titles)
const seen = (v: View) => q<{ chips: string[]; cards: string[]; rows: string[]; empty: string; over: boolean }>(v, `return {
	chips: [...document.querySelectorAll("#mon-tl .mr-f")].map(b => b.textContent),
	cards: [...document.querySelectorAll("#mon-tl [data-nid]")].filter(x => !x.classList.contains("mr")).map(x => x.querySelector(".dr-sub")?.textContent || x.textContent.trim().slice(0, 40)),
	rows: [...document.querySelectorAll("#mon-tl .mr .rc-title")].map(t => t.textContent),
	empty: document.querySelector("#mon-tl .empty")?.textContent ?? "",
	over: document.documentElement.scrollWidth > innerWidth }`);

async function boot(width: number, height: number, key: string): Promise<View> {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await run(v, `if (dotzTheme.get() !== "light") dotzTheme.toggle()`);
	await waitFor(v, `typeof INTG !== "undefined" && INTG.items.length === 1 && CONV.has("mail:fx-c") && PQ.loaded`);
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	await waitFor(v, `document.querySelector('#mon-tl .mr-f[data-filter="all"].on') && document.querySelectorAll("#mon-tl .mr").length > 0`);
	return v;
}

for (const [width, height] of [[390, 844], [1280, 900]] as const) {
	describe(`mail 확인 대기 at ${width}px`, () => {
		test("approval cards show only under 확인 대기, newest first, with the count on the chip", async () => {
			const v = await boot(width, height, "i:mail");
			const all = await seen(v);
			expect(all.chips).toEqual(["전체", "안 읽음", "답장 필요2", "확인 대기2", "답장함1", "보낸 메일"]);
			expect(all.cards).toEqual(["Re: 일정 조율"]);   // the sent draft stays as history; nothing waiting shows under 전체
			expect(all.rows).toEqual(["자료 요청", "회의 일정 문의", "일정 조율"]);
			expect(all.over).toBe(false);
			await Bun.write(join(SHOTS, `all-${width}.png`), await v.screenshot());

			await pick(v, "replied");
			expect((await seen(v)).cards.filter(c => c.startsWith("Re: 자료") || c.startsWith("Re: 회의"))).toEqual([]);

			await pick(v, "pending");
			await waitFor(v, `document.querySelectorAll("#mon-tl .dr.open").length === 2`);
			const p = await seen(v);
			expect(p.cards).toEqual(["Re: 회의 일정 문의", "Re: 자료 요청"]);
			expect(p.rows).toEqual([]);
			expect(await q<string[]>(v, `return [...document.querySelectorAll("#mon-tl .dr.open .dr-act button")].map(b => b.textContent)`)).toEqual(["보내기", "고치기", "보내지 않기", "보내기", "고치기", "보내지 않기"]);
			expect(p.over).toBe(false);
			await Bun.write(join(SHOTS, `pending-${width}.png`), await v.screenshot());

			await pick(v, "all");
			expect((await seen(v)).cards).toEqual(["Re: 일정 조율"]);
		}, 30_000);
	});
}

test("a peer's mail app counts and shows its pending draft under 확인 대기 only", async () => {
	const v = await boot(390, 844, `p:http://127.0.0.1:${server.port}/mini|i:mail`);
	const all = await seen(v);
	expect(all.chips).toContain("확인 대기1");
	expect(all.cards).toEqual([]);
	expect(all.rows).toEqual(["견적 요청"]);
	await pick(v, "pending");
	await waitFor(v, `document.querySelector('#mon-tl [data-nid="peer-1"]')`);
	const p = await seen(v);
	expect(p.rows).toEqual([]);
	expect(await q<string[]>(v, `return [...document.querySelectorAll("#mon-tl [data-nid]")].map(x => x.dataset.nid)`)).toEqual(["peer-1"]);
}, 30_000);

test("확인 대기 with nothing waiting says so", async () => {
	settled = true;
	const v = await boot(390, 844, "i:mail");
	expect((await seen(v)).chips).toContain("확인 대기");
	await pick(v, "pending");
	const p = await seen(v);
	expect([p.empty, p.rows.length, p.cards.length]).toEqual(["확인할 초안이 없어요", 0, 0]);
}, 30_000);
