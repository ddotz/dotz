// The mail list of 모니터링 with a state label on every row and the filter 전체 / 답장 필요 / 답장함 / 보낸 메일, in a headless browser against a fake hub.
// MAIL_STATE_SHOTS=<dir> keeps the screenshots (390 and 1280 wide).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.MAIL_STATE_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown, status = 200) => Response.json(v, { status });
const iso = (h: number) => new Date(Date.UTC(2026, 9, 24, h, 0)).toISOString();
const MAIL = { key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread: 1, unreplied: 2, needs: { drafts: 0, unread: 1, sentToday: 0, unreplied: 2 } };

type Row = { id: string; unread: number; h: number; card: Record<string, unknown> };
const card = (subject: string, from: string, summary: string, h: number, extra: Record<string, unknown> = {}) => ({ subject, from, source: "mail", at: iso(h), summary, ...extra });
const ROWS: Row[] = [
	{ id: "new", unread: 1, h: 9, card: card("견적 문의드립니다", "민수 <minsu@example.com>", "다음 주 견적을 받을 수 있을까요?", 9) },
	{ id: "read", unread: 0, h: 8, card: card("회의록 공유", "Lee <lee@example.com>", "어제 회의록입니다.", 8) },
	{ id: "needs", unread: 0, h: 7, card: card("계약서 확인 부탁드립니다", "Kim <kim@example.com>", "금요일까지 회신 부탁드려요.", 7, { reply: "needs", unreplied: true }) },
	{ id: "draft", unread: 1, h: 6, card: card("자료 요청", "Park <park@example.com>", "발표 자료를 보내 주세요.", 6, { reply: "draft", unreplied: true, suggest: { kind: "reply-draft", label: "답장 초안", ref: "d1" } }) },
	{ id: "replied", unread: 0, h: 5, card: card("일정 조율", "Han <han@example.com>", "목요일 괜찮으신가요?", 5, { reply: "replied", sentAt: iso(5) }) },
	{ id: "skipped", unread: 0, h: 4, card: card("업데이트 안내", "Shop <shop@example.com>", "서비스 약관이 바뀝니다.", 4, { reply: "skipped" }) },
	{ id: "fyi", unread: 0, h: 3, card: card("배송 완료", "Mall <mall@example.com>", "상품이 도착했어요.", 3, { reply: "fyi" }) },
	{ id: "out", unread: 0, h: 2, card: card("Re: 일정 조율", "Owner <owner@example.com>", "목요일 좋습니다.", 2, { dir: "out", to: "Han <han@example.com>" }) },
];
const PEER_FREE = [{ name: "맥북", url: "", self: true, online: true }];

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
		if (p === "/api/peers") return json(PEER_FREE.map(x => ({ ...x, url: `http://127.0.0.1:${server.port}` })));
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json([]);
		if (p === "/api/integrations") return json({ items: [MAIL], available: [] });
		if (p === "/api/conversations") return json({ items: ROWS.map(r => ({ target: `mail:fx-${r.id}`, unread: r.unread, read: null, mail: r.card, last: r.card.dir === "out" ? null : { ts: iso(r.h), text: String(r.card.subject), from: "bot" } })) });
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
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };

async function boot(width: number, height: number, theme: "light" | "dark" = "light"): Promise<View> {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await run(v, `if (dotzTheme.get() !== ${JSON.stringify(theme)}) dotzTheme.toggle()`);
	await waitFor(v, `typeof INTG !== "undefined" && INTG.items.length === 1 && CONV.has("mail:fx-out")`);
	await run(v, `go("monitoring", "i:mail")`);
	await waitFor(v, `document.querySelectorAll("#mon-tl .mr").length === 8`);
	return v;
}
const states = (v: View) => q<Record<string, string>>(v, `const o = {}; for (const r of document.querySelectorAll("#mon-tl .mr")) o[r.querySelector(".rc-title").textContent] = [...r.querySelectorAll(".rc-hd .tag")].map(t => t.textContent).join("|"); return o;`);
const titles = (v: View) => q<string[]>(v, `return [...document.querySelectorAll("#mon-tl .mr .rc-title")].map(t => t.textContent)`);
const pick = async (v: View, f: string) => {
	await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="${f}"]').click()`);
	await waitFor(v, `document.querySelector('#mon-tl .mr-f.on').dataset.filter === ${JSON.stringify(f)}`);
};

for (const [width, height] of [[390, 900], [1280, 900]] as const) {
	describe(`mail list at ${width}px`, () => {
		test("every row has one state label; reading keeps 답장 필요; the unread count stays beside a reply state", async () => {
			const v = await boot(width, height);
			expect(await states(v)).toEqual({
				"견적 문의드립니다": "새 메일",
				"회의록 공유": "읽음",
				"계약서 확인 부탁드립니다": "답장 필요",
				"자료 요청": "초안 있음|안 읽음 1",
				"일정 조율": "답장함",
				"업데이트 안내": "답장 안 함",
				"배송 완료": "답장 불필요",
				"Re: 일정 조율": "내가 보냄",
			});
			expect(await q<string[]>(v, `return [...document.querySelectorAll("#mon-tl .mr .tag.unreplied")].map(t => t.textContent)`)).toEqual(["답장 필요", "초안 있음"]);
			expect(await q<string>(v, `return [...document.querySelectorAll("#mon-tl .mr")].find(r => r.querySelector(".rc-title").textContent === "Re: 일정 조율").querySelector(".rc-src").textContent`)).toBe("나 → Han");
			expect(await q<boolean>(v, `return document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
			await shot(v, `mail-states-${width}-light.png`);
		});

		test("the filter shows 답장 필요, 답장함 or 보낸 메일 only, with counts, and 전체 brings everything back", async () => {
			const v = await boot(width, height);
			expect(await q<string[]>(v, `return [...document.querySelectorAll("#mon-tl .mr-f")].map(b => b.textContent)`)).toEqual(["전체", "안 읽음2", "답장 필요2", "확인 대기", "답장함1", "보낸 메일1"]);
			await pick(v, "unread");
			expect((await titles(v)).length).toBe(2);
			await pick(v, "owed");
			expect(await titles(v)).toEqual(["계약서 확인 부탁드립니다", "자료 요청"]);
			await shot(v, `mail-filter-owed-${width}-light.png`);
			await pick(v, "replied");
			expect(await titles(v)).toEqual(["일정 조율"]);
			await pick(v, "sent");
			expect(await titles(v)).toEqual(["Re: 일정 조율"]);
			await shot(v, `mail-filter-sent-${width}-light.png`);
			await pick(v, "all");
			expect((await titles(v)).length).toBe(8);
		});

		test("dark theme draws the same labels", async () => {
			const v = await boot(width, height, "dark");
			expect(Object.keys(await states(v)).length).toBe(8);
			await shot(v, `mail-states-${width}-dark.png`);
		});
	});
}
