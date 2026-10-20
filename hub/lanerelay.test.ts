import { expect, test } from "bun:test";
import { createLaneRelay } from "./lanerelay.ts";

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
