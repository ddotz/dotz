import { afterAll, beforeEach, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { listNotices, needsAnswer, orchestratorTurnStarted, resetNoticesForTest } from "./notices.ts";
import { queue } from "./outbound.ts";

process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => delete process.env.DOTZ_NO_ORCHESTRATOR);
beforeEach(() => {
	resetNoticesForTest();
	queue.settleTurn();
});

const T0 = new Date().getTime() - 600_000;
let tick = 0;
const ts = () => new Date(T0 + ++tick * 1000).toISOString();
const orchAsk = (text: string, ref: string) => emit("outbox", { ts: ts(), kind: "out", source: "orchestrator", target: "alert", text, reply_to: ref });
const openAsks = () => listNotices().items.filter(needsAnswer);

function askThenLater(id: string, worker: string) {
	orchestratorTurnStarted(ts());
	queue.deliver(`request ${id}`, { target: "web", replyTo: id, owner: true });
	queue.onPrompt(`request ${id}`);
	orchAsk("[ask] 먼저 확인할 것이 있어요", id);
	queue.workersSpawned([{ id: worker }]);
	queue.onAnswer("[later]");
	queue.settleTurn();
	expect(openAsks().length).toBe(1);
}

test("a woken run's [done] closes the ask its request raised in an earlier turn", async () => {
	askThenLater("req-w1", "W1~aaaa.1");
	orchestratorTurnStarted(ts());
	queue.workersDone(["W1~aaaa.1"]);
	queue.onAnswer("[done] 맡긴 일을 마쳤어요");
	await Promise.resolve();
	expect(openAsks()).toEqual([]);
});

test("a prompted turn's own [done] still closes it, as the old wiring did", async () => {
	orchestratorTurnStarted(ts());
	queue.deliver("first", { target: "web", replyTo: "req-p1", owner: true });
	queue.onPrompt("first");
	orchAsk("[ask] 먼저 확인할 것이 있어요", "req-p1");
	queue.onAnswer("[done] 일부만 했어요");
	queue.settleTurn();
	expect(openAsks().length).toBe(1);
	orchestratorTurnStarted(ts());
	queue.deliver("again", { target: "web", replyTo: "req-p1", owner: true });
	queue.onPrompt("again");
	queue.onAnswer("[done] 다 했어요");
	await Promise.resolve();
	expect(openAsks()).toEqual([]);
});
