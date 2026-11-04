import { expect, test } from "bun:test";
import { broadcast, emit, emitDelivery, historyEvents, historyPage, lastEventId, recentEvents, replayAfter, workAnswer } from "./events.ts";

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
	// Later than any date another test file leaves in this process's log (notices.test.ts posts to main in 2052): workAnswer takes the first match in log order.
	const base = Date.parse("2099-01-01T00:00:00.000Z"), at = (s: number) => new Date(base + s * 1000).toISOString();
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

test("a page around a message is centred on it, tells its neighbours, and a message the history lacks finds nothing", () => {
	const t = "lane:page-a", at = (i: number) => new Date(Date.UTC(2050, 4, 1, 0, 0, i)).toISOString();
	for (let i = 0; i < 20; i++) emit("outbox", { ts: at(i), kind: "out", source: "orchestrator", target: t, text: `m${i}`, ...(i === 10 ? { mid: "wanted" } : {}) });
	const page = historyPage(t, 6, { around: "wanted" });
	expect(page.at).toBe(at(10));
	expect(page.events.map(e => e.text)).toEqual(["m7", "m8", "m9", "m10", "m11", "m12"]);
	expect([page.prev, page.next]).toEqual([at(6), at(13)]);
	expect(historyPage(t, 6, { around: at(1) }).prev).toBeUndefined();
	expect(historyPage(t, 6, { around: "gone" })).toEqual({ events: [] });
	const after = historyPage(t, 3, { after: at(15) });
	expect(after.events.map(e => e.text)).toEqual(["m16", "m17", "m18"]);
	expect(after.next).toBe(at(19));
	expect(historyPage(t, 3, { after: at(19) }).events).toEqual([]);
});
