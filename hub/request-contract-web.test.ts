import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest, unreadCount } from "./notices.ts";
import { fakeHub, idleState, json, on, type View } from "./test-web.ts";

const SHOTS = process.env.REQUEST_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const sample = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}번째 문장은 sample-${i + 1} 계정의 설정을 설명해요.`).join(" ");
const dec = (id: string, m: number, title: string, to: string, d: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	id, kind: "decision", tone: "ask", title, text: title, open: to, src: to, at: minutesAgo(m), ts: minutesAgo(m), updated: minutesAgo(m), read: false, by: "orchestrator", ...extra,
	decision: { to, reply_to: minutesAgo(m), group: 1, state: "open", options: [{ n: 1, label: "예", rec: true }, { n: 2, label: "아니요" }], ...d },
});
const draftQueue = [{ item: "mail:SAMPLE2", ref: "SAMPLE2", kind: "mail", app: "", label: "", conv: "mail:sample-2", at: Date.now() - 300_000, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "sample@example.com", text: "확인했어요" } }];
let fixtures: unknown[] = [];
let history: unknown[] = [];
let queue: unknown[] = [];
const hub = fakeHub({
	state: () => idleState({ notices_unread: fixtures.length + unreadCount() }),
	api: (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" || url.searchParams.get("target") === "alert" ? history : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 1, undoSec: 10 });
		if (p === "/api/notices" && req.method === "GET") return json(fixtures.length ? { unread: fixtures.length, items: fixtures } : listNotices(300));
	},
});
let view!: View;
const { waitFor, ev, run } = { waitFor: (e: string, ms?: number) => on(view).waitFor(e, ms), ev: <T = unknown>(e: string) => on(view).ev<T>(e), run: (c: string) => on(view).run(c) };
afterAll(() => {
	hub.stop();
	resetNoticesForTest();
});
afterEach(() => hub.release());
beforeEach(() => {
	resetNoticesForTest();
	fixtures = [];
	history = [];
	queue = [];
});
const boot = async (w: number, h: number, hash = "") => {
	view = await hub.view({ width: w, height: h, foldedCards: true });
	await view.navigate(`${hub.origin}/${hash}`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && S`);
};
const shot = async (w: number, name: string) => {
	if (SHOTS) await Bun.write(join(SHOTS, `${name}-${w}.png`), await view.screenshot());
};

for (const [w, h] of [[390, 844], [1280, 760]] as const) {
	describe(`요청 계약 at ${w}px`, () => {
		test("a long question shows its first sentences, folds the rest under 자세히 보기, says when more is below, and numbers its options like the body", async () => {
			const body = `${sample(60)} 1번과 2번 중에서 골라 주세요.`;
			fixtures = [dec("long-1", 5, "sample-0 계정을 어떻게 설정할까요?", "main", { options: [{ n: 1, label: "회사 메일로 받기" }, { n: 2, label: "개인 메일로 받기" }, { n: 3, label: "나중에 정하기" }] }, { text: body })];
			await boot(w, h);
			await run(`noticeSheetOpen("long-1")`);
			await waitFor(`document.querySelector(".ds-opt")`);
			const shown = await ev<{ more: boolean; open: boolean; summary: string; head: number; keys: string[] }>(`(() => { const d = document.querySelector(".ds-more"), top = document.querySelector(".fs-body > .ds-md"); return { more: !!d, open: !!d && d.open, summary: d ? d.querySelector("summary").textContent : "", head: top ? (top.textContent.match(/문장은/g) || []).length : 0, keys: [...document.querySelectorAll(".ds-opt .dc-key")].map(k => k.textContent) }; })()`);
			expect(shown.more).toBe(true);
			expect(shown.open).toBe(false);
			expect(shown.summary).toBe("자세히 보기");
			expect(shown.head).toBeGreaterThanOrEqual(1);
			expect(shown.head).toBeLessThanOrEqual(3);
			expect(shown.keys).toEqual(["1", "2", "3"]);
			await shot(w, "sheet-folded");
			await run(`document.querySelector(".ds-more summary").click()`);
			await waitFor(`document.querySelector(".fs-body.ov")`);
			expect(await ev<string>(`(() => { const t = document.querySelector(".ds-hint"); return t && !t.hidden ? t.textContent : ""; })()`)).toBe("더 있어요 ↓");
			await shot(w, "sheet-more-below");
			await run(`const b = document.querySelector(".fs-body"); b.scrollTop = b.scrollHeight`);
			await waitFor(`!document.querySelector(".fs-body.ov") && document.querySelector(".ds-hint").hidden`);
		}, 20_000);

		test("a short question has no fold and no more-below line", async () => {
			fixtures = [dec("short-1", 5, "회의실 어디로 잡을까요?", "main", {}, { text: "오후 회의예요. 자리가 둘 남았어요." })];
			await boot(w, h);
			await run(`noticeSheetOpen("short-1")`);
			await waitFor(`document.querySelector(".ds-opt")`);
			expect(await ev<number>(`document.querySelectorAll(".ds-more").length + document.querySelectorAll(".fs-body.ov").length`)).toBe(0);
			expect(await ev<number>(`[...document.querySelectorAll(".ds-hint")].filter(x => !x.hidden).length`)).toBe(0);
		}, 20_000);

		test("the card pinned above the composer is one folded line with its choice count, and unfolded it takes at most 35% of the screen", async () => {
			const opts = Array.from({ length: 8 }, (_, i) => `${i + 1}) 방법 ${i + 1}\n   sample-${i + 1} 방법을 쓰면 시간이 오래 걸리고 되돌리기도 어려워요. 그래도 괜찮다면 고르세요.`).join("\n");
			const e = { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: `[ask] 카톡 확인을 어디서 할까요?\n\n결정: 카톡 확인을 어디서 할까요?\n${opts}` };
			emit("outbox", e);
			history = [e];
			await boot(w, h);
			await run(`go("chat", "main")`);
			await waitFor(`!$("#dcard").hidden && DC.cur`);
			const folded = await ev<{ fold: boolean; text: string; rows: number; h: number; vh: number }>(`({ fold: $("#dcard").classList.contains("fold"), text: $("#dcard").textContent, rows: document.querySelectorAll("#dcard .dc-row").length, h: $("#dcard").getBoundingClientRect().height, vh: innerHeight })`);
			expect(folded.fold).toBe(true);
			expect(folded.rows).toBe(0);
			expect(folded.text).toContain("카톡 확인을 어디서 할까요?");
			expect(folded.text).toContain("8가지 중 고르기");
			expect(folded.h).toBeLessThanOrEqual(64);
			await shot(w, "card-folded");
			await run(`$(".dc-fold").click()`);
			await waitFor(`!$("#dcard").classList.contains("fold") && document.querySelectorAll("#dcard .dc-row").length === 8`);
			const open = await ev<{ h: number; vh: number; scrolls: boolean }>(`(() => { const b = $("#dcard .dc-body"); return { h: $("#dcard").getBoundingClientRect().height, vh: innerHeight, scrolls: b.scrollHeight > b.clientHeight }; })()`);
			expect(open.h).toBeLessThanOrEqual(open.vh * 0.35 + 1);
			expect(open.scrolls).toBe(true);
			await shot(w, "card-open");
		}, 20_000);

		test("home 답변 필요 shows four rows then 3개 더 보기; each question row says where, how long ago and how many choices; a tap on 더 보기 shows the rest", async () => {
			fixtures = Array.from({ length: 7 }, (_, i) => dec(`q-${i}`, 10 + i, `sample-${i} 질문을 어떻게 할까요?`, "main", { options: [{ n: 1, label: "예" }, { n: 2, label: "아니요" }, ...(i === 0 ? [{ n: 3, label: "나중에" }] : [])] }));
			await boot(w, h);
			await waitFor(`document.querySelectorAll('#home-now [data-k="needs"] > .hr').length === 7`);
			const shown = await ev<{ visible: number; more: string; first: string; last: string }>(`(() => { const l = document.querySelector('#home-now [data-k="needs"]'), rows = [...l.querySelectorAll(":scope > .hr")], vis = rows.filter(r => r.offsetParent); return { visible: vis.length, more: (l.querySelector(".hn-more") || {}).textContent || "", first: vis[0].querySelector(".ha").textContent, last: vis[vis.length - 1].querySelector(".ha").textContent }; })()`);
			expect(shown.visible).toBe(4);
			expect(shown.more).toBe("3개 더 보기");
			expect(shown.first).toMatch(/^.+ · .+ · 선택지 3개$/);
			expect(shown.last).toMatch(/ · 선택지 2개$/);
			await shot(w, "home-needs-4");
			await run(`document.querySelector('#home-now .hn-more').click()`);
			await waitFor(`[...document.querySelectorAll('#home-now [data-k="needs"] > .hr')].filter(r => r.offsetParent).length === 7`);
			expect(await ev<string>(`document.querySelector('#home-now .hn-more').textContent`)).toBe("접기");
		}, 20_000);

		test("a send approval has one name on 홈 and in 알림, without the code of the draft", async () => {
			fixtures = [dec("draft-1", 5, "이 답장 보낼까요? (SAMPLE2)", "mail:sample-2", { options: [{ n: 1, label: "보내기" }, { n: 2, label: "고치기" }, { n: 3, label: "보내지 않기" }], draft: { ref: "SAMPLE2", to: "sample@example.com", body: "확인했어요" } })];
			queue = draftQueue;
			await boot(w, h, "#notices");
			await waitFor(`document.querySelector('#v-notices .nsc-r')`);
			const shown = await ev<string>(`document.querySelector('#v-notices .nsc-r .hd').textContent`);
			expect(shown).toBe("답장 초안 확인");
			expect(shown).not.toContain("SAMPLE2");
			await run(`go("home")`);
			await waitFor(`current === "home" && document.querySelector('#home-now .hr[data-k="replies"]')`);
			expect(await ev<string>(`document.querySelector('#home-now .hr[data-k="replies"] .nm').textContent`)).toBe(shown);
		}, 20_000);

		test("the 알림 conversation has no composer but a link that opens main with that alert quoted; the 작업내역 hint says what the box is for", async () => {
			const at = minutesAgo(3);
			history = [{ ts: at, kind: "out", source: "gateway", target: "alert", text: "[fail] sample-1 감시가 세 번 실패했어요" }];
			await boot(w, h);
			await run(`nscPass(5000); go("chat", "alert")`);
			await waitFor(`document.querySelector("#tl [data-ts]") && document.querySelector("#v-chat.no-composer") && !document.querySelector("#al-bar").hidden`);
			expect(await ev<boolean>(`getComputedStyle(document.querySelector("#v-chat .composer")).display === "none"`)).toBe(true);
			expect(await ev<string>(`(() => { const b = document.querySelector("#al-ask"); return b && b.offsetParent ? b.textContent : ""; })()`)).toBe("이 알림에 대해 메인에서 묻기 ›");
			await shot(w, "alert-link");
			await run(`document.querySelector("#al-ask").click()`);
			await waitFor(`target === "main" && RP.cur && RP.cur.t === "main" && !document.querySelector("#replybar").hidden`);
			expect(await ev<string>(`document.querySelector("#replybar .rp-ct").textContent`)).toContain("sample-1 감시가 세 번 실패했어요");
			await run(`go("chat", "worklog")`);
			await waitFor(`target === "worklog"`);
			expect(await ev<string>(`document.querySelector("#text").placeholder`)).toBe("이 기록에 대해 물어보세요 · 답은 여기에 와요");
			await shot(w, "worklog-hint");
		}, 20_000);
	});
}
