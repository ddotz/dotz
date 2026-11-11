// Task workers past guard.task_token_cap: warned once at 75%, then tools blocked with a [fail] note, aborted if they keep calling tools.
// Past guard.task_compact_tokens of context a worker compacts itself between tool steps, once per crossing.
import { expect, test } from "bun:test";
import { guardConfigFrom } from "./guard-config.ts";
import { installTaskCap } from "./task-cap.ts";
import { growthFor } from "./task-cap-grow.ts";

function worker(cap: number, compactAt = 0) {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const sent: { message: any; options: any }[] = [];
	installTaskCap({ on: (name, fn) => (handlers[name] ??= []).push(fn), sendMessage: (message, options) => sent.push({ message, options }) }, cap, compactAt, growthFor(cap, guardConfigFrom({ task_cap_grow: false })));
	let aborted = 0;
	const compacts: { onComplete?: (r: unknown) => void; onError?: (e: Error) => void }[] = [];
	const ctx = { abort: () => aborted++, compact: (o: any) => compacts.push(o), sessionManager: { getSessionId: () => "sess-1" } };
	const turn = (cacheRead: number, toolResults: unknown[] = [{}]) => handlers.turn_end?.[0]({ message: { role: "assistant", usage: { input: 400, cacheRead, cacheWrite: 0, output: 600 } }, toolResults }, ctx);
	const answer = (stopReason = "stop", content: unknown[] = [{ type: "text", text: "report" }]) =>
		handlers.turn_end?.[0]({ message: { role: "assistant", stopReason, content, usage: { input: 400, cacheRead: 10_000, cacheWrite: 0, output: 600 } }, toolResults: [] }, ctx);
	const call = () => handlers.tool_call?.[0]({ toolName: "eval", toolCallId: "x" }, ctx);
	return { turn, answer, call, handlers, sent, compacts, aborted: () => aborted };
}

test("below the cap tools run; above it every call is blocked with what was spent", () => {
	const w = worker(1_500_000);
	for (let i = 0; i < 29; i++) w.turn(50_000);
	expect(w.call()).toBeUndefined();
	w.turn(50_000);
	const blocked = w.call();
	expect(blocked.block).toBe(true);
	expect(blocked.reason).toContain("[fail] dotz task token cap");
	expect(blocked.reason).toContain("1,530K tokens over 30 turns");
	expect(w.aborted()).toBe(0);
	w.call();
	w.call();
	w.call();
	expect(w.aborted()).toBe(1);
});

test("one hidden steer past 75% of the configured cap, then the block still fires at the cap", () => {
	const w = worker(4_000_000);
	w.turn(2_998_999);
	expect(w.sent).toEqual([]);
	w.turn(0);
	expect(w.sent).toHaveLength(1);
	expect(w.sent[0].options).toEqual({ deliverAs: "steer" });
	expect(w.sent[0].message).toMatchObject({ customType: "dotz-task-cap", display: false });
	expect(w.sent[0].message.content).toContain("3,001K of its 4,000K");
	w.turn(500_000);
	expect(w.sent).toHaveLength(1);
	expect(w.call()).toBeUndefined();
	w.turn(500_000);
	expect(w.sent).toHaveLength(1);
	expect(w.call().block).toBe(true);
});

test("the default cap warns at 9M", () => {
	const w = worker(guardConfigFrom({}).task_token_cap);
	w.turn(8_998_999);
	expect(w.sent).toEqual([]);
	w.turn(0);
	expect(w.sent).toHaveLength(1);
});

test("no warning on a final turn without tools, nor when one turn jumps past the cap", () => {
	const w = worker(1_000_000);
	w.turn(800_000, []);
	expect(w.sent).toEqual([]);
	w.turn(0);
	expect(w.sent).toHaveLength(1);
	const jump = worker(1_000_000);
	jump.turn(2_000_000);
	expect(jump.sent).toEqual([]);
	expect(jump.call().block).toBe(true);
});

test("config: default 12M, 0 turns the cap off, bad values fall back", () => {
	expect(guardConfigFrom({}).task_token_cap).toBe(12_000_000);
	expect(guardConfigFrom({ task_token_cap: 0 }).task_token_cap).toBe(0);
	expect(guardConfigFrom({ task_token_cap: -1 }).task_token_cap).toBe(12_000_000);
	const off = worker(0);
	expect(off.handlers.tool_call).toBeUndefined();
	expect(off.handlers.turn_end).toBeUndefined();
});

test("past the context threshold a worker compacts between tool steps, once per crossing, and a hidden message continues it when the compaction ends", () => {
	const w = worker(50_000_000, 100_000);
	w.turn(98_000);
	expect(w.compacts).toHaveLength(0);
	w.turn(99_600);
	expect(w.compacts).toHaveLength(1);
	expect(w.sent).toEqual([]);
	w.compacts[0].onComplete?.({});
	const resume = w.sent.find(s => s.message.customType === "dotz-task-compact");
	expect(resume?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	expect(resume?.message.display).toBe(false);
	expect(resume?.message.content).toContain("was compacted");
	w.turn(130_000);
	expect(w.compacts).toHaveLength(1);
	w.compacts[0].onComplete?.({});
	w.turn(40_000);
	w.turn(120_000);
	expect(w.compacts).toHaveLength(2);
});

test("a compaction that ends after the worker's final answer sends no message; one that ends mid-work still resumes it", () => {
	const w = worker(50_000_000, 100_000);
	w.turn(120_000);
	w.answer();
	w.compacts[0].onComplete?.({});
	expect(w.sent).toEqual([]);
	const failed = worker(50_000_000, 100_000);
	failed.turn(120_000);
	failed.answer();
	failed.compacts[0].onError?.(new Error("nope"));
	expect(failed.sent).toEqual([]);
	for (const [stopReason, content] of [["aborted", [{ type: "text", text: "x" }]], ["stop", [{ type: "toolCall", name: "eval" }]], ["toolUse", [{ type: "toolCall", name: "eval" }]]] as const) {
		const mid = worker(50_000_000, 100_000);
		mid.turn(120_000);
		mid.answer(stopReason, [...content]);
		mid.compacts[0].onComplete?.({});
		expect(mid.sent).toHaveLength(1);
	}
	const later = worker(50_000_000, 100_000);
	later.turn(120_000);
	later.answer();
	later.turn(10_000);
	later.compacts[0].onComplete?.({});
	expect(later.sent).toHaveLength(1);
});

test("a compaction the runtime ended with neither callback is retried after 50K more context", () => {
	const w = worker(50_000_000, 100_000);
	w.turn(120_000);
	expect(w.compacts).toHaveLength(1);
	w.turn(130_000);
	expect(w.compacts).toHaveLength(1);
	w.turn(160_000);
	expect(w.compacts).toHaveLength(1);
	w.turn(180_000);
	expect(w.compacts).toHaveLength(2);
});

test("a compaction that leaves the context above the threshold re-arms only after 50K more", () => {
	const w = worker(50_000_000, 100_000);
	w.turn(120_000);
	w.compacts[0].onComplete?.({});
	w.turn(130_000);
	w.turn(170_000);
	expect(w.compacts).toHaveLength(1);
	w.turn(190_000);
	expect(w.compacts).toHaveLength(2);
});

test("no compaction on the final turn without tools, past the token cap, or with the threshold at 0", () => {
	const w = worker(50_000_000, 100_000);
	w.turn(150_000, []);
	expect(w.compacts).toHaveLength(0);
	const capped = worker(1_000_000, 100_000);
	capped.turn(1_200_000);
	expect(capped.compacts).toHaveLength(0);
	const off = worker(50_000_000, 0);
	off.turn(900_000);
	expect(off.compacts).toHaveLength(0);
	expect(worker(0, 0).handlers.turn_end).toBeUndefined();
	expect(worker(0, 100_000).handlers.turn_end).toBeDefined();
});

test("a failed compaction is retried only after 50K more context, not on every turn", () => {
	const w = worker(50_000_000, 100_000);
	w.turn(120_000);
	w.compacts[0].onError?.(new Error("nope"));
	expect(w.sent[0].message.content).toContain("could not be compacted");
	w.turn(130_000);
	expect(w.compacts).toHaveLength(1);
	w.turn(172_000);
	expect(w.compacts).toHaveLength(2);
});

test("the compaction summary request counts toward the cap", () => {
	const w = worker(1_000_000, 100_000);
	w.turn(299_000);
	expect(w.compacts).toHaveLength(1);
	w.compacts[0].onComplete?.({});
	w.turn(0);
	expect(w.call()).toBeUndefined();
	w.turn(200_000);
	expect(w.call().block).toBe(true);
});

test("the 75% warning asks for a handoff file and the cap's final-answer text names that path", () => {
	const w = worker(1_000_000);
	w.turn(800_000);
	const warning = w.sent[0].message.content;
	expect(warning).toContain("dotz-handoff/sess-1.md");
	expect(warning).toMatch(/done.*remaining.*next step.*changed paths/s);
	w.turn(300_000);
	const reason = w.call().reason;
	expect(reason).toContain("dotz-handoff/sess-1.md");
	expect(reason).toContain("[fail] token cap");
});

test("config: compaction threshold defaults to 150K, 0 turns it off, bad values fall back", () => {
	expect(guardConfigFrom({}).task_compact_tokens).toBe(150_000);
	expect(guardConfigFrom({ task_compact_tokens: 0 }).task_compact_tokens).toBe(0);
	expect(guardConfigFrom({ task_compact_tokens: -5 }).task_compact_tokens).toBe(150_000);
});
