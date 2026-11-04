import { afterAll, expect, test } from "bun:test";
import { fakeHub, idleState, json, on } from "./test-web.ts";
import type { BgWork } from "./bgwork.ts";
import { buildWaitlist } from "./waitlist.ts";

// 홈's four groups (08-home.js renderHomeNow): one item walks queued -> running -> done through the list the gateway builds (hub/waitlist.ts)
// and the state a refresh sets, and it is in exactly one group at every step while 할일 stays the first card.
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
await waitFor(`typeof NT !== "undefined" && NT.loaded && S && current === "home" && homeBoard`);
// This process runs on the test clock, the page on its own: every fixture time is the page's.
const NOW = Number(await view.evaluate(`Date.now()`));
const stamp = (ms = NOW) => new Date(ms).toISOString();

type Lane = { name: string; title?: string; status: string; live: boolean; waiting?: string; startedAt?: string };
const paint = (s: { lanes?: Lane[]; work?: BgWork[]; runs?: object; deferred?: Parameters<typeof buildWaitlist>[0]["deferred"] }) => {
	const lanes = s.lanes ?? [], work = s.work ?? [];
	const state = { orchestrator: { status: "idle" }, convs: [], lanes, work, runs: s.runs ?? {}, work_skew: 0, waitlist: buildWaitlist({ deferred: s.deferred ?? [], lanes, work }) };
	return view.evaluate(`(() => { Object.assign(S, ${JSON.stringify(state)}); renderHomeNow(); })()`);
};
// The groups naming this title, and the cards in reading order.
const seen = async (title: string) => JSON.parse((await view.evaluate(`JSON.stringify({
	groups: [...document.querySelectorAll("#v-home .hn")].filter(l => [...l.querySelectorAll(".nm")].some(n => n.textContent.includes(${JSON.stringify(title)}))).map(l => l.dataset.k),
	first: [...document.querySelectorAll("#home-cards .bi")].sort((a, b) => a.style.order - b.style.order)[0].dataset.id,
	todo: document.querySelector('#v-home [data-k="todo"]').textContent,
})`)) as string) as { groups: string[]; first: string; todo: string };

const job = (more: Partial<BgWork>): BgWork => ({ id: "w1", description: "사진첩 고치기", status: "running", started_at: NOW - 1000, ...more });

test("a worker is in one group at every step, and the 할일 card stays first and fixed", async () => {
	await paint({ work: [job({ queued: true })] });
	let s = await seen("사진첩 고치기");
	expect(s.groups).toEqual(["todo"]);
	expect(s.first).toBe("now:todo");
	expect(s.todo).toContain("1");

	await paint({ work: [job({})] });
	s = await seen("사진첩 고치기");
	expect(s.groups).toEqual(["running"]);
	expect(s.first).toBe("now:todo");
	expect(s.todo).toContain("아직 시작 전인 일이 없어요");

	await paint({ work: [job({ status: "done", ended_at: NOW - 60_000 })] });
	s = await seen("사진첩 고치기");
	expect(s.groups).toEqual(["ended-work"]);
	expect(s.first).toBe("now:todo");
});

test("a session is in one group at every step, and a finished one never reads as waiting", async () => {
	const lane = (more: Partial<Lane>): Lane => ({ name: "s1", title: "세션 일", status: "starting", live: true, startedAt: stamp(), ...more });
	const word = () => view.evaluate(`sessionStatus(S.lanes[0]).join("|")`);
	await paint({ lanes: [lane({ waiting: "동시 세션 한도(1개)에 도달해 대기 중" })] });
	expect((await seen("세션 일")).groups).toEqual(["todo"]);
	expect(await word()).toBe("순서 대기|");

	await paint({ lanes: [lane({ status: "working" })], runs: { "lane:s1": { kind: "working" } } });
	expect((await seen("세션 일")).groups).toEqual(["running"]);
	expect(await word()).toBe("작업 중|pri");

	await paint({ lanes: [lane({ status: "idle" })], runs: { "lane:s1": { kind: "done", since: stamp() } } });
	expect((await seen("세션 일")).groups).toEqual(["ended-work"]);
	expect(await word()).toBe("끝남|");
});

test("work stopped by the owner, a stall or a limit waits with its reason; deferred work is 할일 until its session starts", async () => {
	await paint({ work: [job({ status: "failed", cancelled: true, ended_at: NOW })] });
	expect((await seen("사진첩 고치기")).groups).toEqual(["waiting"]);
	await paint({ work: [job({ status: "stalled", reason: "활동이 없어요", ended_at: NOW })] });
	expect((await seen("사진첩 고치기")).groups).toEqual(["waiting"]);

	const until = stamp(NOW + 3_600_000);
	await paint({ lanes: [{ name: "l1", title: "한도 일", status: "rate-limited", live: true }], runs: { "lane:l1": { kind: "limited", reason: "rate", detail: until } } });
	expect((await seen("한도 일")).groups).toEqual(["waiting"]);
	expect(await view.evaluate(`document.querySelector('#v-home [data-k="waiting"]').textContent`)).toContain("까지");

	const deferred = [{ id: "d1", lane: "d1", what: "미룬 일", resume_at: until, since: stamp(NOW - 5000) }];
	await paint({ deferred });
	expect((await seen("미룬 일")).groups).toEqual(["todo"]);
	await paint({ deferred, lanes: [{ name: "d1", title: "미룬 일", status: "working", live: true }], runs: { "lane:d1": { kind: "working" } } });
	expect((await seen("미룬 일")).groups).toEqual(["running"]);
});

test("the counts elsewhere leave out what has not started: the greeting's sessions and word, the project's state", async () => {
	const lanes = [{ name: "q", title: "대기 세션", status: "starting", live: true, waiting: "한도" }, { name: "w", title: "도는 세션", status: "working", live: true }];
	await paint({ lanes, runs: { "lane:w": { kind: "working" } } });
	expect(await view.evaluate(`document.querySelector("#home-now .hgreet .meta").textContent`)).toContain("세션 1개");
	expect(await view.evaluate(`document.querySelector("#home-cards .bi[data-id='now:running'] .ch").textContent`)).toContain("1개 작업 중");
	expect(await view.evaluate(`prjState({ lanes: [{ name: "q", status: "starting", live: true }] }).k`)).toBe("run");
	expect(await view.evaluate(`prjState({ lanes: [{ name: "q", status: "starting", live: true }] }).tone`)).toBe("");
	await paint({ lanes: [{ ...lanes[0]! }] });
	expect(await view.evaluate(`homeWord(homeRunning())`)).toBe("쉬는 중");
});

test("a session whose only worker is queued is not running; its worker is the one row", async () => {
	await paint({ lanes: [{ name: "b", title: "맡긴 세션", status: "idle", live: true }], work: [job({ queued: true })], runs: { "lane:b": { kind: "waiting", reason: "work", queued: true, work: "w1" } } });
	expect((await seen("맡긴 세션")).groups).toEqual([]);
	expect((await seen("사진첩 고치기")).groups).toEqual(["todo"]);
	expect(await view.evaluate(`homeRunning().n`)).toBe(0);
});

test("at desktop width, cards appearing behind the pinned 할일 still pair up, two to a row", async () => {
	await view.resize(1280, 900);
	await paint({ work: [job({}), job({ id: "w2", status: "failed", cancelled: true, ended_at: NOW }), job({ id: "w3", status: "done", ended_at: NOW - 60_000 })] });
	const y = (id: string) => `document.querySelector("#home-cards .bi[data-id='${id}']")?.getBoundingClientRect().top`;
	await waitFor(`${y("now:running")} === ${y("now:waiting")} && ${y("now:todo")} === ${y("notices:alert")}`);
	await view.resize(390, 844);
});
