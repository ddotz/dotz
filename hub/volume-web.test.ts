import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Store, serve, until } from "./volume-fixture.ts";

// The lists at volume in a headless browser at 390px against hub/volume-fixture.ts (180+ notices, 100 projects with unread, sessions waiting):
// 감시 소식 puts what waits first and folds repeats (web/js/30-monitoring.js monFeedNodes), its views count right and 읽음 처리 never clears an
// ask; the chat list narrows to 답 필요 / 안 읽음, pages the projects and reads only what needs no answer (web/js/31-conversations.js convBar);
// on load the waiting questions are one card (web/js/09-needs-you.js toastAttn); the whole notice set is loaded (web/js/30-notices.js).
let store: Store, url = "", stop = () => {};
const view = new Bun.WebView({ width: 390, height: 844 });
beforeAll(() => { const s = serve(); store = s.store; url = s.url; stop = () => s.server.stop(true); });
afterAll(() => { view.close(); stop(); });
const wait = (cond: string, what: string) => view.evaluate(until(cond, what, 4000));   // gives up before the test's own 5 s
const ev = <T>(expr: string) => view.evaluate(expr) as Promise<T>;
// a fresh load each time: the test clock stands still, and a URL that differs only in its hash would not load again
let loads = 0;
// then two frames: the list repaints on the next frame after the last of its data (notices, state, conversations) arrived (convSchedule / monSchedule)
const open = async (hash: string, cond: string) => {
	await view.navigate(`${url}/?load=${++loads}${hash}`);
	await wait(cond, `${hash} not drawn`);
	await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
};
const feedReady = `current === "monitoring" && NT.loaded && NM.loaded && !!document.querySelector("#mon-tl .mon-bar")`;
const chatReady = `current === "chat" && CV.loaded && NT.loaded && !!S && S.lanes.length > 0 && !!document.querySelector("#chat-convo .cv-bar")`;

test("감시 소식 holds every report of the feed, what waits on top and each source folded with its count", async () => {
	await open("#monitoring/notice", feedReady);
	// the hub keeps 300; the feed's 100 reports are all there, not only the first 100 notices of every kind
	expect(await ev<number>(`monItems().find(i => i.key === "notice").notices.length`)).toBe(100);
	const tabs = await ev<string[]>(`[...document.querySelectorAll("#mon-tl .mon-tabs .mr-f")].map(b => b.textContent)`);
	expect(tabs).toEqual(["전체100", "답 필요3", "실패10"]);
	const heads = await ev<string[]>(`[...document.querySelectorAll("#mon-tl > .mon-sh")].map(n => n.textContent)`);
	expect(heads).toEqual(["답 필요", "실패", "소식"]);
	// the three identical stock questions are one row with the way to answer; the repeated reports one row per source
	const first = await ev<string>(`document.querySelector("#mon-tl > .bm.fr").textContent`);
	expect(first).toContain("재고 감시");
	expect(first).toContain("같은 질문 3번");
	expect(first).toContain("답하러 가기");
	expect(await ev<string>(`[...document.querySelectorAll("#mon-tl > .bm.fr")].find(r => r.textContent.includes("환율 감시")).querySelector(".fr-n").textContent`)).toBe("25건");
	expect(await ev<number>(`document.querySelectorAll("#mon-tl > .bm").length`)).toBeLessThan(15);
});

test("감시 소식's 실패 view lists only the failing source, and a folded source unfolds its reports a page at a time", async () => {
	await open("#monitoring/notice", feedReady);
	await ev(`(document.querySelector('#mon-tl .mr-f[data-filter="fail"]').click(), 0)`);
	await wait(`document.querySelector('#mon-tl .mr-f[data-filter="fail"]').classList.contains("on")`, "fail view");
	expect(await ev<string[]>(`[...document.querySelectorAll("#mon-tl > .bm.fr .rc-src")].map(n => n.textContent)`)).toEqual(["옛 서버 감시"]);
	await ev(`(document.querySelector('.mr-f[data-filter="all"]').click(), 0)`);
	await wait(`document.querySelectorAll("#mon-tl > .mon-sh").length === 3`, "all view");
	await ev(`([...document.querySelectorAll("#mon-tl > .bm.fr")].find(r => r.textContent.includes("뉴스 키워드 감시")).click(), 0)`);
	await wait(`!!document.querySelector("#mon-tl .fr-list")`, "unfolded");
	expect(await ev<number>(`document.querySelectorAll("#mon-tl .fr-list > .bm").length`)).toBe(30);
});

test("감시 소식's 읽음 처리 reads the plain reports only; what waits stays unread, and a failure puts them back and says why", async () => {
	await open("#monitoring/notice", feedReady);
	const asks = store.notices.filter(n => n.tone === "ask").map(n => n.id);
	store.failRead = true;
	await ev(`(document.querySelector("#mon-tl .mon-read").click(), 0)`);
	await wait(`!!document.querySelector(".snack.bad")`, "error toast");
	expect(await ev<string>(`document.querySelector(".snack.bad").textContent`)).toContain("저장하지 못했어요");
	await wait(`!document.querySelector("#mon-tl .mon-read").disabled && document.querySelector("#mon-tl .mon-read").textContent.endsWith("읽음 처리") && /^\\d+개/.test(document.querySelector("#mon-tl .mon-read").textContent)`, "button back");
	store.failRead = false;
	const label = await ev<string>(`document.querySelector("#mon-tl .mon-read").textContent`);
	const n = Number(label.replace(/\D.*$/, ""));
	expect(n).toBeGreaterThan(0);
	store.reads.length = 0;
	await ev(`(document.querySelector("#mon-tl .mon-read").click(), 0)`);
	await wait(`[...document.querySelectorAll(".snack:not(.bad)")].some(s => s.textContent.endsWith("읽음으로 표시했어요"))`, "read posted");   // the toast follows the hub's answer; disabled alone is set on the click
	const sent = store.reads.flat();
	expect(sent.length).toBeGreaterThanOrEqual(n);
	expect(sent.filter(id => asks.includes(id))).toEqual([]);
	expect(store.notices.filter(x => asks.includes(x.id) && x.read)).toEqual([]);
	expect(await ev<string>(`document.querySelector('#mon-tl .mr-f[data-filter="need"]').textContent`)).toBe("답 필요3");
});

test("the chat list narrows to 답 필요 and 안 읽음 with their counts and draws the projects a page at a time", async () => {
	await open("#chat/list", chatReady);
	expect(await ev<string[]>(`[...document.querySelectorAll("#chat-convo .cv-bar .mr-f")].map(b => b.textContent)`)).toEqual(["전체", "답 필요15", "안 읽음99"]);
	const projects = `[...document.querySelectorAll("#chat-convo .cv-row")].filter(r => (r.dataset.t || "").startsWith("ch:")).length`;
	expect(await ev<number>(projects)).toBe(40);
	await ev(`(document.querySelector('#chat-convo .cv-more .btn').click(), 0)`);
	await wait(`${projects} === 80`, "next page");
	expect(await ev<string>(`document.querySelector('#chat-convo .cv-more .btn').textContent`)).toBe("프로젝트 20개 더 보기");
	await ev(`(document.querySelector('#chat-convo .mr-f[data-view="need"]').click(), 0)`);
	await wait(`document.querySelector('#chat-convo .mr-f[data-view="need"]').classList.contains("on")`, "need view");
	const need = await ev<string[]>(`[...document.querySelectorAll("#chat-convo .cv-row")].map(r => r.dataset.t)`);
	expect(need.length).toBe(15);
	expect(need).toContain("alert");
	expect(need).toContain("lane:s1");
	expect(need).not.toContain("main");
	await ev(`(document.querySelector('#chat-convo .mr-f[data-view="all"]').click(), 0)`);
});

test("the chat list's 읽음 처리 moves the read position of the conversations that need no answer, never of one that waits", async () => {
	await open("#chat/list", chatReady);
	store.readPosts.length = 0;
	expect(await ev<string>(`document.querySelector("#chat-convo .cv-read").textContent`)).toBe("85개 읽음 처리");
	await ev(`(document.querySelector("#chat-convo .cv-read").click(), 0)`);
	await wait(`document.querySelector("#chat-convo .cv-read").disabled && !!document.querySelector(".snack:not(.bad)")`, "read done");
	const targets = store.readPosts.map(p => p.target);
	expect(targets.length).toBe(85);
	expect(targets).toContain("main");
	for (const t of ["alert", "lane:s1", "lane:s2", "ch:1001", "ch:1008"]) expect(targets).not.toContain(t);
	expect(await ev<string>(`document.querySelector('#chat-convo .mr-f[data-view="unread"]').textContent`)).toBe("안 읽음14");
});
