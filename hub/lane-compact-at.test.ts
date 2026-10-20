// Lane and worker compaction threshold (owner value 2026-10-20: 300K, was 400K). OmO lanes never compacted at it (only the
// omp overlay read it), so the hub compacts an idle lane whose context reached it.
import { expect, test } from "bun:test";
import { GUARD_DEFAULTS } from "../extension/guard-config.ts";
import { cfg, lanesCompactAt } from "./config.ts";
import { compactDue, newCtx } from "./context.ts";

test("defaults: lanes compact at 300K, workers are told a 300K context budget", () => {
	const saved = cfg.lanes;
	cfg.lanes = { ...cfg.lanes, compact_at: undefined };
	try {
		expect(lanesCompactAt()).toBe(300_000);
	} finally {
		cfg.lanes = saved;
	}
	expect(GUARD_DEFAULTS.worker_context_tokens).toBe(300_000);
});

test("an idle lane at or past the threshold is due a compaction; below it, or one already running, is not", () => {
	const c = newCtx();
	c.tokens = 299_999;
	expect(compactDue(c, 300_000)).toBe(false);
	c.tokens = 300_000;
	expect(compactDue(c, 300_000)).toBe(true);
	c.compaction = { state: "compacting", at: 1 };
	expect(compactDue(c, 300_000)).toBe(false);
	c.compaction = { state: "queued", at: 1 };
	expect(compactDue(c, 300_000)).toBe(false);
	c.compaction = { state: "done", at: 1, tokensBefore: 310_000 };
	expect(compactDue(c, 300_000)).toBe(true);
});
