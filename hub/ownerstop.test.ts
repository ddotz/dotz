import { expect, test } from "bun:test";
import { endedWithin, STOP_WAIT_MS, stopAnswer } from "./ownerstop.ts";
import { advance } from "./runtime/test-clock.ts";

const working = (turnsLeft: number) => () => turnsLeft-- > 0;
// The waits run on the test clock: the wait is started, the clock moves past it, the answer is read.
const after = async <T>(wait: Promise<T>): Promise<T> => {
	await advance(STOP_WAIT_MS + 1000);
	return wait;
};

test("the stop says ended only when the turn is no longer working within the wait", async () => {
	expect(await after(endedWithin(working(3), 1000, 1))).toBe(true);
	expect(await after(endedWithin(() => true, 5, 1))).toBe(false);
});

test("the answer tells nothing running, still ending and ended apart", async () => {
	expect(await stopAnswer(undefined)).toEqual({ ok: true, stopped: false, ended: true });
	expect(await stopAnswer({ running: false, request: false, working: () => false })).toEqual({ ok: true, stopped: false, ended: true });
	expect(await stopAnswer({ running: false, request: true, working: () => false })).toEqual({ ok: true, stopped: true, ended: true });
	expect(await after(stopAnswer({ running: true, request: true, working: working(2) }))).toEqual({ ok: true, stopped: true, ended: true });
	expect(await after(stopAnswer({ running: true, request: true, working: () => true }))).toEqual({ ok: true, stopped: true, ended: false });
});
