// The guarded nightly fresh start: one at-rest test shared with the compaction ahead of time, a start that waits for rest and gives the night up
// after NIGHTLY_RETRY_MS, the config switch, and the one log line after a start.
import { afterEach, expect, test } from "bun:test";
import { newCtx, REST_QUIET_MS, type RestFacts, restBlockers, restGuard } from "./context.ts";
import { createNightly, NIGHTLY_COMPACT_STARTS, NIGHTLY_RETRY_MS } from "./nightly-fresh.ts";
import { advance } from "./runtime/test-clock.ts";
import { clearTrackedTimers } from "./shutdown.ts";

const REST: RestFacts = { alive: true, canAbort: true, idle: true, switching: false, failing: false, held: 0, workers: 0, limitHold: false, quietMs: REST_QUIET_MS };
const MIN = 60_000;

afterEach(() => {
	restGuard.blocked = () => false;
	clearTrackedTimers();
});

test("every open condition keeps a session from being at rest, and a session with none is at rest", () => {
	const refused: [string, Partial<RestFacts>][] = [
		["no live process", { alive: false }],
		["a turn or a pause", { idle: false }],
		["a pending restart, rotation or model switch", { switching: true }],
		["an error or an error streak", { failing: true }],
		["a held or unstarted prompt", { held: 1 }],
		["a running worker", { workers: 1 }],
		["an armed usage-limit resume timer", { limitHold: true }],
		["a turn that ended a minute ago", { quietMs: MIN }],
	];
	for (const [name, over] of refused) expect(restBlockers({ ...REST, ...over }, newCtx()), name).toHaveLength(1);
	for (const state of ["queued", "compacting"] as const) {
		const ctx = newCtx();
		ctx.compaction.state = state;
		expect(restBlockers(REST, ctx), `compaction ${state}`).toHaveLength(1);
	}
	restGuard.blocked = () => true;
	expect(restBlockers(REST, newCtx()), "an open, queued or deferred request").toHaveLength(1);
	restGuard.blocked = () => false;
	expect(restBlockers(REST, newCtx())).toEqual([]);
});

function night(over: Partial<RestFacts> = {}, opts: { every?: boolean; bytes?: number } = {}) {
	const lines: string[] = [];
	const ctx = newCtx();
	const state = { facts: { ...REST, ...over }, rotated: 0, open: 2 };
	const n = createNightly({ who: "orchestrator", every: () => opts.every ?? true, bytes: () => opts.bytes ?? 1e6, facts: () => state.facts, ctx: () => ctx, rotate: () => void state.rotated++, open: () => state.open, log: l => lines.push(l) });
	return { n, state, lines, ctx };
}

test("a busy night asks again every minute, starts as soon as the session is at rest, and does it once", async () => {
	const { n, state, lines } = night({ held: 1 });
	expect(n.ask(50e6)).toBeUndefined();
	expect(n.waiting()).toBe(true);
	await advance(30 * MIN);
	expect(state.rotated).toBe(0);
	state.facts = REST;
	await advance(MIN);
	expect(state.rotated).toBe(1);
	expect(n.waiting()).toBe(false);
	expect(lines).toHaveLength(1);
	await advance(NIGHTLY_RETRY_MS);
	expect(state.rotated).toBe(1);
	expect(lines).toHaveLength(1);
});

test("a night that never gets quiet is skipped after the cutoff with one log line, and nothing starts later", async () => {
	const { n, state, lines } = night({ workers: 1 });
	expect(n.ask(50e6)).toBeUndefined();
	await advance(NIGHTLY_RETRY_MS - MIN);
	expect(n.waiting()).toBe(true);
	expect(lines).toEqual([]);
	await advance(2 * MIN);
	expect(n.waiting()).toBe(false);
	expect(lines).toHaveLength(1);
	state.facts = REST;
	await advance(3_600_000);
	expect(state.rotated).toBe(0);
	expect(lines).toHaveLength(1);
});

test("at rest the start happens at once and returns what it did", () => {
	const { n, state } = night();
	expect(n.ask(50e6)).toBeDefined();
	expect(state.rotated).toBe(1);
	expect(n.waiting()).toBe(false);
});

test("without the nightly switch only a file past the limit starts fresh; with it a small file does too", () => {
	const off = night({}, { every: false, bytes: 1e6 });
	expect(off.n.ask(50e6)).toBeUndefined();
	expect(off.n.waiting()).toBe(false);
	expect(off.state.rotated).toBe(0);
	const big = night({}, { every: false, bytes: 60e6 });
	expect(big.n.ask(50e6)).toBeDefined();
	expect(big.state.rotated).toBe(1);
	const on = night({}, { every: true, bytes: 1e6 });
	expect(on.n.ask(50e6)).toBeDefined();
	expect(on.state.rotated).toBe(1);
});

test("after the start the one line gives the tokens before, the requests carried and the handover size; the ledger count is compared before and after", () => {
	const { n, state, lines, ctx } = night();
	ctx.tokens = 123_456;
	n.ask(50e6);
	expect(n.started(4321)).toEqual({ tokens: 123_456, before: 2, after: 2, chars: 4321, why: expect.any(String) });
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("123456");
	expect(lines[0]).toContain("4321");

	const lost = night();
	lost.n.ask(50e6);
	lost.state.open = 1;
	const start = lost.n.started(10)!;
	expect([start.before, start.after]).toEqual([2, 1]);
	expect(lost.lines[0]).not.toBe(lines[0]);
	expect(state.rotated).toBe(1);
});

test("a fresh start for another reason settles a waiting nightly one", async () => {
	const { n, state, lines } = night({ held: 1 });
	n.ask(50e6);
	expect(n.started(0)).toBeUndefined();
	expect(n.waiting()).toBe(false);
	state.facts = REST;
	await advance(NIGHTLY_RETRY_MS + MIN);
	expect(state.rotated).toBe(0);
	expect(lines).toEqual([]);
});

// The nightly start with a summary that may be stale: the compaction is started through deps.compact (the ctx plays the runtime's part).
function staleNight(over: Partial<RestFacts> = {}, stale = true) {
	const base = night(over);
	const w = { stale, compactions: 0, canStart: true };
	const n = createNightly({
		who: "orchestrator", every: () => true, bytes: () => 1e6, facts: () => base.state.facts, ctx: () => base.ctx, rotate: () => void base.state.rotated++, open: () => 0, log: l => base.lines.push(l),
		stale: () => w.stale,
		compact: () => {
			if (!w.canStart) return false;
			w.compactions++;
			base.ctx.compaction = { state: "compacting" };
			return true;
		},
	});
	return { ...base, n, w };
}

test("a stale summary is compacted first: nothing rotates until the compaction has ended, then the start follows on the next minute tick with the seconds in the line", async () => {
	const { n, state, w, ctx, lines } = staleNight();
	expect(n.ask(50e6)).toBeUndefined();
	expect(w.compactions).toBe(1);
	expect(state.rotated).toBe(0);
	await advance(5 * MIN);
	expect(state.rotated).toBe(0);
	expect(w.compactions).toBe(1);
	ctx.compaction = { state: "done" };
	w.stale = false;
	await advance(MIN);
	expect(state.rotated).toBe(1);
	expect(w.compactions).toBe(1);
	expect(n.started(100)?.compacted).toBe(6 * 60);
	expect(lines).toHaveLength(2);
});

test("a summary that is not stale rotates at once with no compaction, and the line says none ran", () => {
	const { n, state, w, lines } = staleNight({}, false);
	expect(n.ask(50e6)).toBeDefined();
	expect(state.rotated).toBe(1);
	expect(w.compactions).toBe(0);
	expect(n.started(100)?.compacted).toBeUndefined();
	expect(lines).toHaveLength(1);
});

test("a runtime that cannot abort a compaction rotates at once without one", () => {
	const { n, state, w } = staleNight({ canAbort: false });
	expect(n.ask(50e6)).toBeDefined();
	expect(state.rotated).toBe(1);
	expect(w.compactions).toBe(0);
});

test("a compaction aborted by an owner message lets the night go on: stale again after the owner's turn it compacts once more, then rotates", async () => {
	const { n, state, w, ctx, lines } = staleNight();
	n.ask(50e6);
	ctx.compaction = {};
	state.facts = { ...REST, idle: false };
	await advance(MIN);
	expect(state.rotated).toBe(0);
	expect(w.compactions).toBe(1);
	state.facts = { ...REST, quietMs: 0 };
	await advance(MIN);
	expect(w.compactions).toBe(1);
	state.facts = REST;
	await advance(MIN);
	expect(w.compactions).toBe(2);
	ctx.compaction = { state: "done" };
	w.stale = false;
	await advance(MIN);
	expect(state.rotated).toBe(1);
	expect(lines).toHaveLength(1);
});

test("a second abort, a compaction error, or a summary stale again after the last allowed compaction skips the night with one log line", async () => {
	for (const ending of ["second abort", "error", "stale again"]) {
		const { n, state, w, ctx, lines } = staleNight();
		n.ask(50e6);
		if (ending === "error") ctx.compaction = { state: "error", error: "boom" };
		else {
			ctx.compaction = {};
			await advance(MIN);
			expect(w.compactions, ending).toBe(2);
			ctx.compaction = ending === "second abort" ? {} : { state: "done" };
			// The owner's turn is still running after the second abort: the night is given up already, it does not wait for rest.
			if (ending === "second abort") state.facts = { ...REST, idle: false };
		}
		await advance(MIN);
		expect(state.rotated, ending).toBe(0);
		expect(w.compactions, ending).toBe(ending === "error" ? 1 : NIGHTLY_COMPACT_STARTS);
		expect(lines, ending).toHaveLength(1);
		expect(n.waiting(), ending).toBe(false);
		state.facts = { ...REST };
		await advance(NIGHTLY_RETRY_MS);
		expect(state.rotated, ending).toBe(0);
		expect(lines, ending).toHaveLength(1);
	}
});
