import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// A time list in a chat answer (web/js/02-basic-markdown.js timeRowsHtml), drawn in a headless browser: rows in one card for an answer, a
// plain list or text for anything else, the original lines in a copied selection.
const ts = (n: number) => `2026-11-04T08:${String(10 + n).padStart(2, "0")}:00.000Z`;
const answer = (n: number, text: string) => ({ ts: ts(n), kind: "out", source: "orchestrator", target: "web", text });
const events = [
	answer(0, "오늘 일정은 두 개예요.\n\n- 10:00 팀 주간 회의\n- 13:30 치과 예약 · 강남역 · 2번 출구"),
	answer(1, "섞인 목록이에요.\n\n- 10:00 팀 주간 회의\n- 13:30 치과 예약\n- 장 보기"),
	answer(2, "한 줄이에요.\n\n- 10:00 팀 주간 회의"),
	answer(3, "코드예요.\n\n```\n- 10:00 팀 주간 회의\n- 13:30 치과 예약\n```"),
	answer(4, "| 시각 | 일 |\n|---|---|\n| 10:00 | 회의 |\n| 13:30 | 치과 |"),
	{ ts: ts(5), kind: "in", source: "web", target: "web", text: "- 10:00 팀 주간 회의\n- 13:30 치과 예약" },
	answer(6, "아침 브리핑이에요.\n\n- 09:00 스탠드업\n- 11:00 리뷰\n\n메일 3통이 왔어요."),
];
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? events : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
const page = async <T>(expr: string) => (await view.evaluate(`JSON.stringify(${expr})`).then(s => JSON.parse(s as string))) as T;
const msg = (i: number) => `[...document.querySelectorAll(".bm, .ub")].filter(m => m.querySelector(".md, .hcb") || m.matches(".ub"))[${i}]`;
const shape = (i: number) => page<{ cards: number; rows: number; lis: number; pre: number; table: number }>(`(m => ({ cards: m.querySelectorAll(".hcb-card, .ans-card:has(.rc-row)").length, rows: m.querySelectorAll(".rc-row").length, lis: m.querySelectorAll("li").length, pre: m.querySelectorAll("pre").length, table: m.querySelectorAll("table").length }))(${msg(i)})`);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof openTarget === "function" && S`);
await view.evaluate(`(openTarget("main", "chat"), 0)`);
await waitFor(`${msg(events.length - 1)} !== undefined`);

test("two time lines in an answer are key-column rows in one card, the detail kept whole", async () => {
	expect(await shape(0)).toEqual({ cards: 1, rows: 2, lis: 0, pre: 0, table: 0 });
	const got = await page<{ k: string[]; w: string[]; d: string[]; same: boolean; over: boolean }>(`(m => ({
		k: [...m.querySelectorAll(".rc-k")].map(e => e.textContent), w: [...m.querySelectorAll(".rc-w b")].map(e => e.textContent), d: [...m.querySelectorAll(".rc-d")].map(e => e.textContent),
		same: new Set([...m.querySelectorAll(".rc-w")].map(e => e.getBoundingClientRect().left)).size === 1, over: document.documentElement.scrollWidth > innerWidth }))(${msg(0)})`);
	expect(got.k).toEqual(["10:00", "13:30"]);
	expect(got.w).toEqual(["팀 주간 회의", "치과 예약"]);
	expect(got.d).toEqual(["강남역 · 2번 출구"]);
	expect(got.same).toBe(true);
	expect(got.over).toBe(false);
});

test("a copied selection gives the lines as written", async () => {
	const copied = await page<string>(`(() => { const s = getSelection(); s.selectAllChildren(${msg(0)}.querySelector(".md")); const t = s.toString(); s.removeAllRanges(); return t; })()`);
	expect(copied.trim().split(/\n+/).map(l => l.trim())).toEqual(["오늘 일정은 두 개예요.", "- 10:00 팀 주간 회의", "- 13:30 치과 예약 · 강남역 · 2번 출구"]);
});

test("a mixed list stays a list and a single time line stays as written", async () => {
	expect(await shape(1)).toMatchObject({ cards: 0, rows: 0, lis: 3 });
	expect(await shape(2)).toMatchObject({ cards: 0, rows: 0, lis: 1 });
});

test("a code fence and a table stay as they are", async () => {
	expect(await shape(3)).toMatchObject({ cards: 0, rows: 0, pre: 1 });
	expect(await shape(4)).toMatchObject({ cards: 0, rows: 0, table: 1 });
});

test("the owner's bubble keeps its list", async () => {
	expect(await shape(5)).toMatchObject({ cards: 0, rows: 0 });
});

test("a morning briefing keeps its tag and mail chip around the same rows", async () => {
	expect(await shape(6)).toMatchObject({ cards: 1, rows: 2, lis: 0 });
	expect(await page<string[]>(`(m => [m.querySelector(".hcb-hd .tag")?.textContent, m.querySelector(".hcb-chip")?.textContent])(${msg(6)})`)).toEqual(["아침 점검", "메일 3통이 왔어요."]);
});
