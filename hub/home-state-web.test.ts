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
