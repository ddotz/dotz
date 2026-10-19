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
