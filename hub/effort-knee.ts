// The sweet-spot rule as one pure function: from a model's published per-effort results (score, cost per task) to its default effort.
// Both axes are scaled to 0..1 over the model's own rows; an effort's value is how far its score is above its cost. The knee is the
// cheapest effort whose value is within KNEE_TOLERANCE of the best value, so a near tie goes to the lower effort (extra cost for
// almost no gain). The stored result never goes above high; sweetSpot clamps it to the levels the model lists (hub/model-effort.ts).
// The research report (handoffs/model-sweet-spot/report.md) computed the same curve by hand; hub/effort-knee.test.ts runs this
// function on the report's own numbers and gets the shipped row for every model except Haiku, whose row rests on vendor guidance.
import { capEffort, EFFORT_ORDER, type Effort } from "./model-effort.ts";

export type EffortRow = { effort: Effort; score: number; cost: number; minutes?: number };
export const KNEE_TOLERANCE = 0.1;
const MIN_ROWS = 3;

const finite = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORT_ORDER as readonly string[]).includes(v);

/** Keeps the rows that are numbers in range with an effort from the fixed list; one row per effort, the first wins. Anything else is dropped. */
export function cleanRows(raw: unknown): EffortRow[] {
	const out = new Map<Effort, EffortRow>();
	for (const r of Array.isArray(raw) ? raw : []) {
		if (!r || typeof r !== "object" || !isEffort(r.effort) || !finite(r.score, 100) || !finite(r.cost, 100_000) || out.has(r.effort)) continue;
		out.set(r.effort, { effort: r.effort, score: r.score, cost: r.cost, ...(finite(r.minutes, 100_000) ? { minutes: r.minutes } : {}) });
	}
	return [...out.values()].sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort));
}

/** The knee of the curve, or undefined when the rows cannot show one (fewer than three efforts, or a flat score or cost). */
export function kneeEffort(rows: readonly EffortRow[]): Effort | undefined {
	const r = cleanRows(rows);
	if (r.length < MIN_ROWS) return undefined;
	const scores = r.map(x => x.score), costs = r.map(x => x.cost);
	const [s0, s1, c0, c1] = [Math.min(...scores), Math.max(...scores), Math.min(...costs), Math.max(...costs)];
	if (s1 === s0 || c1 === c0) return undefined;
	const value = r.map(x => (x.score - s0) / (s1 - s0) - (x.cost - c0) / (c1 - c0));
	const best = Math.max(...value);
	return r[value.findIndex(v => v >= best - KNEE_TOLERANCE - 1e-9)]?.effort;
}

/** The effort to store for a model: the knee, capped at high. Clamping to the model's levels happens where it is read (sweetSpot). */
export const benchmarkEffort = (rows: readonly EffortRow[]): Effort | undefined => {
	const knee = kneeEffort(rows);
	return knee && capEffort(knee);
};
