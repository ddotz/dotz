import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { emit } from "./events.ts";
import { resetNoticesForTest } from "./notices.ts";
import { fakeHub, idleState, json, on, type View } from "./test-web.ts";

const SHOTS = process.env.W4_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const HOUR = 3_600_000;
const clock = () => new Date().getTime();
const minutesAgo = (m: number) => new Date(clock() - m * 60_000).toISOString();
const inHours = (h: number) => new Date(clock() + h * HOUR).toISOString();
type Item = { id: string; kind: string; decision: Record<string, unknown>; [k: string]: unknown };
const dec = (id: string, m: number, title: string, to: string, d: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Item => ({
	id, kind: "decision", tone: "ask", title, text: title, open: to, src: to, at: minutesAgo(m), ts: minutesAgo(m), updated: minutesAgo(m), read: false, by: "orchestrator", ...extra,
	decision: { to, reply_to: minutesAgo(m), group: 1, state: "open", options: [{ n: 1, label: "예", rec: true }, { n: 2, label: "아니요" }], ...d },
});
let fixtures: Item[] = [];
let history: unknown[] = [];
let laneHistory: unknown[] = [];
let lanes: unknown[] = [];
let posts: { path: string; body: unknown }[] = [];
const hub = fakeHub({
	state: () => idleState({ notices_unread: fixtures.length, lanes }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : url.searchParams.get("target") === "lane:web" ? laneHistory : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/reply/queue") return json({ items: [], counts: {}, triageMin: 1, undoSec: 10 });
		if (p === "/api/notices" && req.method === "GET") return json({ unread: fixtures.length, items: fixtures, gone: [] });
		const act = /^\/api\/notices\/([^/]+)\/(more|later)$/.exec(p);
		if (act && req.method === "POST") {
			const body = (await req.json()) as { for?: string };
			posts.push({ path: p, body });
			const item = fixtures.find(x => x.id === act[1]);
			if (!item) return json({ ok: false }, 404);
			if (act[2] === "more") item.decision.more_at = new Date().toISOString();
			else { item.decision.later_until = body.for === "hour" ? inHours(1) : inHours(10); item.read = true; }
			return json({ ok: true, item, unread: fixtures.length });
		}
		const ign = /^\/api\/notices\/([^/]+)\/ignore$/.exec(p);
		if (ign && req.method === "POST") {
			posts.push({ path: p, body: await req.json() });
			const item = fixtures.find(x => x.id === ign[1]);
			if (!item) return json({ ok: false }, 404);
			Object.assign(item, { ignored: new Date().toISOString(), read: true });
			item.decision.state = "ignored";
			delete item.decision.later_until;
			return json({ ok: true, item, ids: [item.id], unread: 0 });
		}
		if (p === "/api/notices/reopen" && req.method === "POST") {
			const body = (await req.json()) as { ids: string[] };
			posts.push({ path: p, body });
			for (const x of fixtures) if (body.ids.includes(x.id)) { x.decision.state = "open"; delete x.decision.expired; delete x.decision.resolved; delete x.decision.closed_how; }
			return json({ ok: true, unread: fixtures.length });
		}
		return undefined;
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
	laneHistory = [];
	lanes = [];
	posts = [];
});
const boot = async (w: number, h: number, hash = "", folded = false) => {
	view = await hub.view({ width: w, height: h, foldedCards: folded });
	await view.navigate(`${hub.origin}/${hash}`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && S`);
};
const shot = async (w: number, name: string) => {
	if (!SHOTS) return;
	await waitFor(`document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, `${name}-${w}.png`), await view.screenshot());
};
const texts = (sel: string) => ev<string[]>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(x => x.textContent.trim())`);
const hm = (iso: string) => ev<string>(`kstHM(${JSON.stringify(iso)})`);
const openSheet = async (id: string) => {
	await run(`noticeSheetOpen(${JSON.stringify(id)})`);
	await waitFor(`document.querySelector(".ds-opt")`);
};
const noticeAt = (id: string) => ev<Record<string, string>>(`NT.items.find(n => n.id === ${JSON.stringify(id)}).decision`);

for (const [w, h] of [[390, 844], [1280, 760]] as const) {
	describe(`요청 계약 2차 at ${w}px`, () => {
		test("an open question's sheet has the three fixed buttons; 자세히 알려 주세요 posts /more, says when, and leaves the card open", async () => {
			fixtures = [dec("q-1", 5, "회의실 어디로 잡을까요?", "main")];
			await boot(w, h);
			await openSheet("q-1");
			expect(await texts(".ds-fixed .ds-direct")).toEqual(["다른 답 쓰기", "자세히 알려 주세요", "나중에"]);
			await shot(w, "sheet-fixed");
			await run(`document.querySelector('.ds-fixed [data-k="more"]').click()`);
			await waitFor(`NT.items[0].decision.more_at`);
			expect(posts.map(x => x.path)).toEqual(["/api/notices/q-1/more"]);
			const at = (await noticeAt("q-1")).more_at!;
			expect(await texts(".ds-st")).toEqual([`더 알려 달라고 했어요 · ${await hm(at)}`]);
			expect(await texts(".ds-opt .ds-lb")).toEqual(["1예", "2아니요"]);
			await shot(w, "sheet-more");
		}, 30_000);

		test("나중에 asks 1시간 뒤 or 내일 아침, posts /later, labels the card with the time and takes it off 답변 필요 until that time", async () => {
			fixtures = [dec("q-1", 5, "회의실 어디로 잡을까요?", "main"), dec("q-2", 6, "점심은 뭘로 할까요?", "main", { reply_to: minutesAgo(6) })];
			await boot(w, h);
			expect(await ev<number>(`ntDecisions().length`)).toBe(2);
			await openSheet("q-1");
			await run(`document.querySelector('.ds-fixed [data-k="later"]').click()`);
			await waitFor(`document.querySelector('.ds-fixed [data-k="later-hour"]')`);
			expect(await texts(".ds-fixed .ds-direct")).toEqual(["1시간 뒤", "내일 아침", "돌아가기"]);
			await shot(w, "sheet-later-choice");
			await run(`document.querySelector('.ds-fixed [data-k="later-hour"]').click()`);
			await waitFor(`NT.items[0].decision.later_until`);
			expect(posts).toEqual([{ path: "/api/notices/q-1/later", body: { for: "hour" } }]);
			const until = (await noticeAt("q-1")).later_until!;
			expect(await texts(".ds-st")).toEqual([`나중에 볼게요 · ${await hm(until)}에 다시 알려요`]);
			await shot(w, "sheet-later");
			await run(`ntSheetClose(false); go("home")`);
			await waitFor(`current === "home"`);
			expect(await ev<string[]>(`ntDecisions().map(n => n.id)`)).toEqual(["q-2"]);
			expect(await ev<number>(`document.querySelectorAll('#home-now [data-k="needs"] > .hr').length`)).toBe(1);
			await run(`NT.items[0].decision.later_until = new Date(Date.now() - 1000).toISOString(); ntPaint(); homeSoon()`);
			expect(await ev<string[]>(`ntDecisions().map(n => n.id).sort()`)).toEqual(["q-1", "q-2"]);
		}, 30_000);

		test("a session's question put off with 나중에 leaves the card above the composer and 답변 필요", async () => {
			const askAt = minutesAgo(2), text = "[ask] 어느 브랜치에 합칠까요?\n\n결정: 어느 브랜치에 합칠까요?\n1) main\n2) dev";
			lanes = [{ name: "web", title: "웹", status: "idle", live: true, alive: true, pendingAsk: { text, at: askAt } }];
			laneHistory = [{ ts: askAt, kind: "lane_report", source: "lane:web", lane: "web", text }];
			fixtures = [dec("lq", 2, "어느 브랜치에 합칠까요?", "lane:web", { reply_to: askAt, options: [{ n: 1, label: "main" }, { n: 2, label: "dev" }] }, { by: "lane:web" })];
			await boot(w, h);
			await run(`go("chat", "lane:web")`);
			await waitFor(`!$("#dcard").hidden && document.querySelector('#dcard .dc-fixed [data-k="later"]')`);
			await run(`document.querySelector('#dcard .dc-fixed [data-k="later"]').click()`);
			await waitFor(`document.querySelector('#dcard [data-k="later-hour"]')`);
			await run(`document.querySelector('#dcard [data-k="later-hour"]').click()`);
			await waitFor(`NT.items[0].decision.later_until && !ASK.busy`);
			expect(await ev<boolean>(`$("#dcard").hidden`)).toBe(true);
			await run(`go("home")`);
			await waitFor(`current === "home" && document.querySelector("#home-now")`);
			expect(await ev<number>(`nyList().length`)).toBe(0);
			expect(await ev<number>(`document.querySelectorAll('#home-now [data-k="needs"] > .hr').length`)).toBe(0);
		}, 30_000);

		test("무시 on the sheet of a question put off with 나중에 ignores it", async () => {
			fixtures = [dec("q-1", 5, "회의실 어디로 잡을까요?", "main")];
			await boot(w, h);
			await openSheet("q-1");
			await run(`document.querySelector('.ds-fixed [data-k="later"]').click()`);
			await waitFor(`document.querySelector('.ds-fixed [data-k="later-hour"]')`);
			await run(`document.querySelector('.ds-fixed [data-k="later-hour"]').click()`);
			await waitFor(`NT.items[0].decision.later_until && !ASK.busy`);
			await run(`document.querySelector('.fs-hd [data-k="ignore"]').click()`);
			await waitFor(`NT.items[0].decision.state === "ignored"`);
			expect(posts.map(x => x.path)).toEqual(["/api/notices/q-1/later", "/api/notices/q-1/ignore"]);
		}, 30_000);

		test("내일 아침 posts for: morning", async () => {
			fixtures = [dec("q-1", 5, "회의실 어디로 잡을까요?", "main")];
			await boot(w, h);
			await openSheet("q-1");
			await run(`document.querySelector('.ds-fixed [data-k="later"]').click()`);
			await waitFor(`document.querySelector('.ds-fixed [data-k="later-morning"]')`);
			await run(`document.querySelector('.ds-fixed [data-k="later-morning"]').click()`);
			await waitFor(`NT.items[0].decision.later_until`);
			expect(posts).toEqual([{ path: "/api/notices/q-1/later", body: { for: "morning" } }]);
		}, 30_000);

		test("the card pinned above the composer has the same three buttons; 나중에 takes the card away, 자세히 알려 주세요 keeps it with the time", async () => {
			const e = { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: "[ask] 점심은 뭘로 할까요?\n\n결정: 점심은 뭘로 할까요?\n1) 국밥\n2) 파스타" };
			emit("outbox", e);
			history = [e];
			fixtures = [dec("pin-1", 2, "점심은 뭘로 할까요?", "main", { reply_to: e.ts, options: [{ n: 1, label: "국밥" }, { n: 2, label: "파스타" }] })];
			await boot(w, h);
			await run(`go("chat", "main")`);
			await waitFor(`!$("#dcard").hidden && DC.cur && document.querySelectorAll("#dcard .dc-row").length === 2`);
			expect(await texts("#dcard .dc-fixed .btn")).toEqual(["다른 답 쓰기", "자세히 알려 주세요", "나중에"]);
			await shot(w, "card-fixed");
			await run(`document.querySelector('#dcard .dc-fixed [data-k="more"]').click()`);
			await waitFor(`NT.items[0].decision.more_at`);
			const at = (await noticeAt("pin-1")).more_at!;
			await waitFor(`document.querySelector("#dcard .dc-ask-st")`);
			expect(await texts("#dcard .dc-ask-st")).toEqual([`더 알려 달라고 했어요 · ${await hm(at)}`]);
			expect(await ev<number>(`document.querySelectorAll("#dcard .dc-row").length`)).toBe(2);
			await shot(w, "card-more");
			await run(`document.querySelector('#dcard .dc-fixed [data-k="later"]').click()`);
			await waitFor(`document.querySelector('#dcard [data-k="later-hour"]')`);
			await run(`document.querySelector('#dcard [data-k="later-hour"]').click()`);
			await waitFor(`$("#dcard").hidden`);
			expect(posts.map(x => x.path)).toEqual(["/api/notices/pin-1/more", "/api/notices/pin-1/later"]);
		}, 30_000);

		test("a login request, a schedule run and a send approval get no fixed buttons", async () => {
			fixtures = [
				dec("a-1", 5, "로그인해 주세요", "auth:sample-2", { options: [{ n: 1, label: "열기", action: "form" }] }),
				dec("s-1", 6, "sample-3 정리를 다시 실행할까요?", "schedule:r4", { options: [{ n: 1, label: "다시 실행", action: "rerun" }, { n: 2, label: "멈추기", action: "stop" }] }),
			];
			await boot(w, h);
			for (const id of ["a-1", "s-1"]) {
				await openSheet(id);
				expect(await ev<number>(`document.querySelectorAll(".ds-fixed").length`)).toBe(0);
				expect(await texts(".ds-direct")).not.toContain("자세히 알려 주세요");
				await run(`ntSheetClose(false)`);
			}
		}, 30_000);

		test("다른 답 쓰기 opens the sheet's own-words field when the question's conversation takes no typed text", async () => {
			fixtures = [dec("al-1", 5, "닥터 점검을 다시 할까요?", "alert")];
			await boot(w, h);
			await openSheet("al-1");
			await run(`document.querySelector('.ds-fixed [data-k="direct"]').click()`);
			await waitFor(`document.querySelector(".dc-note")`);
			expect(await ev<number>(`document.querySelectorAll(".ds-fixed").length`)).toBe(0);
		}, 30_000);

		test("a closed question says how it closed: in words, expired with 다시 묻기, session gone; a finished one keeps its old label", async () => {
			const closed = (id: string, how: string | undefined, d: Record<string, unknown>) => dec(id, 30, `${id} 질문이에요`, "main", { state: how === "words" ? "answered" : "answered", ...(how ? { closed_how: how } : {}), ...d }, { read: true });
			fixtures = [
				closed("w-1", "words", { answer: "sample-2 쪽으로 해 줘", words: "sample-2 쪽으로 해 줘" }),
				closed("x-1", "expired", { resolved: true, expired: true }),
				closed("g-1", "gone", { resolved: true }),
				closed("d-1", "done", { resolved: true }),
			];
			await boot(w, h);
			const sheetRes = async (id: string) => {
				await openSheet(id);
				await waitFor(`document.querySelector(".ds-res")`);
				const t = await ev<string>(`[...document.querySelectorAll(".ds-res span")].map(s => s.textContent).join(" | ")`);
				const btns = await texts(".fs-ft .ds-direct");
				await run(`ntSheetClose(false)`);
				return { t, btns };
			};
			expect(await sheetRes("w-1")).toEqual({ t: `말로 답했어요 | "sample-2 쪽으로 해 줘"`, btns: ["대화에서 보기"] });
			expect(await sheetRes("x-1")).toEqual({ t: "기한이 지나 닫았어요", btns: ["다시 묻기", "대화에서 보기"] });
			expect(await sheetRes("g-1")).toEqual({ t: "이 세션은 이미 끝났어요 · 메인에 전달", btns: ["대화에서 보기"] });
			expect((await sheetRes("d-1")).t).toBe("답 없이 끝났어요 | 일이 끝나서 닫혔어요");
			await run(`go("notices")`);
			await waitFor(`document.querySelector('#v-notices .nsc-r[data-nid="g-1"]')`);
			const line = (id: string) => ev<string>(`document.querySelector('#v-notices .nsc-r[data-nid="${id}"] .nsc-s').textContent`);
			expect(await line("w-1")).toMatch(/ · 말로 답했어요 · "sample-2 쪽으로 해 줘"$/);
			expect(await line("x-1")).toMatch(/ · 기한이 지나 닫았어요$/);
			expect(await line("g-1")).toMatch(/ · 이 세션은 이미 끝났어요 · 메인에 전달$/);
			expect(await line("d-1")).toMatch(/ · 답 없이 끝났어요$/);
			const mon = (id: string) => ev<string>(`(() => { const n = monDecisionNode(ntById(${JSON.stringify(id)})); return [...n.querySelectorAll(":scope > .mt")].pop().textContent; })()`);
			expect(await mon("w-1")).toBe(`말로 답했어요 · "sample-2 쪽으로 해 줘"`);
			expect(await mon("x-1")).toBe("기한이 지나 닫았어요");
			expect(await mon("g-1")).toBe("이 세션은 이미 끝났어요 · 메인에 전달");
			expect(await mon("d-1")).toBe("답 없이 끝났어요");
			await shot(w, "notices-closed");
		}, 40_000);

		test("다시 묻기 on an expired question reopens it through the reopen route", async () => {
			fixtures = [dec("x-1", 30, "x-1 질문이에요", "main", { state: "answered", closed_how: "expired", resolved: true, expired: true }, { read: true })];
			await boot(w, h);
			await run(`noticeSheetOpen("x-1")`);
			await waitFor(`document.querySelector('.ds-direct[data-k="again"]')`);
			await shot(w, "sheet-expired");
			await run(`document.querySelector('.ds-direct[data-k="again"]').click()`);
			await waitFor(`NT.items[0].decision.state === "open" && document.querySelector(".ds-fixed")`);
			expect(posts).toEqual([{ path: "/api/notices/reopen", body: { ids: ["x-1"] } }]);
		}, 30_000);

		test("under the owner's message: while the model checks it against a card, then 질문은 열어 뒀어요 once the card stayed open", async () => {
			const said = minutesAgo(1);
			history = [{ ts: said, kind: "message", source: "web", channel: "web", text: "sample-2 얘기인데 그건 나중에 정해요" }];
			fixtures = [dec("q-1", 5, "회의실 어디로 잡을까요?", "main", { judging: { at: said, text: "sample-2 얘기인데 그건 나중에 정해요" } })];
			await boot(w, h);
			await run(`go("chat", "main")`);
			await waitFor(`document.querySelector('#tl .um[data-ts]')`);
			expect(await ev<string>(`(document.querySelector('#tl .um .ask-note') || {}).textContent || ""`)).toBe('이 말이 "회의실 어디로 잡을까요?"의 답인지 확인하는 중');
			await shot(w, "owner-judging");
			fixtures[0]!.decision = { ...fixtures[0]!.decision, kept_open: { at: said } };
			delete fixtures[0]!.decision.judging;
			await run(`loadNotices()`);
			await waitFor(`NT.items[0].decision.kept_open`);
			expect(await ev<string>(`(document.querySelector('#tl .um .ask-note') || {}).textContent || ""`)).toBe("질문은 열어 뒀어요");
			expect(await ev<number>(`document.querySelectorAll('#tl .um .ask-note').length`)).toBe(1);
			await shot(w, "owner-kept-open");
		}, 30_000);

		test("another message of the owner's gets no note", async () => {
			const said = minutesAgo(1), other = minutesAgo(3);
			history = [{ ts: other, kind: "message", source: "web", channel: "web", text: "다른 얘기예요" }, { ts: said, kind: "message", source: "web", channel: "web", text: "그건 나중에 정해요" }];
			fixtures = [dec("q-1", 5, "회의실 어디로 잡을까요?", "main", { judging: { at: said, text: "그건 나중에 정해요" } })];
			await boot(w, h);
			await run(`go("chat", "main")`);
			await waitFor(`document.querySelectorAll('#tl .um[data-ts]').length === 2`);
			expect(await ev<string[]>(`[...document.querySelectorAll('#tl .um')].map(m => m.dataset.ts + "|" + ((m.querySelector(".ask-note") || {}).textContent || ""))`)).toEqual([`${other}|`, `${said}|이 말이 "회의실 어디로 잡을까요?"의 답인지 확인하는 중`]);
		}, 30_000);

		test("a question with a deadline says how long is left, in hours, or in minutes under an hour; one without says nothing", async () => {
			fixtures = [
				dec("h-1", 5, "회의실 어디로 잡을까요?", "main", { expires_at: new Date(clock() + 71.5 * HOUR).toISOString() }),
				dec("m-1", 6, "점심은 뭘로 할까요?", "main", { expires_at: new Date(clock() + 30 * 60_000).toISOString() }),
				dec("n-1", 7, "저녁은 뭘로 할까요?", "main"),
			];
			await boot(w, h);
			const meta = async (id: string) => { await run(`noticeSheetOpen(${JSON.stringify(id)})`); await waitFor(`NS.id === ${JSON.stringify(id)} && document.querySelector(".ds-opt")`); const t = await ev<string>(`document.querySelector(".ds-m").textContent`); await shot(w, `sheet-left-${id}`); await run(`ntSheetClose(false)`); return t; };
			expect(await meta("h-1")).toMatch(/ · 72시간 안에 답해 주세요$/);
			expect(await meta("m-1")).toMatch(/ · 30분 안에 답해 주세요$/);
			expect(await meta("n-1")).not.toContain("안에 답해 주세요");
		}, 30_000);

		test("the pinned card shows the deadline too", async () => {
			const e = { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: "[ask] 점심은 뭘로 할까요?\n\n결정: 점심은 뭘로 할까요?\n1) 국밥\n2) 파스타" };
			emit("outbox", e);
			history = [e];
			fixtures = [dec("pin-1", 2, "점심은 뭘로 할까요?", "main", { reply_to: e.ts, options: [{ n: 1, label: "국밥" }, { n: 2, label: "파스타" }], expires_at: new Date(clock() + 71.5 * HOUR).toISOString() })];
			await boot(w, h);
			await run(`go("chat", "main")`);
			await waitFor(`!$("#dcard").hidden && document.querySelectorAll("#dcard .dc-row").length === 2`);
			expect(await texts("#dcard .dc-ask-st")).toEqual(["72시간 안에 답해 주세요"]);
			await shot(w, "card-left");
		}, 30_000);
	});
}

const NOW = clock(), iso = (ms: number) => new Date(ms).toISOString();
const PAST = "2026-11-18T05:30:00Z";
const schedHub = fakeHub({
	state: () => idleState(),
	api: (req, url) => {
		const p = url.pathname;
		if (p === "/api/schedules") return json({ items: [], runs: [{ run: "r0", scheduleId: "s9", name: "sample-5 서류 알림", kind: "owner", text: "서류 내라고 알려 줘", firedAt: PAST, state: "answered", conv: "ch:7" }, { run: "r1", scheduleId: "s8", name: "sample-6 정리 보고", kind: "task", text: "정리 보고", firedAt: iso(NOW - HOUR), state: "answered" }] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/history") return json({ target: "main", events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/harness") return json({ nodes: [] });
		return undefined;
	},
});
afterAll(() => schedHub.stop());

describe("예약한 일 › 지난 예약", () => {
	for (const [w, h] of [[390, 844], [1280, 760]] as const) {
		test(`no row of 지난 예약 leaves its · hanging at the end of a line at ${w}px`, async () => {
			const v = await schedHub.view({ width: w, height: h });
			await v.navigate(`${schedHub.origin}/#schedules`);
			const o = on(v);
			await o.waitFor(`current === "schedules" && document.querySelectorAll("#schedules [data-past]").length === 2`);
			const dangling = await o.ev<{ name: string; line: string; hanging: boolean }[]>(`[...document.querySelectorAll("#schedules [data-past] .sup")].map(sup => {
				const walk = document.createTreeWalker(sup, NodeFilter.SHOW_TEXT), chars = [];
				for (let t; (t = walk.nextNode());) for (let i = 0; i < t.data.length; i++) { if (/\\S/.test(t.data[i])) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getBoundingClientRect(); chars.push({ c: t.data[i], top: Math.round(b.top) }); } }
				const hanging = chars.some((x, i) => x.c === "·" && chars[i + 1] && chars[i + 1].top > x.top + 4);
				return { name: sup.parentElement.querySelector(".hd").textContent, line: sup.textContent, hanging };
			})`);
			expect(dangling.map(d => d.hanging)).toEqual([false, false]);
			expect(dangling.map(d => d.line)).toEqual([expect.stringMatching(/^작업 · .+ 실행 · 결과를 올렸어요$/), expect.stringMatching(/^알림 · .+ 실행 · 결과를 올렸어요$/)]);
			if (SHOTS) await Bun.write(join(SHOTS, `schedule-past-${w}.png`), await v.screenshot());
			schedHub.release();
		}, 30_000);
	}
});

const remindHub = (() => {
	const row = (id: string, m: number, o: Record<string, unknown>) => ({ id, cls: "news", kind: "watch", tone: "", text: "", open: "main", src: "main", at: iso(NOW - m * 60_000), ts: iso(NOW - m * 60_000), updated: iso(NOW - m * 60_000), read: false, ...o });
	const items = [
		row("same", 10, { title: "sample-3 회의 알림", text: "sample-3 회의 알림", key: "schedule:r2" }),
		row("said", 20, { title: "sample-4 서류 알림", text: "서류를 내라고 알려 줘. 오늘까지예요", key: "schedule:r3" }),
		row("run", 30, { title: "sample-2 일일 보고", text: "어제는 요청이 없었어요", key: "schedule:r1", nk: "schedule", cls: "result" }),
	];
	return fakeHub({
		state: () => idleState({ notices_unread: 3 }),
		api: (req, url) => {
			const p = url.pathname;
			if (p === "/api/history") return json({ target: "main", events: [] });
			if (p === "/api/activity") return json({ items: [], more: false, history: false });
			if (p === "/api/conversations") return json({ items: [] });
			if (p === "/api/notices" && req.method === "GET") return json({ items, unread: 3, gone: [] });
			return undefined;
		},
	});
})();
afterAll(() => remindHub.stop());

describe("알림 화면의 예약 알림 줄", () => {
	for (const [w, h] of [[390, 844], [1280, 760]] as const) {
		test(`a reminder's second line is its text's first sentence, or 알림 예약 when it has none, at ${w}px`, async () => {
			const v = await remindHub.view({ width: w, height: h });
			await v.navigate(`${remindHub.origin}/#notices`);
			const o = on(v);
			await o.waitFor(`typeof NT !== "undefined" && NT.loaded && current === "notices" && document.querySelector('#v-notices .nsc-r[data-nid="run"]')`);
			const second = (id: string) => o.ev<string>(`document.querySelector('#v-notices .nsc-r[data-nid="${id}"] .nsc-s').textContent`);
			expect(await second("same")).toBe("알림 예약");
			expect(await second("said")).toBe("서류를 내라고 알려 줘");
			expect(await second("run")).toBe("어제는 요청이 없었어요");
			if (SHOTS) await Bun.write(join(SHOTS, `notices-remind-${w}.png`), await v.screenshot());
			remindHub.release();
		}, 30_000);
	}
});
