// Task workers ending a run while a background run they started is live: one hidden follow-up per end, capped.
import { expect, test } from "bun:test";
import { installBgGuard, MAX_REPROMPTS, WAKE_SOURCE_STATE_EVENT } from "./bg-guard.ts";

function worker() {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const bus: ((data: any) => void)[] = [];
	const sent: { message: any; options: any }[] = [];
	installBgGuard({
		on: (name, fn) => (handlers[name] ??= []).push(fn),
		events: { on: (name, fn) => name === WAKE_SOURCE_STATE_EVENT && bus.push(fn) },
		sendMessage: (message, options) => sent.push({ message, options }),
	});
	const emit = (data: any) => bus.forEach(fn => fn(data));
	const end = (event: any = {}) => handlers.agent_end?.forEach(fn => fn(event, {}));
	return { emit, end, sent };
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
