// Task workers ending a run while a background run they started is live: one hidden follow-up per end, capped.
import { expect, test } from "bun:test";
import { installBgGuard, MAX_REPROMPTS, WAKE_SOURCE_STATE_EVENT } from "./bg-guard.ts";
import { guardConfigFrom } from "./guard-config.ts";
import { installTaskCap } from "./task-cap.ts";
import { growthFor } from "./task-cap-grow.ts";

function worker(cap?: number) {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const bus: ((data: any) => void)[] = [];
	const sent: { message: any; options: any }[] = [];
	const host = {
		on: (name: string, fn: (event: any, ctx: any) => any) => (handlers[name] ??= []).push(fn),
		events: { on: (name: string, fn: (data: any) => void) => name === WAKE_SOURCE_STATE_EVENT && bus.push(fn) },
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	};
	if (cap) installTaskCap(host, cap, 0, growthFor(cap, guardConfigFrom({ task_cap_grow: false })));
	installBgGuard(host);
	const emit = (data: any) => bus.forEach(fn => fn(data));
	const end = (event: any = {}) => handlers.agent_end?.forEach(fn => fn(event, {}));
	const spend = (cacheRead: number) => handlers.turn_end?.forEach(fn => fn({ message: { role: "assistant", usage: { input: 0, cacheRead, cacheWrite: 0, output: 0 } }, toolResults: [{}] }, {}));
	return { emit, end, spend, get sent() { return sent.filter(s => s.message.customType === "dotz-bg-guard"); } };
}

test("nothing live: the run ends with no extra turn", () => {
	const w = worker();
	w.end();
	w.emit({ source: "terminal-background-sessions", activeCount: 1, items: [{ id: "b1", description: "bun test" }] });
	w.emit({ source: "terminal-background-sessions", activeCount: 0, items: [] });
	w.emit({ source: "senpi-task", activeCount: 2 });
	w.end();
	expect(w.sent).toHaveLength(0);
});

test("a live background bash, monitor or eval cell re-prompts the worker, at most MAX_REPROMPTS times", () => {
	const w = worker();
	w.emit({ source: "terminal-background-sessions", activeCount: 1, items: [{ id: "b1", description: "bun test" }] });
	w.emit({ source: "terminal-monitors", activeCount: 1, monitors: [{ id: "mon_1", description: "test log" }] });
	w.emit({ source: "senpi-codemode", activeCount: 1, items: [{ id: "c1", description: "run tests" }] });
	w.end();
	expect(w.sent).toHaveLength(1);
	const { message, options } = w.sent[0];
	expect(message.content).toBe(
		"A background run you started is still live (background bash: bun test; monitor: test log; detached eval cell: run tests). Wait for it in the foreground with one blocking call, then finish.",
	);
	expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	w.end({ aborted: true });
	expect(w.sent).toHaveLength(1);
	for (let i = 0; i < MAX_REPROMPTS + 2; i++) w.end();
	expect(w.sent).toHaveLength(MAX_REPROMPTS);
});

const live = { source: "terminal-background-sessions", activeCount: 1, items: [{ id: "b1", description: "bun test" }] };

test("a worker past its token cap is not re-prompted for a live background run", () => {
	const w = worker(1_000_000);
	w.emit(live);
	w.spend(999_999);
	w.end();
	expect(w.sent).toHaveLength(1);
	w.spend(1);
	w.end();
	expect(w.sent).toHaveLength(1);
});

test("the cap belongs to its own runner: a second worker's cap does not stop the first worker's re-prompts", () => {
	const first = worker(1_000_000);
	const second = worker(1_000_000);
	first.emit(live);
	second.emit(live);
	second.spend(1_000_000);
	first.end();
	second.end();
	expect(first.sent).toHaveLength(1);
	expect(second.sent).toHaveLength(0);
});
