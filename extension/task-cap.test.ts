// Task workers past guard.task_token_cap: tools blocked with a [fail] note, aborted if they keep calling tools.
import { expect, test } from "bun:test";
import { guardConfigFrom } from "./guard-config.ts";
import { installTaskCap } from "./task-cap.ts";

function worker(cap: number) {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	installTaskCap({ on: (name, fn) => (handlers[name] ??= []).push(fn) }, cap);
	let aborted = 0;
	const ctx = { abort: () => aborted++ };
	const turn = (cacheRead: number) => handlers.turn_end?.[0]({ message: { role: "assistant", usage: { input: 400, cacheRead, cacheWrite: 0, output: 600 } } }, {});
	const call = () => handlers.tool_call?.[0]({ toolName: "eval", toolCallId: "x" }, ctx);
	return { turn, call, handlers, aborted: () => aborted };
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

test("config: default 8M, 0 turns the cap off, bad values fall back", () => {
	expect(guardConfigFrom({}).task_token_cap).toBe(8_000_000);
	expect(guardConfigFrom({ task_token_cap: 0 }).task_token_cap).toBe(0);
	expect(guardConfigFrom({ task_token_cap: -1 }).task_token_cap).toBe(8_000_000);
	expect(worker(0).handlers.tool_call).toBeUndefined();
});
