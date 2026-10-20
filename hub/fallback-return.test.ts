// Going back to the subscription after a usage limit (2026-10-20: an API-key fallback stayed ~30 min after the limit reset,
// because only a bare entry was marked to revert), probing a limited primary at a bounded interval, and stopping after a run
// of failed turns. Tests the chain logic itself.
import { afterEach, expect, test } from "bun:test";
import { Chain, clock, ErrorStreak, ERROR_STREAK_STOP, resetFallbackState, REVERT_PROBE_MS } from "./fallback.ts";

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

test("a primary out on a usage limit is tried again every REVERT_PROBE_MS, not only when its estimated reset passes", () => {
	resetFallbackState();
	const entries = [{ model: "anthropic/claude-sonnet-5-5", when: "quota" as const }];
	const first = new Chain("anthropic/claude-opus-5-5", entries, "medium");
	expect(first.fail("quota", T0 + 5 * 3_600_000, T0)).toEqual({ from: 0, to: 1, why: "quota" });
	const onFallback = new Chain("anthropic/claude-opus-5-5", entries, "medium");
	onFallback.active = 1;
	expect(onFallback.revertTarget(T0 + REVERT_PROBE_MS - 1)).toBeUndefined();
	expect(onFallback.revertTarget(T0 + REVERT_PROBE_MS)).toEqual({ from: 1, to: 0, why: "revert" });
	// The probe failed: the limit is written again, and the next probe waits a full interval from then.
	const t1 = T0 + REVERT_PROBE_MS + 1000;
	const probe = new Chain("anthropic/claude-opus-5-5", entries, "medium");
	expect(probe.fail("quota", T0 + 5 * 3_600_000, t1)?.to).toBe(1);
	onFallback.active = 1;
	expect(onFallback.revertTarget(t1 + 60_000)).toBeUndefined();
	expect(onFallback.revertTarget(t1 + REVERT_PROBE_MS)?.to).toBe(0);
	// A short provider-error block is not probed: it simply ends.
	resetFallbackState();
	new Chain("anthropic/claude-opus-5-5", entries, "medium").fail("error", T0 + 10 * 3_600_000, T0);
	expect(onFallback.revertTarget(T0 + REVERT_PROBE_MS)).toBeUndefined();
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
