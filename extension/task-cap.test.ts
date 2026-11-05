// Task workers past guard.task_token_cap: warned once at 75%, then tools blocked with a [fail] note, aborted if they keep calling tools.
import { expect, test } from "bun:test";
import { guardConfigFrom } from "./guard-config.ts";
import { installTaskCap } from "./task-cap.ts";

function worker(cap: number) {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const sent: { message: any; options: any }[] = [];
	installTaskCap({ on: (name, fn) => (handlers[name] ??= []).push(fn), sendMessage: (message, options) => sent.push({ message, options }) }, cap);
	let aborted = 0;
	const ctx = { abort: () => aborted++ };
	const turn = (cacheRead: number, toolResults: unknown[] = [{}]) => handlers.turn_end?.[0]({ message: { role: "assistant", usage: { input: 400, cacheRead, cacheWrite: 0, output: 600 } }, toolResults }, {});
	const call = () => handlers.tool_call?.[0]({ toolName: "eval", toolCallId: "x" }, ctx);
	return { turn, call, handlers, sent, aborted: () => aborted };
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
