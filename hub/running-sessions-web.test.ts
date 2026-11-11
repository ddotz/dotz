import { afterAll, beforeAll, expect, test } from "bun:test";
import { ev, fakeHub, idleState, json, run, type View, waitFor } from "./test-web.ts";

// 진행 중 is one list on 홈 and under 땅콩 and 작업내역 in 채팅, a shortcut to sessions that stay in their project's 세션 section: the shipped page against a stub gateway.
const work = { "7001": "기획팀" };
const lane = (name: string, title: string, extra: object) => ({ name, title, cwd: "/h/shared", status: "idle", live: true, reports: 1, startedAt: "2026-11-01T00:00:00Z", ...extra });
const audit = lane("audit", "분기 안건 검토", { status: "working", home: "ch:7001", project: "기획팀", startedAt: "2026-11-01T01:00:00Z" });
const free = lane("free", "회의록 정리", { status: "working", startedAt: "2026-11-01T02:00:00Z" });
const ask = lane("ask", "손익 검토", { home: "ch:7001", project: "기획팀", startedAt: "2026-11-01T03:00:00Z", pendingAsk: { text: "어떻게 할까요?" } });
const done = lane("done", "지난달 보고", { home: "ch:7001", project: "기획팀" });
const held = lane("held", "한도 세션", { status: "rate-limited", home: "ch:7001", project: "기획팀" });
const gone = lane("gone", "오래된 세션", { status: "exited", live: false, home: "ch:7001", project: "기획팀", finishedAt: "2026-11-01T04:00:00Z" });
const lanes = [done, held, free, audit, ask, gone];
const runs = { "lane:audit": { kind: "working" }, "lane:free": { kind: "working" }, "lane:ask": { kind: "waiting", reason: "ask" }, "lane:done": { kind: "done", since: "2026-11-01T05:00:00Z" } };
const projects = [{ key: "ch:7001", name: "기획팀", channel: { id: "7001" }, lanes: lanes.filter(l => l !== free).map(l => ({ name: l.name, title: l.title, status: l.status, live: l.live, waiting: l === ask, finishedAt: l === done ? "2026-11-01T05:00:00Z" : l === gone ? "2026-11-01T04:00:00Z" : undefined })) }];
const hub = fakeHub({
	stream: "fake",
	state: () => idleState({ channels: { work }, lanes, runs }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects, routines: [], links: [], errors: [] });
		if (p === "/api/custom/project") return json({ key: url.searchParams.get("key"), monitors: [], lanes: [], work: [], results: [], routines: [], schedules: [], watches: [] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
	},
});
let v: View;
beforeAll(async () => {
	v = await hub.view({ width: 390, height: 500 });
	await v.navigate(`${hub.origin}/`);
	await hub.streamConnected(1);
	await waitFor(v, `typeof S !== "undefined" && S && S.lanes.length === ${lanes.length} && !S.seeded`);
	await v.evaluate("void prjLoad()");
	await waitFor(v, "PRJ && PRJ.projects.length > 0");
});
afterAll(() => hub.stop());

const WANT = [["기획팀 · 손익 검토", "답을 기다림"], ["기획팀 · 분기 안건 검토", "진행 중"], ["회의록 정리", "진행 중"]];
const homeRows = `(() => { renderHomeNow(); return [...document.querySelectorAll('#v-home .hn[data-k="running"] .srow')].map(r => [r.querySelector(".nm").textContent, r.getAttribute("aria-label").split(" · ")[2]]); })()`;
// Under the 진행 중 header a running row ends in nothing (the header says it runs; the blue mark in a list means unread only); a waiting row keeps its 답을 기다림 tag.
const CHAT_WANT = [WANT[0], [WANT[1][0], ""], [WANT[2][0], ""]];
const chatRows = `(() => { const sec = [...document.querySelectorAll("#chat-convo .cv-sec")].find(n => n.textContent === "진행 중"); const above = sec && sec.previousElementSibling; return above === document.querySelector("#chat-convo > *") && [...above.querySelectorAll(".cv-row")].map(r => r.dataset.t).join() === "main,worklog" ? [...sec.nextElementSibling.querySelectorAll(".cv-row")].map(r => { const tag = r.querySelector(".cv-m2 .tag"); return [r.querySelector(".cv-n").textContent, tag ? tag.textContent : ""]; }) : null; })()`;
// What a session row of 진행 중 carries at its right end, by its target.
const endOf = (t: string) => `[...document.querySelector('#chat-convo .cv-row[data-t="${t}"] .cv-m2').children].map(c => c.className + ":" + c.textContent)`;
const listed = async (expr: string, want: unknown) => { await waitFor(v, `JSON.stringify(${expr}) === ${JSON.stringify(JSON.stringify(want))}`); };

test("홈 and 채팅, under 땅콩 and 작업내역, list the same sessions: waiting first, named project · title, finished and held ones left out", async () => {
	await run(v, `go("home")`);
	await listed(homeRows, WANT);
	// a running row ends in a time, not in the state word (the aria-label above keeps it)
	expect(await ev<string[]>(v, `[...document.querySelectorAll('#v-home .hn[data-k="running"] .srow .hs')].map(h => h.textContent).filter(t => /진행 중|작업 중/.test(t))`)).toEqual([]);
	expect(await ev<number>(v, `document.querySelectorAll('#v-home .hn[data-k="waiting"] [data-t="lane:ask"]').length`)).toBe(0);
	expect(await ev<number>(v, `document.querySelectorAll('#v-home .hn[data-k="waiting"] [data-t="lane:held"]').length`)).toBe(1);
	await run(v, `go("chat", "list")`);
	await listed(chatRows, CHAT_WANT);
	await run(v, `document.querySelector('#chat-convo .cv-card .cv-row[data-t="lane:audit"]').click()`);
	await waitFor(v, `target === "lane:audit" && current === "chat"`);
});

test("in the chat list a running session ends in no dot or word when read, in its unread count when not, and a waiting one keeps its word", async () => {
	await run(v, `go("chat", "list")`);
	await listed(chatRows, CHAT_WANT);
	expect(await ev<string[]>(v, endOf("lane:audit"))).toEqual([]);
	expect(await ev<string[]>(v, endOf("lane:ask"))).toEqual(["tag warn:답을 기다림"]);   // the word carries its own dot: no second dot beside it
	await run(v, `ts("lane:audit").unread = 3; convSig = ""; convSchedule()`);
	await waitFor(v, `JSON.stringify(${endOf("lane:audit")}) === ${JSON.stringify(JSON.stringify(["nb:3"]))}`);
	await run(v, `ts("lane:audit").unread = 0; convSig = ""; convSchedule()`);
	await waitFor(v, `${endOf("lane:audit")}.length === 0`);
});

test("the project's 세션 section holds them all under the one status: waiting, running, what stopped short, finished last", async () => {
	expect(await ev<string[][]>(v, `pmSessionRows(PRJ.projects[0], null).map(r => [r.name, pmLaneState(r)[0]])`)).toEqual([["ask", "답을 기다림"], ["audit", "진행 중"], ["held", "한도 걸림"], ["done", "완료"], ["gone", "완료"]]);
});

test("a session leaves and joins 진행 중 by itself; with nothing running the list has no header, and neither a read further down nor the very top moves", async () => {
	// Against the list's own top: the screen's opening animation may still move the whole list while the test measures.
	const top = (t: string) => `document.querySelector('#chat-convo [data-t="${t}"]').getBoundingClientRect().top - document.querySelector("#chat-convo").getBoundingClientRect().top`;
	const below = top("ch:7001"), mainTop = top("main");
	await run(v, `go("chat", "list"); const side = document.querySelector("#chat-convo"); side.style.height = "160px"; side.style.overflowY = "auto"; side.scrollTop = 120`);
	await waitFor(v, `document.querySelector("#chat-convo").scrollTop === 120`);
	const before = await ev<number>(v, below);
	await run(v, `S.lanes.find(l => l.name === "audit").status = "idle"; S.runs["lane:audit"] = { kind: "done" }; renderBars()`);
	await listed(chatRows, [CHAT_WANT[0], CHAT_WANT[2]]);
	expect(Math.abs(await ev<number>(v, below) - before)).toBeLessThan(1);
	await run(v, `S.lanes.find(l => l.name === "audit").status = "working"; S.runs["lane:audit"] = { kind: "working" }; renderBars()`);
	await listed(chatRows, CHAT_WANT);
	expect(Math.abs(await ev<number>(v, below) - before)).toBeLessThan(1);
	await run(v, `document.querySelector("#chat-convo").scrollTop = 0`);
	const resting = await ev<number>(v, mainTop);
	await run(v, `S.lanes = S.lanes.map(l => ({ ...l, status: l.status === "working" ? "idle" : l.status, pendingAsk: undefined })); S.runs = {}; renderBars()`);
	await waitFor(v, `![...document.querySelectorAll("#chat-convo .cv-sec")].some(n => n.textContent === "진행 중")`);
	expect(Math.abs(await ev<number>(v, mainTop) - resting)).toBeLessThan(1);
	expect(await ev<string>(v, `document.querySelector("#chat-convo .cv-row").dataset.t`)).toBe("main");
});

test("a state stored on this device lists nothing as running until the real one lands", async () => {
	await run(v, `S = { ...S, lanes: [{ ...S.lanes[0], status: "working", live: true }], seeded: true }; go("home")`);
	expect(await ev<unknown>(v, `(({ wait, run }) => [wait.length, run.length, homeRunning().n, homeWord(homeRunning())])(sessionsNow())`)).toEqual([0, 0, 0, "연결 중"]);
});
