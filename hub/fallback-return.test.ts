// Going back to the subscription after a usage limit (2026-10-20: an API-key fallback stayed ~30 min after the limit reset,
// because only a bare entry was marked to revert), going back to a limited primary only at its recorded reset (a long,
// growing back-off when none is known), and stopping after a run of failed turns. Tests the chain logic itself.
import { afterEach, expect, test } from "bun:test";
import { chainOf, isPlain } from "./config.ts";
import { Chain, clock, ErrorStreak, ERROR_STREAK_STOP, hubChain, resetFallbackState } from "./fallback.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-20T03:00:00Z");
const realNow = clock.now;
afterEach(() => {
	clock.now = realNow;
	resetFallbackState();
});

test("every fallback entry goes back to the primary once it is usable, a keyed or conditional one too; revert:false stays", () => {
	resetFallbackState();
	clock.now = () => T0;
	const c = new Chain("anthropic/claude-opus-5-5", [{ model: "anthropic/claude-sonnet-5-5", key_file: "/nonexistent-key", when: "quota" }], "medium");
	c.active = 1;
	expect(c.revertTarget(T0)).toEqual({ from: 1, to: 0, why: "revert" });
	const kept = new Chain("anthropic/claude-opus-5-5", [{ model: "anthropic/claude-sonnet-5-5", revert: false }], "medium");
	kept.active = 1;
	expect(kept.revertTarget(T0)).toBeUndefined();
});

test("a primary out on a usage limit comes back at its recorded reset, never at a fixed probe interval", () => {
	resetFallbackState();
	const entries = [{ model: "anthropic/claude-sonnet-5-5", when: "quota" as const }];
	const reset = T0 + 5 * HOUR;
	expect(new Chain("anthropic/claude-opus-5-5", entries, "medium").fail("quota", reset, T0)).toEqual({ from: 0, to: 1, why: "quota" });
	const onFallback = new Chain("anthropic/claude-opus-5-5", entries, "medium");
	onFallback.active = 1;
	expect(onFallback.revertTarget(T0 + 10 * 60_000)).toBeUndefined();
	expect(onFallback.revertTarget(T0 + 3 * HOUR)).toBeUndefined();
	expect(onFallback.revertTarget(reset - 1)).toBeUndefined();
	expect(onFallback.revertTarget(reset)).toEqual({ from: 1, to: 0, why: "revert" });
	// A short provider-error block is not probed: it simply ends.
	resetFallbackState();
	new Chain("anthropic/claude-opus-5-5", entries, "medium").fail("error", T0 + 10 * HOUR, T0);
	expect(onFallback.revertTarget(T0 + 20 * 60_000)).toBeUndefined();
});

test("failed probe before the reset time stays silent and does not retry within the back-off", () => {
	resetFallbackState();
	const entries = [{ model: "anthropic/claude-sonnet-5-5", when: "quota" as const }];
	const onFallback = new Chain("anthropic/claude-opus-5-5", entries, "medium");
	onFallback.active = 1;
	const limit = (at: number, until?: number) => new Chain("anthropic/claude-opus-5-5", entries, "medium").fail("quota", until, at);
	// Unknown reset: 30 min, and every failed try doubles the wait, up to 5 h; no try starts before its time.
	limit(T0);
	let at = T0;
	for (const wait of [30, 60, 120, 240, 300, 300]) {
		const due = at + wait * 60_000;
		expect(onFallback.revertTarget(due - 1)).toBeUndefined();
		expect(onFallback.revertTarget(due)).toEqual({ from: 1, to: 0, why: "revert" });
		at = due + 1000;
		expect(limit(at)?.to).toBe(1);
	}
	// A named reset replaces the guess (and the count of failed tries).
	resetFallbackState();
	limit(T0, T0 + 2 * HOUR);
	expect(onFallback.revertTarget(T0 + 2 * HOUR - 1)).toBeUndefined();
	expect(onFallback.revertTarget(T0 + 2 * HOUR)?.to).toBe(0);
	// The usage report lifting the limit ends it early once; a try that fails anyway waits for its time, however often it is asked.
	resetFallbackState();
	limit(T0, T0 + 5 * HOUR);
	expect(onFallback.revertTarget(T0 + 60_000, true)).toEqual({ from: 1, to: 0, why: "revert" });
	limit(T0 + 61_000);
	for (let m = 2; m < 29; m++) expect(onFallback.revertTarget(T0 + m * 60_000, true)).toBeUndefined();
	expect(onFallback.revertTarget(T0 + 61_000 + 60 * 60_000)?.to).toBe(0);
});

test("consecutive failed turns: the Nth stops automatic retries and alerts once; a good turn starts the count again", () => {
	const s = new ErrorStreak();
	for (let i = 1; i < ERROR_STREAK_STOP; i++) expect(s.fail()).toBe("go");
	expect(s.fail()).toBe("stop");
	expect(s.stopped).toBe(true);
	expect(s.fail()).toBe("stopped");
	s.ok();
	expect(s.stopped).toBe(false);
	expect(s.fail()).toBe("go");
});

test("'계속 이 모델' (revert: false) set in the settings editor survives storage and the OmO chain, so the entry stays", () => {
	const [kept] = chainOf([{ model: "anthropic/claude-sonnet-5-5", revert: false }]);
	expect(kept).toEqual({ model: "anthropic/claude-sonnet-5-5", revert: false });
	expect(isPlain(kept)).toBe(false);
	const [driven] = hubChain("omo", [kept])!;
	expect(driven.revert).toBe(false);
	const c = new Chain("anthropic/claude-opus-5-5", [driven], "medium");
	c.active = 1;
	expect(c.revertTarget(T0)).toBeUndefined();
	// A bare entry still goes back by default.
	expect(hubChain("omo", chainOf(["anthropic/claude-sonnet-5-5"]))![0].revert).toBe(true);
});
