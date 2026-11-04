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
	Object.assign(S, { orchestrator: { status: "idle" }, lanes: [], work: [], runs: {}, convs: [], deferred: [] }, ${JSON.stringify(s)});
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
	expect(await tone("r")).toBe("대기|");
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
	Object.assign(S, { orchestrator: { status: "idle" }, runs: {}, convs: [], deferred: [], lanes: ids.map(i => ({ name: "ask" + i, status: "idle", live: true, pendingAsk: { text: "어떻게 할까요?" } })),
		work: ids.flatMap(i => [{ id: "r" + i, description: "맡긴 일", status: "running", target: "web", started_at: 1 }, { id: "d" + i, description: "끝난 일", status: "done", target: "web", started_at: 1, ended_at: 2 }]) });
	monItems = () => ids.map(i => ({ app: true, key: "a" + i, name: "앱 " + i, unreplied: 1 }));
	NT.items = ids.flatMap(i => [{ id: "n" + i, kind: "alert", cls: "alert", title: "알림 " + i, text: "알림", ts: at }, { id: "l" + i, kind: "worklog", title: "기록 " + i, text: "기록", ts: at }]);
	NM.items = ids.map(i => ({ name: "감시 " + i, last_run: at, next_run: at }));
	C = { processes: ids.map(i => ({ name: "p" + i, running: true, percent: 10, kind: "lane" })) };
	HQ = { providers: [{ provider: "anthropic", limits: ids.map(i => ({ id: "l" + i, label: "한도 " + i, limit: 100, used: 10 })) }] };
	P = { providers: ids.map(i => ({ id: "g" + i, name: "공급자 " + i, auth: "api_key" })) };
	renderHomeNow();
})(${n})`);
const LISTS = ["needs", "replies", "running", "waiting", "ended-work", "alert", "worklog", "watch", "group:limit", "group:ctx", "group:prov"];
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
