import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { shippedRows } from "./effort-points.ts";
import { type EffortRow } from "./effort-knee.ts";
import { ROUTE_MIN_GAIN, workerRoutes } from "./effort-route.ts";
import { EFFORT_ORDER, type Effort } from "./model-effort.ts";

const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const expensive = (selector: string): string | undefined => (/:(xhigh|max)$/.test(selector) || selector.includes("fable") ? "owner only" : undefined);
const shipped = { rowsOf: shippedRows, ownerOnly: expensive };

describe("shipped points", () => {
	test("a selector and a dated id find the same rows; an unknown model has none", () => {
		expect(shippedRows("anthropic/claude-opus-5-5:medium")).toEqual(shippedRows("claude-opus-5-5-20261001"));
		expect(shippedRows("claude-opus-5-5").map(r => r.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(shippedRows("x/new-model:medium")).toEqual([]);
	});
});

describe("routes on the shipped rows", () => {
	test("opus medium with opus, sonnet and haiku: opus high up, haiku high down", () => {
		const r = workerRoutes({ ...shipped, anchor: `${OPUS}:medium`, candidates: [OPUS, SONNET, HAIKU] });
		expect(r.standard).toEqual({ selector: `${OPUS}:medium`, basis: "configured", score: 48.21, cost: 2.45 });
		expect(r.hard).toEqual({ selector: `${OPUS}:high`, basis: "benchmark", score: 51.84, cost: 3.46 });
		expect(r.light).toEqual({ selector: `${HAIKU}:high`, basis: "benchmark", score: 29.87, cost: 0.16 });
	});

	test("opus medium with opus only: light is opus low", () => {
		const r = workerRoutes({ ...shipped, anchor: `${OPUS}:medium`, candidates: [OPUS] });
		expect(r.light.selector).toBe(`${OPUS}:low`);
		expect(r.hard.selector).toBe(`${OPUS}:high`);
	});

	test("sonnet high with sonnet and opus: opus medium up, opus low down", () => {
		const r = workerRoutes({ ...shipped, anchor: `${SONNET}:high`, candidates: [SONNET, OPUS] });
		expect(r.hard.selector).toBe(`${OPUS}:medium`);
		expect(r.light.selector).toBe(`${OPUS}:low`);
	});

	test("the anchor's own model is a candidate even when the list omits it", () => {
		const r = workerRoutes({ ...shipped, anchor: `${OPUS}:medium`, candidates: [] });
		expect([r.hard.selector, r.light.selector]).toEqual([`${OPUS}:high`, `${OPUS}:low`]);
	});

	test("the same id under two providers is two models: one flagged leaves the other", () => {
		const rowsOf = (model: string): readonly EffortRow[] => (model === "p/a" ? [{ effort: "medium", score: 50, cost: 5 }] : [{ effort: "low", score: 45, cost: 1 }]);
		const both = workerRoutes({ rowsOf, ownerOnly: () => undefined, anchor: "p/a:medium", candidates: ["y/b", "x/b"] });
		expect(both.light.selector).toBe("x/b:low");
		const flagged = workerRoutes({ rowsOf, ownerOnly: s => (s === "x/b:low" ? "owner only" : undefined), anchor: "p/a:medium", candidates: ["y/b", "x/b"] });
		expect(flagged.light.selector).toBe("y/b:low");
	});

	test("hard takes the best score among points that cost no more than the anchor before paying more", () => {
		const rows: Record<string, EffortRow[]> = { "p/a": [{ effort: "medium", score: 50, cost: 5 }], "p/b": [{ effort: "medium", score: 55, cost: 2 }, { effort: "high", score: 60, cost: 4 }], "p/c": [{ effort: "high", score: 70, cost: 9 }] };
		const r = workerRoutes({ rowsOf: m => rows[m] ?? [], ownerOnly: () => undefined, anchor: "p/a:medium", candidates: ["p/b", "p/c"] });
		expect(r.hard).toEqual({ selector: "p/b:high", basis: "benchmark", score: 60, cost: 4 });
	});

	test("hard ties on gain per dollar go to the cheaper point", () => {
		const rows: Record<string, EffortRow[]> = { "p/a": [{ effort: "medium", score: 50, cost: 5 }], "p/b": [{ effort: "high", score: 52, cost: 6 }], "p/c": [{ effort: "high", score: 54, cost: 7 }] };
		const r = workerRoutes({ rowsOf: m => rows[m] ?? [], ownerOnly: () => undefined, anchor: "p/a:medium", candidates: ["p/c", "p/b"] });
		expect(r.hard.selector).toBe("p/b:high");
	});

	test("a point that is barely cheaper and barely worse does not beat a real saving", () => {
		const rows: Record<string, EffortRow[]> = { "p/a": [{ effort: "medium", score: 50, cost: 5 }], "p/b": [{ effort: "low", score: 49.9, cost: 4.9 }], "p/c": [{ effort: "low", score: 40, cost: 2 }] };
		const r = workerRoutes({ rowsOf: m => rows[m] ?? [], ownerOnly: () => undefined, anchor: "p/a:medium", candidates: ["p/b", "p/c"] });
		expect(r.light.selector).toBe("p/c:low");
	});

	test("two rows for one effort count as the first", () => {
		const rows: Record<string, EffortRow[]> = { "p/a": [{ effort: "medium", score: 50, cost: 5 }], "p/b": [{ effort: "high", score: 52, cost: 6 }, { effort: "high", score: 45, cost: 1 }] };
		const r = workerRoutes({ rowsOf: m => rows[m] ?? [], ownerOnly: () => undefined, anchor: "p/a:medium", candidates: ["p/b"] });
		expect(r.hard).toEqual({ selector: "p/b:high", basis: "benchmark", score: 52, cost: 6 });
		expect(r.light).toEqual(r.standard);
	});

	test("without the owner-only filter xhigh and fable would route; with it they never do", () => {
		const open = workerRoutes({ ...shipped, ownerOnly: () => undefined, anchor: `${OPUS}:high`, candidates: [OPUS, "anthropic/claude-fable-5-2"] });
		expect(open.hard.selector).toMatch(/xhigh|max|fable/);
		const guarded = workerRoutes({ ...shipped, anchor: `${OPUS}:high`, candidates: [OPUS, "anthropic/claude-fable-5-2"] });
		expect(guarded.hard).toEqual(guarded.standard);
	});

	test("a level the model does not list is never routed to", () => {
		const r = workerRoutes({ ...shipped, anchor: `${OPUS}:medium`, candidates: [OPUS, HAIKU], levelsOf: model => (model.includes("haiku") ? ["low", "medium"] : undefined) });
		expect(r.light.selector).toBe(`${OPUS}:low`);
		expect(workerRoutes({ ...shipped, anchor: `${OPUS}:medium`, candidates: [OPUS, HAIKU] }).light.selector).toBe(`${HAIKU}:high`);
	});

	test("off and minimal rows never route", () => {
		const rowsOf = (model: string): readonly EffortRow[] => (model === "p/a" ? [{ effort: "medium", score: 50, cost: 5 }] : [{ effort: "off", score: 90, cost: 0.1 }, { effort: "minimal", score: 90, cost: 0.1 }]);
		const r = workerRoutes({ rowsOf, ownerOnly: () => undefined, anchor: "p/a:medium", candidates: ["p/b"] });
		expect(r.hard).toEqual(r.standard);
		expect(r.light).toEqual(r.standard);
	});
});

describe("the ladder for a model without rows", () => {
	test("one level up and one down on the same model", () => {
		const r = workerRoutes({ ...shipped, anchor: "x/new-model:medium", candidates: ["x/new-model"] });
		expect(r).toEqual({ light: { selector: "x/new-model:low", basis: "ladder" }, standard: { selector: "x/new-model:medium", basis: "configured" }, hard: { selector: "x/new-model:high", basis: "ladder" } });
	});

	test("an owner-only or unlisted level is skipped, and no level left keeps the anchor", () => {
		const r = workerRoutes({ ...shipped, anchor: "x/new-model:high", candidates: [] });
		expect(r.hard).toEqual(r.standard);
		const listed = workerRoutes({ ...shipped, anchor: "x/new-model:low", candidates: [], levelsOf: () => ["low", "high"] });
		expect(listed.hard.selector).toBe("x/new-model:high");
	});

	test("levels with no ladder position keep the anchor", () => {
		for (const level of ["none", "off", "minimal", "auto"]) {
			const r = workerRoutes({ ...shipped, anchor: `x/new-model:${level}`, candidates: [] });
			expect(r.hard).toEqual(r.standard);
			expect(r.light).toEqual(r.standard);
		}
	});

	test("an anchor level missing from its model's rows falls back to the ladder", () => {
		const r = workerRoutes({ ...shipped, anchor: "x/deepseek-v4.1-flash:medium", candidates: [] });
		expect([r.hard.selector, r.light.selector]).toEqual(["x/deepseek-v4.1-flash:high", "x/deepseek-v4.1-flash:low"]);
		expect([r.hard.basis, r.light.basis]).toEqual(["ladder", "ladder"]);
	});
});

const MODELS = ["p/a", "p/b", "p/c"] as const;
const LEVELS: readonly Effort[] = EFFORT_ORDER;
const ANCHOR_LEVELS = [...EFFORT_ORDER, "none", "auto"] as const;
const ROUTABLE: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

const rowsFor = fc.subarray([...LEVELS]).chain(levels => fc.tuple(...levels.map(effort => fc.record({ effort: fc.constant(effort), score: fc.integer({ min: 0, max: 100 }), cost: fc.integer({ min: 0, max: 50 }).map(c => c / 4) }))));
const world = fc.record({
	rows: fc.tuple(rowsFor, rowsFor, rowsFor),
	anchorModel: fc.constantFrom(...MODELS),
	anchorLevel: fc.constantFrom(...ANCHOR_LEVELS),
	candidates: fc.subarray([...MODELS]),
	flagged: fc.subarray(MODELS.flatMap(m => LEVELS.map(l => `${m}:${l}`))),
	listed: fc.tuple(...MODELS.map(() => fc.option(fc.subarray([...LEVELS]), { nil: undefined }))),
});
type World = typeof world extends fc.Arbitrary<infer T> ? T : never;

const run = (w: World, candidates: readonly string[] = w.candidates) =>
	workerRoutes({
		anchor: `${w.anchorModel}:${w.anchorLevel}`,
		candidates,
		rowsOf: model => w.rows[MODELS.indexOf(model as (typeof MODELS)[number])] ?? [],
		ownerOnly: selector => (w.flagged.includes(selector) ? "owner only" : undefined),
		levelsOf: model => w.listed[MODELS.indexOf(model as (typeof MODELS)[number])],
	});
const anchorRowOf = (w: World): EffortRow | undefined => w.rows[MODELS.indexOf(w.anchorModel)]?.find(r => r.effort === w.anchorLevel);

describe("properties over generated rows, candidates and owner-only sets", () => {
	test("standard is the anchor verbatim", () => {
		fc.assert(fc.property(world, w => {
			const r = run(w);
			expect(r.standard.selector).toBe(`${w.anchorModel}:${w.anchorLevel}`);
			expect(r.standard.basis).toBe("configured");
		}));
	});

	test("hard and light are never an owner-only point unless they equal the anchor", () => {
		fc.assert(fc.property(world, w => {
			const r = run(w);
			for (const route of [r.hard, r.light]) {
				if (route.selector !== r.standard.selector) expect(w.flagged).not.toContain(route.selector);
			}
		}));
	});

	test("with an anchor row, hard does not lose score and light does not cost more", () => {
		fc.assert(fc.property(world, w => {
			const anchor = anchorRowOf(w);
			fc.pre(anchor !== undefined);
			const r = run(w);
			expect(r.hard.score).toBeGreaterThanOrEqual(anchor!.score);
			expect(r.light.cost).toBeLessThanOrEqual(anchor!.cost);
			for (const route of [r.hard, r.light]) expect(route.basis === "ladder").toBe(false);
		}));
	});

	test("every route is the anchor or an allowed point", () => {
		fc.assert(fc.property(world, w => {
			const r = run(w);
			for (const route of [r.hard, r.light]) {
				if (route.selector === r.standard.selector) {
					expect(route.basis).toBe("configured");
					continue;
				}
				const at = route.selector.lastIndexOf(":");
				const model = route.selector.slice(0, at);
				const level = route.selector.slice(at + 1);
				const idx = MODELS.indexOf(model as (typeof MODELS)[number]);
				expect(w.flagged).not.toContain(route.selector);
				expect(ROUTABLE).toContain(level);
				expect(w.listed[idx] === undefined || w.listed[idx]!.includes(level as Effort)).toBe(true);
				if (route.basis === "ladder") {
					expect(model).toBe(w.anchorModel);
					expect(anchorRowOf(w)).toBeUndefined();
				} else {
					expect(route.basis).toBe("benchmark");
					expect(model === w.anchorModel || w.candidates.includes(model)).toBe(true);
					const row = w.rows[idx]?.find(x => x.effort === level);
					expect([row?.score, row?.cost]).toEqual([route.score, route.cost]);
				}
			}
		}));
	});

	test("candidate order and repeats do not change the result", () => {
		fc.assert(fc.property(world, fc.nat(), (w, shift) => {
			const base = run(w);
			const rotated = w.candidates.length ? [...w.candidates.slice(shift % w.candidates.length), ...w.candidates.slice(0, shift % w.candidates.length)] : [];
			expect(run(w, rotated)).toEqual(base);
			expect(run(w, [...w.candidates].reverse())).toEqual(base);
			expect(run(w, [...w.candidates, ...w.candidates])).toEqual(base);
		}));
	});

	test("a hard route that gains score gains at least the minimum", () => {
		fc.assert(fc.property(world, w => {
			const anchor = anchorRowOf(w);
			fc.pre(anchor !== undefined);
			const r = run(w);
			if (r.hard.selector !== r.standard.selector) expect(r.hard.score! - anchor!.score).toBeGreaterThanOrEqual(ROUTE_MIN_GAIN);
		}));
	});
});
