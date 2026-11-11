import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// The 작업내역 conversation in a headless browser: a day's posts as the rows of ONE list card (web/js/11-worklog.js), the owner's message and the
// answer to it as bubbles that split the card, the kinds and states the hub names (`wk` / `wst`) and the fallback of an event without them.
const iso = (day: number, h: number, m = 0) => `2026-11-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const post = (ts: string, text: string, extra: object = {}) => ({ ts, kind: "out", source: "gateway", target: "worklog", text, ...extra });
const sess = (ts: string, key: string, text: string, extra: object = {}) => post(ts, text, { source: "orchestrator", update_key: key, ...extra });
const LONG = "예약 점검을 마쳤고 바뀐 것은 하나도 없었으며 다음 점검도 같은 시각에 그대로 이어서 돌아가도록 두었어요 그래서 따로 할 일은 없어요";
const ONE_SENTENCE = "메일함 앱의 로그인 화면과 목록 화면과 상세 화면과 설정 화면을 모두 같은 틀로 다시 맞추는 일을 끝냈고 시험도 모두 통과했어요";

const EVENTS = [
	// day 8: 12 posts
	sess(iso(8, 1), "lane:alpha", "[done] 확인됨 · ✅ 메신저 로그인 연결을 끝냈어요.", { wk: "session", wst: "done" }),
	sess(iso(8, 2), "lane:beta", "[run] 메일함 앱을 만드는 중이에요. 화면을 먼저 그렸어요.\n- 목록\n- 상세", { wk: "session", wst: "run" }),
	post(iso(8, 3), "예약 점검: 바뀐 게 없어요", { wk: "check" }),
	post(iso(8, 4), "예약 점검: 메일을 가져오지 못했어요.", { wk: "check", wst: "fail" }),
	post(iso(8, 5), "하네스를 최신으로 올렸어요. 새 기능 두 개가 들어왔어요.", { wk: "update" }),
	sess(iso(8, 6), "lane:gamma", "[ask] 어느 계정으로 보낼지 알려 주세요.", { wk: "session", wst: "ask" }),
	{ ts: iso(8, 7), kind: "message", source: "web", target: "worklog", mid: "m1", text: "어제 작업 정리해 줘" },
	{ ts: iso(8, 7, 1), kind: "out", source: "orchestrator", target: "worklog", reply_to: "m1", text: "어제는 세 가지를 끝냈어요." },
	post(iso(8, 8), "야간 정리: 오래된 기록을 치웠어요.", { source: "orchestrator", wk: "night" }),
	post(iso(8, 9), "계정을 갈아탔어요.", { wk: "account" }),
	post(iso(8, 10), "게이트웨이 상태가 좋아요.", { wk: "system" }),
	post(iso(8, 11), "오늘 일은 여기까지 정리했어요", { source: "orchestrator", wk: "note" }),
	// day 9: 10 posts; the last ones carry no wk / wst (an older hub)
	post(iso(9, 1), LONG, { wk: "check" }),
	post(iso(9, 2), ONE_SENTENCE, { source: "orchestrator", wk: "note" }),
	sess(iso(9, 3), "lane:delta", "[done] 확인됨 · 설정 화면을 끝냈어요. 시험도 통과했어요.", { wk: "session", wst: "done" }),
	post(iso(9, 4), "예약 점검: 바뀐 게 없어요", { wk: "check" }),
	post(iso(9, 5), "하네스 업데이트를 끝냈어요.", { wk: "update" }),
	post(iso(9, 6), "계정 전환을 끝냈어요.", { wk: "account" }),
	sess(iso(9, 7), "lane:eps", "[fail] 빌드가 깨졌어요.\n로그는 아래에 있어요."),
	post(iso(9, 8), "게이트웨이가 알려 드려요."),
	post(iso(9, 9), "비서가 남긴 기록이에요.", { source: "orchestrator" }),
	sess(iso(9, 10), "lane:zeta", "[run] 목록 화면을 그리는 중이에요."),
	// day 10: 8 posts
	post(iso(10, 1), "예약 점검: 바뀐 게 없어요", { wk: "check" }),
	post(iso(10, 2), "예약 점검: 바뀐 게 없어요", { wk: "check" }),
	post(iso(10, 3), "업데이트를 확인했어요.", { wk: "update" }),
	sess(iso(10, 4), "lane:eta", "[done] 보고됨 · 정리를 끝냈어요.", { wk: "session", wst: "done" }),
	post(iso(10, 5), "야간 정리: 기록 열두 줄을 치웠어요.", { source: "orchestrator", wk: "night" }),
	post(iso(10, 6), "시스템이 다시 켜졌어요.", { wk: "system" }),
	post(iso(10, 7), "오늘 첫 기록이에요.", { source: "orchestrator", wk: "note" }),
	sess(iso(10, 8), "lane:theta", "[wait] 답을 기다려요.", { wk: "session", wst: "wait" }),
];

const notice = (id: string, e: (typeof EVENTS)[number], extra: object = {}) => ({ id, ts: e.ts, at: e.ts, updated: e.ts, kind: "worklog", tone: "", title: "작업 기록", text: e.text, open: "worklog", read: true, ...extra });
const NOTICES = [
	notice("n1", EVENTS[0]!, { tone: "done", key: "lane:alpha", wk: "session", wst: "done", text: "메신저 로그인 연결을 끝냈어요." }),
	notice("n2", EVENTS[4]!, { wk: "update" }),
	notice("n3", EVENTS[18]!, { tone: "fail", key: "lane:eps", wk: "session", wst: "fail", text: "빌드가 깨졌어요.\n로그는 아래에 있어요." }),
];

const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "worklog" ? EVENTS : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: NOTICES });
	},
});
afterAll(() => hub.stop());

type Row = { ts: string; wk: string; wst: string | null; role: string | null; tabindex: string | null; expanded: string | null; dot: string | null; tags: string[]; src: string; title: string; titleLines: number; cls: string; h: number; sumClipped: boolean; qClipped: boolean; sameLine: boolean };
const rowsOf = `[...document.querySelectorAll("#tl .wl-row")].map(r => {
	const dot = r.querySelector(".rc-hd > .nt-dot"), sum = r.querySelector(".fr-sum"), q = r.querySelector(".wl-q"), src = r.querySelector(".rc-src"), time = r.querySelector(".rc-time");
	const lh = parseFloat(getComputedStyle(sum || q || r).lineHeight) || 20;
	return { ts: r.dataset.ts, wk: r.dataset.wk, wst: r.dataset.wst || null, role: r.getAttribute("role"), tabindex: r.getAttribute("tabindex"), expanded: r.getAttribute("aria-expanded"),
		dot: dot ? dot.className : null, tags: [...r.querySelectorAll(".rc-hd > .tag")].map(t => t.textContent), src: src ? src.textContent : "",
		title: (sum || q || {}).textContent || "", titleLines: sum ? Math.round(sum.getBoundingClientRect().height / lh) : 1, cls: r.className, h: r.getBoundingClientRect().height,
		sumClipped: !!sum && sum.scrollWidth > sum.clientWidth, qClipped: !!q && q.scrollWidth > q.clientWidth,
		sameLine: !!q && Math.abs(src.getBoundingClientRect().top - q.getBoundingClientRect().top) < 6 && Math.abs(q.getBoundingClientRect().top - time.getBoundingClientRect().top) < 6 };
})`;
const shapeOf = `[...document.querySelector("#tl").children].filter(n => !n.hidden && n.id !== "tl-top").map(n => n.classList.contains("wl-list") ? "list:" + n.querySelectorAll(":scope > .wl-row").length : n.classList.contains("a-div") ? "day" : n.classList.contains("um") ? "owner" : n.classList.contains("bm") ? "bubble" : n.className)`;

for (const width of [390, 1280]) {
	const view = await hub.view({ width, height: 900 });
	const { waitFor } = on(view);
	const page = async <T>(expr: string) => (await view.evaluate(`JSON.stringify(${expr})`).then(s => JSON.parse(s as string))) as T;

	test(`${width}px: a day's posts are the rows of one list card, the owner's message and its answer split it`, async () => {
		await view.navigate(`${hub.origin}/`);
		await waitFor(`typeof openTarget === "function" && S`);
		await view.evaluate(`(openTarget("worklog", "chat"), 0)`);
		await waitFor(`document.querySelectorAll("#tl .wl-row").length === 28`);
		expect(await page<string[]>(shapeOf)).toEqual(["day", "list:6", "owner", "bubble", "list:4", "day", "list:10", "day", "list:8"]);
		// every row sits in a list card of its own day, newest at the bottom
		const days = await page<string[][]>(`[...document.querySelectorAll("#tl .wl-list")].map(l => [...l.children].map(r => r.dataset.ts.slice(0, 10)))`);
		expect(days.map(d => new Set(d).size)).toEqual([1, 1, 1, 1]);
		expect(days.map(d => d[0])).toEqual(["2026-11-08", "2026-11-08", "2026-11-09", "2026-11-10"]);
		expect(await page<number>(`document.querySelectorAll("#tl > .a-div").length`)).toBe(3);
		// the owner's message and the answer stay bubbles, never a row
		expect(await page<number>(`document.querySelectorAll("#tl .wl-row .um, #tl .wl-row .mn").length`)).toBe(0);
		expect(await page<number>(`document.querySelectorAll("#tl > .um").length`)).toBe(1);
	});

	test(`${width}px: kinds, state dot and tag, a title without the mark and the claim word`, async () => {
		const rows = await page<Row[]>(rowsOf);
		const by = (ts: string) => rows.find(r => r.ts === ts)!;
		const done = by(EVENTS[0]!.ts);
		expect(done.wk).toBe("session");
		expect(done.src).toBe("세션 · alpha");
		expect([done.wst, done.dot]).toEqual(["done", null]);   // the state is said once, by its tag: no second dot before the label
		expect(done.tags).toEqual(["완료", "확인됨"]);
		expect(done.title).toBe("메신저 로그인 연결을 끝냈어요");
		expect(done.role).toBeNull();
		expect(rows.some(r => /\[(done|run|wait|ask|fail)\]|확인됨 ·|보고됨 ·/.test(r.title))).toBe(false);
		expect(by(EVENTS[1]!.ts).wst).toBe("run");
		expect(by(EVENTS[1]!.ts).tags).toEqual(["진행 중"]);
		expect(by(EVENTS[5]!.ts).wst).toBe("ask");
		expect(by(EVENTS[3]!.ts).wst).toBe("fail");
		expect(by(EVENTS[3]!.ts).tags).toEqual(["실패"]);
		// the label of every kind, and no empty slot for a row without a state
		const labels = Object.fromEntries(rows.filter(r => !r.ts.startsWith("2026-11-09T0") || r.wk !== "session").map(r => [r.wk, r.src.startsWith("세션") ? "세션" : r.src]));
		expect(labels).toMatchObject({ session: "세션", check: "예약 점검", night: "야간 정리", update: "업데이트", account: "계정", system: "시스템" });
		// a note with no state and no claim has no head line of its own: its title stands beside the time, and no label is drawn
		const note = by(EVENTS[11]!.ts);
		expect([note.src, note.cls.includes("wl-plain"), note.title]).toEqual(["", true, "오늘 일은 여기까지 정리했어요"]);
		// a title never repeats the label it stands under
		expect(by(EVENTS[8]!.ts).title).toBe("오래된 기록을 치웠어요");
		const plain = by(EVENTS[4]!.ts);
		expect(plain.dot).toBeNull();
		expect(plain.tags).toEqual([]);
	});

	test(`${width}px: an event without wk / wst falls back to the update_key and the mark`, async () => {
		const rows = await page<Row[]>(rowsOf);
		const by = (ts: string) => rows.find(r => r.ts === ts)!;
		const fail = by(iso(9, 7));
		expect([fail.wk, fail.src, fail.wst, fail.tags]).toEqual(["session", "세션 · eps", "fail", ["실패"]]);
		const run = by(iso(9, 10));
		expect([run.wk, run.wst, run.tags]).toEqual(["session", "run", ["진행 중"]]);
		expect(by(iso(9, 8)).wk).toBe("system");
		expect(by(iso(9, 9)).wk).toBe("note");
		expect(by(iso(9, 8)).wst).toBeNull();
	});

	test(`${width}px: a row is a button only when unfolding shows more; the title is one line`, async () => {
		const rows = await page<Row[]>(rowsOf);
		const by = (ts: string) => rows.find(r => r.ts === ts)!;
		for (const r of rows) {
			const button = r.role === "button";
			expect(r.tabindex !== null).toBe(button);
			expect(r.expanded !== null).toBe(button);
			expect(r.cls.includes("fr-all")).toBe(!button);
			if (button && !r.cls.includes("wl-quiet")) expect(r.titleLines).toBe(1);
		}
		// more sentences / lines / a list: a button
		for (const ts of [EVENTS[1]!.ts, EVENTS[4]!.ts, iso(9, 3), iso(9, 7)]) expect(by(ts).role).toBe("button");
		// whole on the row: not a button, and a long title wraps instead of clipping
		for (const ts of [EVENTS[0]!.ts, EVENTS[5]!.ts, EVENTS[11]!.ts, iso(10, 4)]) expect(by(ts).role).toBeNull();
		const wide = by(iso(9, 2));
		expect(wide.role).toBeNull();
		expect(wide.sumClipped).toBe(false);
		expect(wide.titleLines).toBeGreaterThan(1);
		if (width === 390) {
			for (const r of rows.filter(x => x.role === "button")) expect(r.h).toBeGreaterThanOrEqual(44);
		}
	});

	test(`${width}px: a quiet check is one line, a failing one is a full row`, async () => {
		const rows = await page<Row[]>(rowsOf);
		const quiet = rows.filter(r => r.cls.includes("wl-quiet"));
		expect(quiet.map(r => r.ts)).toEqual([EVENTS[2]!.ts, iso(9, 1), iso(9, 4), iso(10, 1), iso(10, 2)]);
		for (const q of quiet) {
			expect(q.sameLine).toBe(true);
			expect(q.dot).toBeNull();
			expect(q.tags).toEqual([]);
			// a button only when its text is clipped
			expect(q.role === "button").toBe(q.qClipped);
		}
		const full = rows.find(r => r.ts === EVENTS[2]!.ts)!;
		const failing = rows.find(r => r.ts === EVENTS[3]!.ts)!;
		expect(failing.cls.includes("wl-quiet")).toBe(false);
		expect(failing.h).toBeGreaterThan(full.h);
		if (width === 390) expect(rows.find(r => r.ts === iso(9, 1))!.role).toBe("button");
	});

	test(`${width}px: unfolding shows the whole message with 접기 and folds back in place`, async () => {
		const before = await page<string[]>(shapeOf);
		const at = EVENTS[1]!.ts;
		await view.evaluate(`document.querySelector('#tl .wl-row[data-ts="${at}"]').click()`);
		await waitFor(`document.querySelector('#tl .wl-row[data-ts="${at}"]').classList.contains("fr-open")`);
		const open = await page<{ list: number; idx: number; md: number; items: number; fold: string; role: string | null; hasSum: boolean }>(`(() => {
			const r = document.querySelector('#tl .wl-row[data-ts="${at}"]'), l = r.parentElement;
			return { list: [...document.querySelectorAll("#tl .wl-list")].indexOf(l), idx: [...l.children].indexOf(r), md: r.querySelectorAll(".md").length, items: r.querySelectorAll("li").length, fold: r.querySelector(".cc-act .btn").textContent, role: r.getAttribute("role"), hasSum: !!r.querySelector(".fr-sum") };
		})()`);
		expect(open).toEqual({ list: 0, idx: 1, md: 1, items: 2, fold: "접기", role: null, hasSum: false });
		expect(await page<string[]>(shapeOf)).toEqual(before);
		await view.evaluate(`document.querySelector('#tl .wl-row[data-ts="${at}"] .cc-act .btn').click()`);
		await waitFor(`!document.querySelector('#tl .wl-row[data-ts="${at}"]').classList.contains("fr-open")`);
		const shut = await page<{ idx: number; role: string | null; title: string }>(`(() => { const r = document.querySelector('#tl .wl-row[data-ts="${at}"]'); return { idx: [...r.parentElement.children].indexOf(r), role: r.getAttribute("role"), title: r.querySelector(".fr-sum").textContent }; })()`);
		expect(shut).toEqual({ idx: 1, role: "button", title: "메일함 앱을 만드는 중이에요" });
		expect(await page<string[]>(shapeOf)).toEqual(before);
	});

	test(`${width}px: no horizontal overflow`, async () => {
		const over = await page<{ page: number; rows: number }>(`(() => {
			const w = document.documentElement.clientWidth, tl = document.querySelector("#timeline").getBoundingClientRect();
			return { page: document.documentElement.scrollWidth - w, rows: [...document.querySelectorAll("#tl .wl-row")].filter(r => { const b = r.getBoundingClientRect(); return b.right > tl.right + 1 || b.left < tl.left - 1 || r.scrollWidth > r.clientWidth + 1; }).length };
		})()`);
		expect(over).toEqual({ page: 0, rows: 0 });
	});

	test(`${width}px: a live post joins the day's card, an edited session line replaces its row, older history keeps the grouping`, async () => {
		await hub.streamConnected();
		const before = await page<string[]>(shapeOf);
		hub.push(post(iso(10, 9), "새 점검 기록이에요.", { wk: "note", source: "orchestrator" }));
		await waitFor(`document.querySelector('#tl .wl-row[data-ts="${iso(10, 9)}"]')`);
		expect(await page<string[]>(shapeOf)).toEqual([...before.slice(0, -1), "list:9"]);
		// beta was edited in place: the day-8 row goes, the newest version is the last row of the last card
		hub.push(sess(iso(10, 10), "lane:beta", "[done] 메일함 앱을 끝냈어요.", { wk: "session", wst: "done" }));
		await waitFor(`document.querySelector('#tl .wl-row[data-ts="${iso(10, 10)}"]')`);
		const got = await page<{ shape: string[]; beta: string[]; last: string | null }>(`({ shape: ${shapeOf}, beta: [...document.querySelectorAll("#tl .wl-row")].filter(r => (r.querySelector(".rc-src") || {}).textContent === "세션 · beta").map(r => r.dataset.wst), last: document.querySelector("#tl .wl-list:last-of-type > .wl-row:last-child").dataset.ts })`);
		expect(got.shape).toEqual(["day", "list:5", "owner", "bubble", "list:4", "day", "list:10", "day", "list:10"]);
		expect(got.beta).toEqual(["done"]);
		expect(got.last).toBe(iso(10, 10));
		// the whole conversation drawn again (older history scrolled in) groups the same way
		await view.evaluate(`(renderAll(true), 0)`);
		await waitFor(`document.querySelectorAll("#tl .wl-row").length === 29`);
		expect(await page<string[]>(shapeOf)).toEqual(got.shape);
	});

	test(`${width}px: 홈's 작업내역 card has the same dot class and title as the conversation's row`, async () => {
		const rows = await page<Row[]>(rowsOf);
		await view.evaluate(`(go("home"), 0)`);
		await waitFor(`document.querySelectorAll("#v-home .hc-list[data-cap=worklog] .hc-row").length === ${NOTICES.length}`);
		const home = await page<{ dot: string; title: string }[]>(`[...document.querySelectorAll("#v-home .hc-list[data-cap=worklog] .hc-row")].map(r => ({ dot: r.querySelector(".nt-dot").className, title: r.querySelector(".t").textContent }))`);
		const conv = [EVENTS[18]!.ts, EVENTS[4]!.ts, EVENTS[0]!.ts].map(ts => rows.find(r => r.ts === ts)!);
		expect(home.map(h => h.title)).toEqual(conv.map(r => r.title));
		expect(home.map(h => h.dot.replace(/ tone-none/, ""))).toEqual(conv.map(r => (r.wst ? `nt-dot tone-${r.wst}` : "nt-dot")));
	});
}
