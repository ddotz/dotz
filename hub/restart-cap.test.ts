// A waiting restart holds new work from its first moment and, past the cap, tells the owner once what still runs and what they can
// choose; it never kills anything (2026-11-10: an update with security fixes waited over 75 minutes behind a lane's workers).
import { expect, test } from "bun:test";
import { parseChoices } from "./choices.ts";
import { createRestartGate, restartCapText } from "./restart.ts";
import { advance } from "./runtime/test-clock.ts";

test("past the cap the owner is alerted once, naming the session and the choice; the wait goes on and ends with the work", async () => {
	const state = { busy: ["lane qa-golden (2 background workers)"], holds: 0, exits: 0, caps: [] as string[] };
	const gate = createRestartGate({
		busy: () => state.busy,
		collecting: () => false,
		startedAt: Date.now() - 3600_000,
		minGapMs: 5 * 60_000,
		noticeAfterMs: 20 * 60_000,
		notice: () => {},
		log: () => {},
		exit: () => state.exits++,
		hold: () => state.holds++,
		capAfterMs: 90 * 60_000,
		cap: (busy, min) => state.caps.push(restartCapText(busy, min)),
	});
	gate.request();
	gate.request();
	expect(state.holds).toBe(1);
	await advance(89 * 60_000);
	expect(state.caps).toEqual([]);
	await advance(2 * 60_000);
	expect(state.caps.length).toBe(1);
	expect(state.caps[0]).toContain("qa-golden");
	expect(parseChoices(state.caps[0]!).options.length).toBe(2);
	await advance(3 * 3600_000);
	expect(state.caps.length).toBe(1);
	expect(state.exits).toBe(0);
	state.busy = [];
	await advance(5000);
	expect(state.exits).toBe(1);
});
