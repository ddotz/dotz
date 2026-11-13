import { expect, test } from "bun:test";
import { NAME } from "./config.ts";
import { createLaneRelay, createOwnerNotes, ownerAlone } from "./lanerelay.ts";
import { MAIN } from "./session-key.ts";

function relay() {
	const sent: string[] = [];
	let busy = false;
	const r = createLaneRelay({ busy: () => busy, deliver: t => sent.push(t), lead: n => `[lane reports ${n}]` });
	return { r, sent, setBusy: (b: boolean) => (busy = b) };
}

test("results, questions and failures go in whole with status and the report file; routine progress and repeats do not", () => {
	const { r, sent } = relay();
	const long = `[ask] which option?\n${"x".repeat(5000)}\n1. A 2. B (recommend A)`;
	expect(r.report("web", long, "/d/lanes/web/report.md")).toBe("relayed");
	expect(sent[0]).toContain("status=ask (full: /d/lanes/web/report.md)");
	expect(sent[0]).toContain("1. A 2. B (recommend A)");
	expect(r.report("web", "[run] workers started, 2 of 5 done", "/f")).toBe("disk");
	expect(r.report("web", "[done] merged abc123", "/f")).toBe("relayed");
	expect(r.report("web", "[done]  merged   abc123", "/f")).toBe("duplicate");
	expect(sent).toHaveLength(2);
	expect(r.report("web", "ㅇㅋ, 그 버튼은 뺐어요.", "/f", true)).toBe("owner");
	expect(r.report("web", "[done] removed the button (d00d)", "/f", true)).toBe("relayed");
	expect(r.report("web", "[lane error] socket closed", "/f", true)).toBe("relayed");
	expect(sent).toHaveLength(4);
});

test("a [wait] on main reaches main; a [wait] on CI, time or workers stays on disk", () => {
	const { r, sent } = relay();
	const forMain = `[wait] 전체 시험을 기다려요\n\n${NAME} 몫: e1bec7e8 전체 시험 결과를 주세요`;
	expect(r.report("web", forMain, "/f")).toBe("relayed");
	expect(r.report("web", forMain, "/f")).toBe("duplicate");
	expect(r.report("hero", "[wait] 메인이 시험 고침 커밋을 알려 주길 기다려요", "/f")).toBe("relayed");
	expect(sent).toHaveLength(2);
	expect(r.report("ci", "[wait] Actions 빌드 완료를 기다려요", "/f")).toBe("disk");
	expect(r.report("ci", `[wait] 워커 결과를 기다려요 (메인 브랜치 기준)\n${NAME} 몫: 없음`, "/f")).toBe("disk");
	expect(r.report("ci2", "[wait] Actions가 끝나면 메인에 머지해요", "/f")).toBe("disk");
	expect(sent).toHaveLength(2);
});

test("reports while the orchestrator is busy become one prompt at idle; a lane's newer report replaces its older one, asks stay", () => {
	const { r, sent, setBusy } = relay();
	setBusy(true);
	expect(r.report("a", "[fail] tests red", "/a")).toBe("held");
	expect(r.report("a", "[done] tests green", "/a")).toBe("held");
	expect(r.report("b", "[ask] deploy now?", "/b")).toBe("held");
	expect(r.report("b", "[done] staged", "/b")).toBe("held");
	expect(r.flush()).toBe(0);
	setBusy(false);
	expect(r.flush()).toBe(3);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toStartWith("[lane reports 3]");
	expect(sent[0]).not.toContain("tests red");
	expect(sent[0]).toContain("deploy now?");
	expect(sent[0]).toContain("staged");
	expect(r.flush()).toBe(0);
});

test("a report while the orchestrator is busy goes into its running turn at once; it is held only when the turn cannot take it", () => {
	const steered: string[] = [];
	let accepts = true;
	const sent: string[] = [];
	const r = createLaneRelay({ busy: () => true, deliver: t => sent.push(t), lead: n => `[lane reports ${n}]`, steer: t => (accepts ? (steered.push(t), true) : false) });
	expect(r.report("a", "[done] merged abc", "/a")).toBe("steered");
	expect(steered).toEqual(["[lane reports 1]\n- lane a status=done (full: /a)\n[done] merged abc"]);
	expect(r.held()).toEqual([]);
	accepts = false;
	expect(r.report("b", "[ask] which one?", "/b")).toBe("held");
	expect(r.held().map(h => h.lane)).toEqual(["b"]);
	expect(sent).toEqual([]);
});

test("a gateway notice like [lane exited] is relayed every time, even in the same words as the last one", () => {
	const sent: string[] = [];
	const r = createLaneRelay({ busy: () => false, deliver: t => sent.push(t), lead: n => `[lane reports ${n}]` });
	const exited = "[lane exited] 프로세스가 종료됐습니다 (code 1). 마지막 상태: 없음";
	expect(r.report("gateway-ui", exited, "/f")).toBe("relayed");
	expect(r.report("gateway-ui", exited, "/f")).toBe("relayed");
	expect(sent.length).toBe(2);
	expect(r.report("gateway-ui", "[done] merged abc", "/f")).toBe("relayed");
	expect(r.report("gateway-ui", "[done] merged abc", "/f")).toBe("duplicate");
});

// 2026-10-21: an owner message to a session got no feedback until the turn ended. The session's short note at its next tool
// boundary is the answer; the final report answers whatever is still open.
function notes() {
	const shown: { lane: string; text: string; refs: string[] }[] = [];
	const answered: { lane: string; refs: string[] }[] = [];
	const lost: { lane: string; refs: string[] }[] = [];
	const n = createOwnerNotes({ note: (lane, text, refs) => shown.push({ lane, text, refs }), answered: (lane, refs) => answered.push({ lane, refs }), lost: (lane, refs) => lost.push({ lane, refs }) });
	return { n, shown, answered, lost };
}

test("the first text that ends in a tool call after an owner message is shown as its answer, mid-turn", () => {
	const { n, shown, answered } = notes();
	expect(n.text("a", "running the tests now", false)).toBe("none");
	n.asked("a", "m1");
	n.asked("a", "m2");
	expect(n.waiting("a")).toBe(true);
	expect(n.text("a", "  지금 테스트를 돌리고 5분 안에 알려요.  ", false)).toBe("note");
	expect(shown).toEqual([{ lane: "a", text: "지금 테스트를 돌리고 5분 안에 알려요.", refs: ["m1", "m2"] }]);
	expect(answered).toEqual([{ lane: "a", refs: ["m1", "m2"] }]);
	expect(n.waiting("a")).toBe(false);
	expect(n.text("a", "next step", false)).toBe("none");
});

test("a text that ends the turn is the report: it answers what is open when reported, and an answer-less tool text stays quiet", () => {
	const { n, shown, answered } = notes();
	n.asked("a", "m1");
	expect(n.text("a", "", false)).toBe("none");
	expect(n.text("a", "[done] merged", true)).toBe("final");
	expect(shown).toEqual([]);
	expect(n.reported("a")).toBe(true);
	expect(answered).toEqual([{ lane: "a", refs: ["m1"] }]);
	expect(n.reported("a")).toBe(false);
	n.asked("b", undefined);
	expect(n.waiting("b")).toBe(false);
});

test("a session that ended with owner messages open reports them lost; sessions do not share messages", () => {
	const { n, answered, lost } = notes();
	n.asked("a", "m1");
	n.asked("b", "m2");
	n.lost("a");
	expect(lost).toEqual([{ lane: "a", refs: ["m1"] }]);
	expect(n.text("a", "late note", false)).toBe("none");
	expect(n.text("b", "note for b", false)).toBe("note");
	expect(answered).toEqual([{ lane: "b", refs: ["m2"] }]);
});

test("a [run] or owner-only report is classified apart from a note: the note path never goes through the orchestrator relay", () => {
	const { r, sent } = relay();
	// The owner-only exchange and routine progress stay off the orchestrator; the lane's note is shown to the owner by the
	// gateway (createOwnerNotes), so neither class may be where an owner answer ends up.
	expect(r.report("a", "10분 안에 알려요.", "/f", true)).toBe("owner");
	expect(r.report("a", "[run] 테스트 중", "/f", true)).toBe("disk");
	expect(sent).toHaveLength(0);
});

test("the questions a turn heard are named until the turn ends, relayed, steered or held; an order for the orchestrator is no question", () => {
	let busy = false;
	const r = createLaneRelay({ busy: () => busy, deliver: () => {}, lead: n => `[${n}]`, steer: () => true });
	r.report("a", "[ask] which one?\n결정: 고를까요?\n1) 네\n2) 아니요", "/a");
	r.report("b", "[done] merged", "/b");
	expect(r.asked()).toEqual(["a"]);
	r.flush();
	expect(r.asked()).toEqual([]);
	busy = true;
	r.report("c", "[ask] steered one?\n결정: 고를까요?\n1) 네\n2) 아니요", "/c");
	r.report("d", `[ask] 재시작이 필요해요\n\nFor ${NAME}: 재시작해 주세요`, "/d");
	expect(r.asked()).toEqual(["c"]);
	busy = false;
	r.flush();
	const held = createLaneRelay({ busy: () => busy, deliver: () => {}, lead: n => `[${n}]` });
	busy = true;
	held.report("e", "[ask] later?\n결정: 고를까요?\n1) 네\n2) 아니요", "/e");
	expect(held.asked()).toEqual([]);
	busy = false;
	held.flush();
	expect(held.asked()).toEqual(["e"]);
});

test("an untagged report while the lane's workers run, or a usage-limit notice, starts no orchestrator turn; a done claim and a report the orchestrator asked for do", () => {
	expect(ownerAlone({ orchAsked: true }, false, 1)).toBe(true);
	expect(ownerAlone({ orchAsked: true }, true, 0)).toBe(true);
	expect(ownerAlone({ orchAsked: true, claim: { state: "reported" } }, false, 1)).toBe(false);
	expect(ownerAlone({ orchAsked: true }, false, 0)).toBe(false);
	expect(ownerAlone({ orchAsked: false }, false, 0)).toBe(true);
});

test("a report of a lane started from a conversation goes to that session only; held reports flush per session", () => {
	const sent: [string, string][] = [];
	const busy = new Set<string>();
	const r = createLaneRelay({ busy: k => busy.has(k), deliver: (t, k) => sent.push([k, t]), lead: n => `[lane reports ${n}]` });
	expect(r.report("a", "[done] first", "/a", false, "ch:1")).toBe("relayed");
	expect(r.report("m", "[done] main one", "/m")).toBe("relayed");
	expect(sent.map(([k]) => k)).toEqual(["ch:1", MAIN]);
	busy.add("ch:1").add("ch:2").add(MAIN);
	expect(r.report("a", "[done] second", "/a", false, "ch:1")).toBe("held");
	expect(r.report("b", "[done] other", "/b", false, "ch:2")).toBe("held");
	expect(r.report("m", "[done] main two", "/m")).toBe("held");
	busy.clear();
	expect(r.flush("ch:1")).toBe(1);
	expect(sent.slice(2).map(([k]) => k)).toEqual(["ch:1"]);
	expect(r.held().map(h => h.lane).sort()).toEqual(["b", "m"]);
	expect(r.flush()).toBe(1);
	expect(r.flush("ch:2")).toBe(1);
	expect(sent.slice(3).map(([k]) => k)).toEqual([MAIN, "ch:2"]);
	expect(sent[3]![1]).toContain("main two");
});

test("a report arriving in a busy conversation turn is steered into that session's turn, not main's", () => {
	const steered: [string, string][] = [];
	const r = createLaneRelay({ busy: k => k === "ch:1", deliver: () => {}, lead: n => `[${n}]`, steer: (t, k) => (steered.push([k, t]), true) });
	expect(r.report("a", "[done] x", "/a", false, "ch:1")).toBe("steered");
	expect(steered.map(([k]) => k)).toEqual(["ch:1"]);
});
