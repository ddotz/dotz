import { afterAll, beforeAll, expect, test } from "bun:test";
import { ev, fakeHub, idleState, json, run, type View, waitFor } from "./test-web.ts";

// 진행 중 is one list on 홈 and at the top of 채팅, a shortcut to sessions that stay in their project's 세션 section: the shipped page against a stub gateway.
const work = { "7001": "재무기획부" };
const lane = (name: string, title: string, extra: object) => ({ name, title, cwd: "/h/shared", status: "idle", live: true, reports: 1, startedAt: "2026-11-01T00:00:00Z", ...extra });
const stx = lane("stx", "STX 출자전환 검토", { status: "working", home: "ch:7001", project: "재무기획부", startedAt: "2026-11-01T01:00:00Z" });
const free = lane("free", "회의록 정리", { status: "working", startedAt: "2026-11-01T02:00:00Z" });
const ask = lane("ask", "손익 검토", { home: "ch:7001", project: "재무기획부", startedAt: "2026-11-01T03:00:00Z", pendingAsk: { text: "어떻게 할까요?" } });
const done = lane("done", "지난달 보고", { home: "ch:7001", project: "재무기획부" });
const held = lane("held", "한도 세션", { status: "rate-limited", home: "ch:7001", project: "재무기획부" });
const gone = lane("gone", "오래된 세션", { status: "exited", live: false, home: "ch:7001", project: "재무기획부", finishedAt: "2026-11-01T04:00:00Z" });
const lanes = [done, held, free, stx, ask, gone];
const runs = { "lane:stx": { kind: "working" }, "lane:free": { kind: "working" }, "lane:ask": { kind: "waiting", reason: "ask" }, "lane:done": { kind: "done", since: "2026-11-01T05:00:00Z" } };
const projects = [{ key: "ch:7001", name: "재무기획부", channel: { id: "7001" }, lanes: lanes.filter(l => l !== free).map(l => ({ name: l.name, title: l.title, status: l.status, live: l.live, waiting: l === ask, finishedAt: l === done ? "2026-11-01T05:00:00Z" : l === gone ? "2026-11-01T04:00:00Z" : undefined })) }];
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

const WANT = [["재무기획부 · 손익 검토", "답을 기다림"], ["재무기획부 · STX 출자전환 검토", "진행 중"], ["회의록 정리", "진행 중"]];
const homeRows = `(() => { renderHomeNow(); return [...document.querySelectorAll('#v-home .hn[data-k="running"] .srow')].map(r => [r.querySelector(".nm").textContent, r.querySelector(".hs").textContent]); })()`;
const chatRows = `(() => { const sec = [...document.querySelectorAll("#chat-convo .cv-sec")].find(n => n.textContent === "진행 중"); return sec && sec === document.querySelector("#chat-convo > *") ? [...sec.nextElementSibling.querySelectorAll(".cv-row")].map(r => [r.querySelector(".cv-n").textContent, r.querySelector(".tag").textContent]) : null; })()`;
const listed = async (expr: string, want: unknown) => { await waitFor(v, `JSON.stringify(${expr}) === ${JSON.stringify(JSON.stringify(want))}`); };

test("홈 and the top of 채팅 list the same sessions: waiting first, named project · title, finished and held ones left out", async () => {
	await run(v, `go("home")`);
	await listed(homeRows, WANT);
	expect(await ev<number>(v, `document.querySelectorAll('#v-home .hn[data-k="waiting"] [data-t="lane:ask"]').length`)).toBe(0);
	expect(await ev<number>(v, `document.querySelectorAll('#v-home .hn[data-k="waiting"] [data-t="lane:held"]').length`)).toBe(1);
	await run(v, `go("chat", "list")`);
	await listed(chatRows, WANT);
	await run(v, `document.querySelector('#chat-convo .cv-card .cv-row[data-t="lane:stx"]').click()`);
	await waitFor(v, `target === "lane:stx" && current === "chat"`);
});

test("the project's 세션 section holds them all under the one status: waiting, running, what stopped short, finished last", async () => {
	expect(await ev<string[][]>(v, `pmSessionRows(PRJ.projects[0], null).map(r => [r.name, pmLaneState(r)[0]])`)).toEqual([["ask", "답을 기다림"], ["stx", "진행 중"], ["held", "한도 걸림"], ["done", "완료"], ["gone", "완료"]]);
});

test("a finished session leaves 진행 중 by itself; with nothing running the list has no header and a read further down does not move", async () => {
	const mainTop = `document.querySelector('#chat-convo [data-t="main"]').getBoundingClientRect().top`;
	await run(v, `go("chat", "list"); const side = document.querySelector("#chat-convo"); side.style.height = "160px"; side.style.overflowY = "auto"; side.scrollTop = 100`);
	await waitFor(v, `document.querySelector("#chat-convo").scrollTop === 100`);
	const before = await ev<number>(v, mainTop);
	await run(v, `S.lanes.find(l => l.name === "stx").status = "idle"; S.runs["lane:stx"] = { kind: "done" }; renderBars()`);
	await listed(chatRows, [WANT[0], WANT[2]]);
	expect(Math.abs(await ev<number>(v, mainTop) - before)).toBeLessThan(1);
	await run(v, `S.lanes = S.lanes.map(l => ({ ...l, status: l.status === "working" ? "idle" : l.status, pendingAsk: undefined })); S.runs = {}; renderBars()`);
	await waitFor(v, `![...document.querySelectorAll("#chat-convo .cv-sec")].some(n => n.textContent === "진행 중")`);
	expect(await ev<string>(v, `document.querySelector("#chat-convo .cv-row").dataset.t`)).toBe("main");
});

test("a state stored on this device lists nothing as running until the real one lands", async () => {
	await run(v, `S = { ...S, lanes: [{ ...S.lanes[0], status: "working", live: true }], seeded: true }; go("home")`);
	expect(await ev<unknown>(v, `(({ wait, run }) => [wait.length, run.length, homeRunning().n, homeWord(homeRunning())])(sessionsNow())`)).toEqual([0, 0, 0, "연결 중"]);
});
