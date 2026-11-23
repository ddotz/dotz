import { afterAll, beforeAll, expect, test } from "bun:test";
import { ev, fakeHub, idleState, json, run, type View, waitFor } from "./test-web.ts";

const work = { "7001": "기획팀" };
const lane = (name: string, title: string, extra: object) => ({ name, title, cwd: "/h/shared", status: "idle", live: true, reports: 1, startedAt: "2026-11-01T00:00:00Z", ...extra });
const audit = lane("audit", "분기 안건 검토", { status: "working", home: "ch:7001", project: "기획팀", startedAt: "2026-11-01T01:00:00Z", mode: "coding" });
const free = lane("free", "회의록 정리", { status: "working", startedAt: "2026-11-01T02:00:00Z", mode: "assistant" });
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
const CHAT_WANT = [["손익 검토", "답을 기다림"], ["분기 안건 검토", ""], ["한도 세션", "한도 걸림"], ["지난달 보고", "완료"], ["회의록 정리", ""]];
const chatTree = `[...document.querySelectorAll("#chat-convo .cv-sec, #chat-convo .cv-row[data-t]")].map(n => n.matches(".cv-sec") ? n.firstChild.textContent : n.dataset.t)`;
const chatRows = `[...document.querySelectorAll('#chat-convo .cv-row[data-t^="lane:"]')].map(r => { const tag = r.querySelector(".cv-m2 .tag"); return [r.querySelector(".cv-n").textContent, tag ? tag.textContent : ""]; })`;
// What a session row of 진행 중 carries at its right end, by its target.
const endOf = (t: string) => `[...document.querySelector('#chat-convo .cv-row[data-t="${t}"] .cv-m2').children].map(c => c.className + ":" + c.textContent)`;
const listed = async (expr: string, want: unknown) => { await waitFor(v, `JSON.stringify(${expr}) === ${JSON.stringify(JSON.stringify(want))}`); };

test("S6: 홈 lists what runs or waits (finished and held left out); 채팅 nests every live session under its project, waiting first, and one of no project under 기타 진행 중", async () => {
	await run(v, `go("home")`);
	await listed(homeRows, WANT);
	// a running row ends in a time, not in the state word (the aria-label above keeps it)
	expect(await ev<string[]>(v, `[...document.querySelectorAll('#v-home .hn[data-k="running"] .srow .hs')].map(h => h.textContent).filter(t => /진행 중|작업 중/.test(t))`)).toEqual([]);
	expect(await ev<number>(v, `document.querySelectorAll('#v-home .hn[data-k="waiting"] [data-t="lane:ask"]').length`)).toBe(0);
	expect(await ev<number>(v, `document.querySelectorAll('#v-home .hn[data-k="waiting"] [data-t="lane:held"]').length`)).toBe(1);
	await run(v, `go("chat", "list")`);
	await waitFor(v, `!!document.querySelector('#chat-convo .cv-row[data-t="lane:free"]')`);
	await listed(chatRows, CHAT_WANT);
	expect(await ev<string[]>(v, chatTree)).toEqual(["main", "worklog", "프로젝트", "ch:7001", "lane:ask", "lane:audit", "lane:held", "lane:done", "기타 진행 중", "lane:free"]);
	await run(v, `document.querySelector('#chat-convo .cv-card .cv-row[data-t="lane:audit"]').click()`);
	await waitFor(v, `target === "lane:audit" && current === "chat"`);
});

test("a session row on 홈 says its mode (코딩 or 비서), a session with no mode says nothing, and the word is in the row's accessible name after the status", async () => {
	await run(v, `go("home")`);
	const rows = `(() => { renderHomeNow(); return [...document.querySelectorAll('#v-home .hn[data-k="running"] .srow')].map(r => [r.dataset.t, [...r.querySelectorAll(".hp")].map(m => m.textContent), r.getAttribute("aria-label").split(" · ").slice(2, 4)]); })()`;
	await listed(rows, [["lane:ask", [], ["답을 기다림", "대화 열기"]], ["lane:audit", ["코딩"], ["진행 중", "코딩"]], ["lane:free", ["비서"], ["진행 중", "비서"]]]);
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

test("S6: a session that ends above the reader leaves its project without moving what is read further down, and 기타 진행 중 goes with its last session", async () => {
	const top = (t: string) => `document.querySelector('#chat-convo [data-t="${t}"]').getBoundingClientRect().top - document.querySelector("#chat-convo").getBoundingClientRect().top`;
	await run(v, `go("chat", "list"); const side = document.querySelector("#chat-convo"); side.style.height = "160px"; side.style.overflowY = "auto"`);
	await waitFor(v, `!!document.querySelector('#chat-convo [data-t="lane:free"]')`);
	await run(v, `const side = document.querySelector("#chat-convo"); side.scrollTop = side.scrollTop + ${top("lane:free")} - 20`);
	const before = await ev<number>(v, top("lane:free"));
	await run(v, `S.lanes.find(l => l.name === "done").live = false; S.lanes.find(l => l.name === "done").status = "exited"; renderBars()`);
	await waitFor(v, `!document.querySelector('#chat-convo .cv-row[data-t="lane:done"]')`);
	expect(Math.abs(await ev<number>(v, top("lane:free")) - before)).toBeLessThan(1);
	await run(v, `S.lanes.find(l => l.name === "done").live = true; S.lanes.find(l => l.name === "done").status = "idle"; renderBars()`);
	await waitFor(v, `!!document.querySelector('#chat-convo .cv-row[data-t="lane:done"]')`);
	expect(Math.abs(await ev<number>(v, top("lane:free")) - before)).toBeLessThan(1);
	await run(v, `document.querySelector("#chat-convo").scrollTop = 0`);
	const resting = await ev<number>(v, top("main"));
	await run(v, `S.lanes = S.lanes.map(l => ({ ...l, status: l.status === "working" ? "idle" : l.status, pendingAsk: undefined })); S.runs = {}; renderBars()`);
	await waitFor(v, `![...document.querySelectorAll("#chat-convo .cv-sec")].some(n => n.textContent === "기타 진행 중")`);
	expect(Math.abs(await ev<number>(v, top("main")) - resting)).toBeLessThan(1);
	expect(await ev<string>(v, `document.querySelector("#chat-convo .cv-row").dataset.t`)).toBe("main");
});

test("a state stored on this device lists nothing as running until the real one lands", async () => {
	await run(v, `S = { ...S, lanes: [{ ...S.lanes[0], status: "working", live: true }], seeded: true }; go("home")`);
	expect(await ev<unknown>(v, `(({ wait, run }) => [wait.length, run.length, homeRunning().n, homeWord(homeRunning())])(sessionsNow())`)).toEqual([0, 0, 0, "연결 중"]);
});
