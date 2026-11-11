import { describe, expect, test } from "bun:test";
import { createApprovalSender, type SendJob, type SendResult } from "./approval-send.ts";

// The cancel window of an approved send (hub/approval-send.ts): the clock and the timer are the test's, so nothing waits.
const PLACES: Record<string, { kind: "comment" | "mail"; lane: string }> = {
	RAAAAAA: { kind: "mail", lane: "mail:zele" },
	D1: { kind: "comment", lane: "comment:site-a" },
};
const job = (ref: string): SendJob => ({ ref, conv: "main", action: "send", title: `이 답장 보낼까요? (${ref})` });
const WINDOW = 10_000;

function memoryStore() {
	const box = { body: "[]" };
	return { box, store: { load: () => JSON.parse(box.body) as unknown[], save: (body: string) => void (box.body = body) } };
}

function rig(m = memoryStore(), windowMs = WINDOW) {
	const clock = { t: 1_000_000 };
	const timers: { at: number; fn: () => void }[] = [];
	const ran: string[][] = [];
	const reports: SendResult[] = [];
	const revoked: { ref: string; why: string }[] = [];
	const s = createApprovalSender({
		kind: ref => PLACES[ref],
		run: async argv => (ran.push(argv), { code: 0, out: "보냈어요" }),
		report: r => void reports.push(r),
		log: () => undefined,
		now: () => clock.t,
		undoMs: () => windowMs,
		after: (ms, fn) => void timers.push({ at: clock.t + ms, fn }),
		revoke: (j, why) => void revoked.push({ ref: j.ref, why }),
		store: m.store,
	});
	/** Moves the clock and fires the timers that came due, like the real timer would have. */
	const advance = (ms: number) => {
		clock.t += ms;
		for (const x of timers.filter(x => x.at <= clock.t)) {
			timers.splice(timers.indexOf(x), 1);
			x.fn();
		}
	};
	const last = (ref: string) => reports.filter(r => r.ref === ref).at(-1);
	return { s, ran, reports, revoked, advance, last, m };
}

describe("send undo window", () => {
	test("cancel before the time: the send is never called and the draft goes back to waiting", async () => {
		const r = rig();
		expect(r.s.enqueue(job("RAAAAAA"))).toBe(true);
		expect(r.last("RAAAAAA")?.state).toBe("undo");
		r.advance(WINDOW - 1);
		expect(r.s.cancel("RAAAAAA")).toBe("cancelled");
		r.advance(WINDOW * 3);
		await r.s.idle();
		expect(r.ran).toEqual([]);
		expect(r.revoked).toEqual([{ ref: "RAAAAAA", why: "cancel" }]);
		expect(r.last("RAAAAAA")?.state).toBe("back");
		expect(JSON.parse(r.m.box.body)).toEqual([]);
		// it waits for approval again: a new 보내기 starts a new window
		expect(r.s.enqueue(job("RAAAAAA"))).toBe(true);
		expect(r.last("RAAAAAA")?.state).toBe("undo");
	});

	test("no cancel: sent exactly once after the window, not before", async () => {
		const r = rig();
		r.s.enqueue(job("RAAAAAA"));
		r.advance(WINDOW - 1);
		await r.s.idle();
		expect(r.ran).toEqual([]);
		r.advance(1);
		await r.s.idle();
		expect(r.ran.length).toBe(1);
		expect(r.last("RAAAAAA")?.state).toBe("sent");
		r.advance(WINDOW * 5);
		r.s.recheck();
		await r.s.idle();
		expect(r.ran.length).toBe(1);
		expect(r.s.cancel("RAAAAAA")).toBe("late");
	});

	test("the gateway stops inside the window: nothing goes out on boot, the draft is back to waiting, said once", async () => {
		const m = memoryStore();
		const first = rig(m);
		first.s.enqueue(job("RAAAAAA"));
		expect(JSON.parse(m.box.body)).toHaveLength(1);
		// the first process is gone; a new one boots from the same file, long after the window
		const second = rig(m);
		second.s.recover();
		second.advance(WINDOW * 10);
		second.s.recheck();
		await second.s.idle();
		expect(second.ran).toEqual([]);
		expect(second.revoked).toEqual([{ ref: "RAAAAAA", why: "restart" }]);
		expect(second.reports.filter(x => x.ref === "RAAAAAA").map(x => x.state)).toEqual(["back"]);
		expect(JSON.parse(m.box.body)).toEqual([]);
		// a third boot finds nothing: the card was told once
		const third = rig(m);
		third.s.recover();
		expect(third.reports).toEqual([]);
		expect(third.revoked).toEqual([]);
		expect(third.ran).toEqual([]);
	});

	test("a second approval or a double click in the window makes no second send", async () => {
		const r = rig();
		r.s.enqueue(job("RAAAAAA"));
		r.advance(3_000);
		expect(r.s.enqueue(job("RAAAAAA"))).toBe(true);
		expect(r.s.enqueue(job("RAAAAAA"))).toBe(true);
		expect(r.reports.filter(x => x.state === "undo")).toHaveLength(1);
		r.advance(WINDOW);
		await r.s.idle();
		expect(r.ran).toHaveLength(1);
		r.s.enqueue(job("RAAAAAA"));
		await r.s.idle();
		expect(r.ran).toHaveLength(1);
	});

	test("0 turns the window off: the send starts at once, as before", async () => {
		const r = rig(memoryStore(), 0);
		r.s.enqueue(job("D1"));
		await r.s.idle();
		expect(r.ran).toHaveLength(1);
		expect(r.reports.some(x => x.state === "undo")).toBe(false);
	});
});
