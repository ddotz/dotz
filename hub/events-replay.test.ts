import { expect, test } from "bun:test";
import { broadcast, emit, emitDelivery, historyEvents, lastEventId, recentEvents, replayAfter, workAnswer } from "./events.ts";

test("a reconnect replays exactly the frames after the last seen id", () => {
	const seen = lastEventId();
	broadcast({ kind: "out", n: 1 });
	broadcast({ kind: "out", n: 2 });
	const missed = replayAfter(seen);
	expect(missed?.map(f => JSON.parse(f.split("data: ")[1]).n)).toEqual([1, 2]);
	expect(missed?.[1].startsWith(`id: ${lastEventId()}\n`)).toBe(true);
	expect(replayAfter(lastEventId())).toEqual([]);
});

test("ids from another boot or the future cannot be replayed", () => {
	expect(replayAfter("zzz-1")).toBeNull();
	expect(replayAfter(`${lastEventId().split("-")[0]}-999999999`)).toBeNull();
	expect(replayAfter("garbage")).toBeNull();
	expect(replayAfter(null)).toBeNull();
});

test("a delivery state is one event in the conversation of its target, and a message without an id has none", () => {
	const before = recentEvents(300).length;
	emitDelivery("lane:deliv-a", undefined, "received");
	expect(recentEvents(300).length).toBe(before);
	emitDelivery("lane:deliv-a", "r1", "steered");
	emitDelivery("lane:deliv-a", "r1", "answered");
	const states = historyEvents("lane:deliv-a", 10).filter(e => e.kind === "delivery");
	expect(states.map(e => [e.ref, e.state])).toEqual([["r1", "steered"], ["r1", "answered"]]);
});

test("recentEvents(0) is empty (the page asks /api/state for limit=0), not the whole list", () => {
	broadcast({ kind: "out", n: 3 });
	expect(recentEvents(0)).toEqual([]);
	expect(recentEvents(1)).toHaveLength(1);
});

test("a worker's result is the answer to its request, else the first real answer in its conversation after it ended", () => {
	const base = Date.parse("2030-01-01T00:00:00.000Z"), at = (s: number) => new Date(base + s * 1000).toISOString();
	const out = (s: number, target: string, over: object = {}) => emit("outbox", { ts: at(s), kind: "out", source: "orchestrator", target, text: "답", ...over });
	out(0, "ch:9", { reply_to: "m-1" });
	const w = { target: "ch:9", reply_to: "m-1", ended_at: base + 1000 };
	expect(workAnswer(w)).toBeUndefined();
	out(2, "ch:9", { update_key: "progress" });
	out(3, "ch:9", { source: "gateway", system: "deferred" });
	out(4, "main");
	expect(workAnswer(w)).toBeUndefined();
	out(5, "ch:9");
	expect(workAnswer(w)).toEqual({ at: at(5), conv: "ch:9", exact: false });
	expect(workAnswer({ target: "ch:9", ended_at: base + 1000 })).toEqual({ at: at(5), conv: "ch:9", exact: true });
	out(6, "ch:9", { reply_to: "m-1" });
	expect(workAnswer(w)).toEqual({ at: at(6), conv: "ch:9", exact: true });
	expect(workAnswer({ target: "web", ended_at: base + 1000 })).toEqual({ at: at(4), conv: "main", exact: true });
});
