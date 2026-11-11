import { afterAll, expect, test } from "bun:test";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// The home greeting and the state dots, in a headless page: the greeting's word follows 지금 진행 중 (homeRunning, 08-home.js), and a row's dot
// and word come from one verdict (runStatus, 41-runstate.js), so neither can disagree. State is forced into S the way a refresh sets it.
const hub = fakeHub({
	state: idleState(),
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view();
afterAll(() => hub.stop());
const { waitFor } = on(view);
await view.navigate(`${hub.origin}/`);
await waitFor(`typeof NT !== "undefined" && NT.loaded && S && current === "home" && $("#home-now .hgreet .meta")`);

const lane = (name: string, status: string, more = {}) => ({ name, status, live: true, ...more });
const work = (status: string, more = {}) => ({ id: "w1", description: "맡긴 일", status, target: "web", ...more });
const greet = async (s: object) => JSON.parse(await view.evaluate(`(() => {
	Object.assign(S, { orchestrator: { status: "idle" }, lanes: [], work: [], runs: {}, convs: [], waitlist: [] }, ${JSON.stringify(s)});
	renderHomeNow();
	return JSON.stringify({ word: document.querySelector("#home-now .hgreet .meta").textContent.split(" · ")[0].replace(/^\\S+ /, "") });
})()`) as string) as { word: string };

test.each([
	["nothing runs", {}, "쉬는 중"],
	["the main turn", { orchestrator: { status: "working" } }, "일하는 중"],
	["a session works while main rests", { lanes: [lane("a", "working")], runs: { "lane:a": { kind: "working" } } }, "일하는 중"],
	["a background worker", { work: [work("running")] }, "일하는 중"],
	["main waits on its own subagent", { runs: { main: { kind: "waiting", reason: "child" } } }, "일하는 중"],
	["main folds its context while idle", { runs: { main: { kind: "working", detail: "대화 정리 중" } } }, "일하는 중"],
	["a mail conversation's session", { convs: [{ target: "mail:k1", work: [] }], runs: { "mail:k1": { kind: "working" } } }, "일하는 중"],
	["only the owner's answer is awaited", { runs: { main: { kind: "waiting", reason: "ask" } } }, "답을 기다려요"],
	["a session asks while main rests", { lanes: [lane("a", "idle", { pendingAsk: { text: "어떻게 할까요?" } })] }, "답을 기다려요"],
	["running outranks a question", { lanes: [lane("a", "working"), lane("b", "idle", { pendingAsk: { text: "?" } })] }, "일하는 중"],
	["limited", { orchestrator: { status: "rate-limited" }, runs: { main: { kind: "limited" } } }, "한도 걸림"],
	["failed", { runs: { main: { kind: "error" } } }, "오류로 멈췄어요"],
	["a failure the owner stopped", { runs: { main: { kind: "error", cancelled: true } } }, "쉬는 중"],
	["a handled failure", { work: [work("failed", { handled: true })] }, "쉬는 중"],
])("greeting: %s", async (_name, s, word) => {
	expect((await greet(s)).word).toBe(word);
});

test("one verdict gives a session's dot and word, each tone with its own word", async () => {
	await greet({ lanes: [lane("w", "working"), lane("h", "idle"), lane("q", "idle", { pendingAsk: { text: "?" } }), lane("l", "rate-limited"), lane("e", "idle"), lane("r", "idle")],
		runs: { "lane:h": { kind: "waiting", reason: "work" }, "lane:e": { kind: "error" }, "lane:r": { kind: "done" } } });
	const tone = (n: string) => view.evaluate(`sessionStatus(S.lanes.find(l => l.name === "${n}")).join("|")`);
	expect(await tone("w")).toBe("작업 중|pri");
	expect(await tone("h")).toBe("진행 중|pri");
	expect(await tone("q")).toBe("답을 기다려요|warn");
	expect(await tone("l")).toBe("한도 걸림|warn");
	expect(await tone("e")).toBe("오류|err");
	expect(await tone("r")).toBe("끝남|");
	expect(await view.evaluate(`sessionStatus({ name: "x", status: "exited", live: false }).join("|")`)).toBe("끝남|");
});

test("a project and its session row agree that handed-off work is progressing", async () => {
	await greet({ lanes: [lane("h", "idle")], runs: { "lane:h": { kind: "waiting", reason: "work" } } });
	expect(await view.evaluate(`(s => s.tone + "|" + s.word)(prjState({ lanes: [{ name: "h", status: "idle", live: true }] }))`)).toBe("pri|진행 중");
});

test("a background task has one colour on every list", async () => {
	const t = (w: object) => view.evaluate(`workTone(${JSON.stringify(w)})`);
	expect(await t(work("running"))).toBe("pri");
	expect(await t(work("failed"))).toBe("pri");
	expect(await t(work("stalled"))).toBe("warn");
	expect(await t(work("done"))).toBe("ok");
	expect(await t(work("failed", { handled: true }))).toBe("");
	expect(await t(work("failed", { cancelled: true }))).toBe("");
});

test("an empty list's one line is not clipped by the list's rounded corner and starts under the head", async () => {
	await greet({});
	const got = JSON.parse(await view.evaluate(`JSON.stringify([...document.querySelectorAll('#v-home .hn:has(> .hc-none)')].map(l => ({ k: l.dataset.k, overflow: getComputedStyle(l).overflow, off: l.querySelector('.hc-none').getBoundingClientRect().left - l.closest('.card, .hneeds').querySelector('.ch, h2').getBoundingClientRect().left })))`) as string) as { k: string; overflow: string; off: number }[];
	// 할일 and 알림 have nothing to say, so their cards are not drawn; 답변 필요 and 지금 진행 중 keep their one line
	expect(got.map(l => l.k).sort()).toEqual(["needs", "running"]);
	for (const l of got) expect(l).toMatchObject({ overflow: "visible", off: 0 });
});

const cards = async () => JSON.parse(await view.evaluate(`JSON.stringify([...document.querySelectorAll("#home-cards .bi")].map(b => b.dataset.id))`) as string) as string[];

test("a loaded, empty 할일 and 알림 are not in the page; a card that is still loading or failed, and every card while one is moved, are", async () => {
	await greet({});
	expect(await cards()).not.toContain("now:todo");
	expect(await cards()).not.toContain("notices:alert");
	expect(await cards()).toContain("now:running");
	await view.evaluate(`(() => { homeEdit = true; renderHomeNow(); })()`);
	expect(await cards()).toEqual(expect.arrayContaining(["now:todo", "notices:alert"]));
	await view.evaluate(`(() => { homeEdit = false; S.seeded = true; renderHomeNow(); })()`);
	expect(await cards()).toContain("now:todo");
	await view.evaluate(`(() => { S.seeded = false; NT.loaded = false; NT.failed = true; renderHomeNow(); })()`);
	expect(await cards()).toContain("notices:alert");
	expect(await view.evaluate(`document.querySelector('.bi[data-id="notices:alert"] .hc-none').textContent`)).toBe("불러오지 못했어요");
	await view.evaluate(`(() => { NT.loaded = true; NT.failed = false; renderHomeNow(); })()`);
	expect(await cards()).not.toContain("notices:alert");
});

test("a login that dropped is the first row of 답변 필요 once: no strip above, no dot, the word 다시 로그인, and not again in 알림", async () => {
	await greet({});
	await view.evaluate(`(() => { const ts = new Date().toISOString(); NT.items = [
		{ id: "login1", kind: "alert", cls: "alert", tone: "fail", waits: "login", title: "인스타그램 로그인이 풀렸어요", text: "인스타그램 로그인이 풀렸어요", ts },
		{ id: "news1", kind: "alert", cls: "alert", title: "새 소식", text: "새 소식", ts }]; renderHomeNow(); })()`);
	const got = JSON.parse(await view.evaluate(`(() => { const l = document.querySelector('#v-home [data-k="needs"]'), r = l.firstElementChild;
		return JSON.stringify({ strip: [...document.querySelectorAll(".hstrip")].some(e => e.textContent.includes("로그인이 풀렸어요")), nm: r.querySelector(".nm").textContent, ha: r.querySelector(".ha").textContent, hs: r.querySelector(".hs").textContent, dots: l.querySelectorAll(".dot").length,
			once: (document.querySelector("#v-home").textContent.match(/로그인이 풀렸어요/g) || []).length, sup: document.querySelector("#home-now .hneeds-h .sup").textContent,
			alert: [...document.querySelectorAll('.bi[data-id="notices:alert"] .hc-row')].map(e => e.textContent) }); })()`) as string);
	expect(got).toMatchObject({ strip: false, nm: "인스타그램 로그인이 풀렸어요", hs: "다시 로그인", dots: 0, once: 1, sup: "1" });
	expect(got.ha.startsWith("인스타그램 · ")).toBe(true);
	expect(got.alert).toHaveLength(1);
	expect(got.alert[0]).toContain("새 소식");
	// read but still waiting on the login (the hub's waits): the row stays until the login is back
	await view.evaluate(`(NT.items[0].read = true, renderHomeNow(), 0)`);
	expect(await view.evaluate(`document.querySelector('#v-home [data-k="needs"]').firstElementChild.querySelector(".hs").textContent`)).toBe("다시 로그인");
	await view.evaluate(`(NT.items = [], renderHomeNow(), 0)`);
});

test("the drafts to check and the comments not answered are two closing rows of 답변 필요, each with its count per source; a count of 0 is no row", async () => {
	await greet({});
	const set = (drafts: object[], owed: object[]) => view.evaluate(`(() => { window.keep ||= [rqRows, monItems]; rqRows = () => ${JSON.stringify(drafts)}; monItems = () => ${JSON.stringify(owed)}; renderHomeNow(); })()`);
	try {
	await set([{ app: "메일", state: "open" }, { app: "유튜브", state: "open" }], [{ app: true, key: "yt", name: "유튜브", unreplied: 5 }, { app: true, key: "ig", name: "인스타그램", unreplied: 3 }, { app: true, key: "web", name: "웹사이트", unreplied: 1 }]);
	const rowOf = (k: string) => view.evaluate(`(r => [r.querySelector(".nm").textContent, r.querySelector(".ha").textContent, r.querySelector(".nb").textContent])(document.querySelector('#v-home .hr[data-k="${k}"]'))`);
	expect(await rowOf("replies")).toEqual(["답장 초안 확인", "메일 1 · 유튜브 1", "2"]);
	expect(await rowOf("owed")).toEqual(["답 안 한 댓글", "유튜브 5 · 인스타그램 3 · 웹사이트 1", "9"]);
	expect(await view.evaluate(`[...document.querySelector('#v-home [data-k="needs"]').children].map(r => r.dataset.k).join()`)).toBe("replies,owed");
	expect(await view.evaluate(`document.querySelector("#home-now .hneeds-h .sup").textContent`)).toBe("2");
	expect(await view.evaluate(`!!document.querySelector("#v-home .hn-h.hsub")`)).toBe(false);
	await set([], []);
	expect(await view.evaluate(`document.querySelectorAll('#v-home .hr[data-k="replies"], #v-home .hr[data-k="owed"]').length`)).toBe(0);
	} finally {
		await view.evaluate(`([rqRows, monItems] = window.keep, renderHomeNow(), 0)`);
	}
});

test("지금 진행 중 stops at six rows, scrolls inside its card and keeps its place across a refresh", async () => {
	const rows = (n: number) => ({ work: Array.from({ length: n }, (_, i) => work("running", { id: `w${i}`, started_at: 1 })) });
	const box = async () => JSON.parse(await view.evaluate(`(l => JSON.stringify({ n: l.children.length, client: l.clientHeight, scroll: l.scrollHeight, row: l.lastElementChild.offsetHeight, y: getComputedStyle(l).overflowY, bar: getComputedStyle(l).scrollbarWidth, over: getComputedStyle(l).overscrollBehaviorY }))(document.querySelector('#v-home [data-k="running"]'))`) as string) as { n: number; client: number; scroll: number; row: number; y: string; bar: string; over: string };
	await greet(rows(6));
	const six = await box();
	expect([six.y, six.scroll]).toEqual(["hidden", six.client]);
	await greet(rows(8));
	const eight = await box();
	expect(eight.client).toBe(six.client);
	expect(eight.scroll).toBe(six.client + 2 * eight.row);
	expect([eight.y, eight.bar, eight.over]).toEqual(["auto", "none", "contain"]);
	await view.evaluate(`(() => { const l = document.querySelector('#v-home [data-k="running"]'); l.scrollTop = 40; l.querySelectorAll("button")[7].focus({ preventScroll: true }); l.scrollTop = 40; S.work = S.work.map(w => ({ ...w, model: "다른 모델" })); renderHomeNow(); })()`);
	expect(await view.evaluate(`(l => [l.scrollTop, [...l.querySelectorAll("button")].indexOf(document.activeElement), l.textContent.includes("다른 모델")].join("|"))(document.querySelector('#v-home [data-k="running"]'))`)).toBe("40|7|true");
});

// Every list of the home cards, filled with n rows through the state the page really reads; a custom card's list is in custom-home-web.test.ts.
const fill = (n: number) => view.evaluate(`(n => {
	const ids = Array.from({ length: n }, (_, i) => i), at = new Date().toISOString();
	Object.assign(S, { orchestrator: { status: "idle" }, runs: {}, convs: [], waitlist: ids.map(i => ({ id: "q" + i, kind: "worker", title: "받아둔 일" })), lanes: ids.flatMap(i => [{ name: "ask" + i, status: "idle", live: true, pendingAsk: { text: "어떻게 할까요?" } }, { name: "held" + i, status: "rate-limited", live: true }]),
		work: ids.map(i => ({ id: "d" + i, description: "끝난 일", status: "done", target: "web", started_at: 1, ended_at: 2 })) });
	monItems = () => ids.map(i => ({ app: true, key: "a" + i, name: "앱 " + i, unreplied: 1 }));
	NT.items = ids.flatMap(i => [{ id: "n" + i, kind: "alert", cls: "alert", title: "알림 " + i, text: "알림", ts: at }, { id: "l" + i, kind: "worklog", title: "기록 " + i, text: "기록", ts: at }]);
	NM.items = ids.map(i => ({ name: "감시 " + i, last_run: at, next_run: at }));
	C = { processes: ids.map(i => ({ name: "p" + i, running: true, percent: 10, kind: "lane" })) };
	HQ = { providers: [{ provider: "anthropic", limits: ids.map(i => ({ id: "l" + i, label: "한도 " + i, limit: 100, used: 10 })) }] };
	P = { providers: ids.map(i => ({ id: "g" + i, name: "공급자 " + i, auth: "api_key" })) };
	renderHomeNow();
})(${n})`);
const LISTS = ["needs", "todo", "running", "waiting", "ended-work", "alert", "worklog", "watch", "group:limit", "group:ctx", "group:prov"];
const cap = (key: string) => view.evaluate(`(l => JSON.stringify(l && { n: l.children.length, client: l.clientHeight, scroll: l.scrollHeight, six: l.children[5] ? l.children[5].offsetTop + l.children[5].offsetHeight : 0, y: getComputedStyle(l).overflowY, bar: getComputedStyle(l).scrollbarWidth, fade: getComputedStyle(l).maskImage.includes("linear-gradient"), over: getComputedStyle(l).overscrollBehaviorY, card: l.closest(".card, .hneeds").offsetHeight, inCard: !!l.closest("#v-home") }))(document.querySelector('#v-home [data-cap="${key}"]'))`).then(s => JSON.parse(s as string)) as Promise<{ n: number; client: number; scroll: number; six: number; y: string; bar: string; over: string; card: number; inCard: boolean } | null>;

test.each(LISTS)("%s holds every row, shows six and scrolls inside its card, and five rows stay as they are", async key => {
	await fill(8);
	const long = (await cap(key))!;
	expect(long.n).toBeGreaterThanOrEqual(8);
	expect(long.client).toBe(long.six);
	expect(long.scroll).toBeGreaterThan(long.client);
	expect([long.y, long.bar, long.over, long.fade]).toEqual(["auto", "none", "contain", true]);
	await fill(40);
	const longer = (await cap(key))!;
	expect(longer.n).toBeGreaterThanOrEqual(40);
	expect([longer.client, longer.card]).toEqual([long.client, long.card]);
	await fill(5);
	const short = (await cap(key))!;
	expect(short.y).not.toBe("auto");
	expect(short.scroll).toBe(short.client);
});

test("a long card keeps its height and leaves its neighbour's alone, a refresh keeps each list's place, and 모니터링 keeps its 더 보기", async () => {
	await fill(40);
	const worklog = (await cap("worklog"))!.card;
	await view.evaluate(`(NT.items = NT.items.filter(n => n.kind !== "worklog" || n.id === "l0"), renderHomeNow())`);
	expect((await cap("worklog"))).toBeTruthy();
	expect((await cap("worklog"))!.card).toBeLessThan(worklog);
	expect((await cap("alert"))!.card).toBe(worklog);
	expect(await view.evaluate(`document.querySelector(".hc-more").textContent`)).toBe("더 보기 · 34개");
	expect(await view.evaluate(`(() => { const l = document.querySelector('[data-cap="alert"]'), g = document.querySelector('[data-cap="group:prov"]'); l.scrollTop = 60; g.scrollTop = 30; l.querySelectorAll("[tabindex]")[9].focus({ preventScroll: true }); l.scrollTop = 60; renderHomeNow(); const a = document.querySelector('[data-cap="alert"]'); return [a.scrollTop, [...a.querySelectorAll("[tabindex]")].indexOf(document.activeElement), document.querySelector('[data-cap="group:prov"]').scrollTop, a === l].join("|"); })()`)).toBe("60|9|30|false");
});

test("at two cards to a row, a longer list leaves the neighbour's height where six rows put it", async () => {
	await view.resize(1280, 900);
	await waitFor(`!document.querySelector("#home-cards").classList.contains("narrow") && innerWidth === 1280`);
	await fill(8);
	// The height the board set on each slot, since a card's own height eases toward it.
	const slots = () => view.evaluate(`["alert", "running"].map(k => document.querySelector('[data-cap="' + k + '"]').closest("#home-cards > *").style.height).join("|")`);
	const six = await slots();
	await fill(40);
	expect(await slots()).toBe(six);
	await view.resize(390, 844);
});

test("배치 초기화 says what it did and 되돌리기 puts the order back", async () => {
	await greet({});
	const order = async () => JSON.parse(await view.evaluate(`JSON.stringify(homeBoard.order())`) as string) as string[];
	const press = (sel: string, label: string) => view.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent === ${JSON.stringify(label)}); b.click(); return !!document.querySelector(".snack.act"); })()`);
	await view.evaluate(`homeBoard.reset()`);
	const first = await order();
	await view.evaluate(`homeBoard.moveBefore(${JSON.stringify(first[first.length - 1])}, ${JSON.stringify(first[1])})`);
	const moved = await order();
	expect(moved).not.toEqual(first);
	expect(await press("#v-home button", "배치 초기화")).toBe(true);
	expect(await order()).toEqual(first);
	await press(".snack button", "되돌리기");
	expect(await order()).toEqual(moved);
	await view.evaluate(`homeBoard.reset()`);
});
