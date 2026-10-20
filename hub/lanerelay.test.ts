import { expect, test } from "bun:test";
import { createLaneRelay, createOwnerNotes } from "./lanerelay.ts";

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
