import { cleanRows, type EffortRow } from "./effort-knee.ts";
import { EFFORT_ORDER, type Effort } from "./model-effort.ts";

export type Difficulty = "light" | "standard" | "hard";
export type Route = { selector: string; basis: "configured" | "benchmark" | "ladder"; score?: number; cost?: number };
export type WorkerRoutes = Record<Difficulty, Route>;

/** The least score a hard route must gain over the configured level. */
export const ROUTE_MIN_GAIN = 1;

const LADDER: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const isLevel = (v: string): boolean => (EFFORT_ORDER as readonly string[]).includes(v) || v === "none" || v === "auto";

type Point = { model: string; selector: string; effort: Effort; score: number; cost: number; minutes?: number };
type Anchor = { selector: string; model: string; level: string };
type Better = (a: Point, b: Point) => number;

const splitSelector = (selector: string): { model: string; level: string } => {
	const s = selector.trim();
	const i = s.lastIndexOf(":");
	const level = i > 0 ? s.slice(i + 1).toLowerCase() : "";
	return i > 0 && isLevel(level) ? { model: s.slice(0, i), level } : { model: s, level: "" };
};
const bySelector = (a: Point, b: Point): number => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0);
const descending = (a: number, b: number): number => (a > b ? -1 : a < b ? 1 : 0);
const first = (points: readonly Point[], better: Better): Point | undefined => points.reduce<Point | undefined>((best, p) => (best && better(best, p) <= 0 ? best : p), undefined);

/**
 * Routes a task subagent by difficulty. Standard is the configured worker selector verbatim. Hard and light move to the allowed
 * benchmark point with the best price-performance trade above or below the anchor; without a row for the anchor they step one
 * level up or down the same model. A light point that takes longer than the anchor (both times known) is not allowed. Candidates are
 * `provider/id` selectors: the same id under two providers is two models.
 */
export function workerRoutes(i: {
	anchor: string;
	candidates: readonly string[];
	rowsOf: (model: string) => readonly EffortRow[];
	ownerOnly: (selector: string) => string | undefined;
	levelsOf?: (model: string) => readonly string[] | undefined;
}): WorkerRoutes {
	const parsed = splitSelector(i.anchor);
	const anchor: Anchor = { selector: i.anchor, ...parsed };
	const anchorRow = cleanRows(i.rowsOf(anchor.model)).find(r => r.effort === anchor.level);
	const standard: Route = { selector: anchor.selector, basis: "configured", ...(anchorRow ? { score: anchorRow.score, cost: anchorRow.cost } : {}) };
	const listed = (model: string, level: string): boolean => i.levelsOf?.(model)?.includes(level) ?? true;
	const open = (model: string, level: string): boolean => listed(model, level) && !i.ownerOnly(`${model}:${level}`);

	if (!anchorRow) {
		const at = LADDER.indexOf(anchor.level as Effort);
		const step = (levels: readonly Effort[]): Route => {
			const level = levels.find(l => open(anchor.model, l));
			return level ? { selector: `${anchor.model}:${level}`, basis: "ladder" } : standard;
		};
		if (at < 0) return { light: standard, standard, hard: standard };
		return { light: step(LADDER.slice(0, at).reverse()), standard, hard: step(LADDER.slice(at + 1)) };
	}

	const models = new Set([anchor.model, ...i.candidates.map(c => splitSelector(c).model)]);
	const points: Point[] = [...models].flatMap(model =>
		cleanRows(i.rowsOf(model)).flatMap(r => (LADDER.includes(r.effort) && open(model, r.effort) ? [{ model, selector: `${model}:${r.effort}`, effort: r.effort, score: r.score, cost: r.cost, ...(r.minutes !== undefined ? { minutes: r.minutes } : {}) }] : [])),
	).sort(bySelector);

	const route = (p: Point | undefined): Route => {
		if (!p || (p.model === anchor.model && p.effort === anchor.level)) return standard;
		return { selector: p.selector, basis: "benchmark", score: p.score, cost: p.cost };
	};
	const gain = (p: Point): number => (p.score - anchorRow.score) / (p.cost - anchorRow.cost);
	const saving = (p: Point): number => (anchorRow.cost - p.cost) / Math.max(anchorRow.score - p.score, ROUTE_MIN_GAIN);
	const cheaper: Better = (a, b) => a.cost - b.cost || bySelector(a, b);

	const above = points.filter(p => p.score >= anchorRow.score + ROUTE_MIN_GAIN);
	const free = above.filter(p => p.cost <= anchorRow.cost);
	const hard = free.length
		? first(free, (a, b) => descending(a.score, b.score) || cheaper(a, b))
		: first(above, (a, b) => descending(gain(a), gain(b)) || cheaper(a, b));
	const slower = (p: Point): boolean => p.minutes !== undefined && anchorRow.minutes !== undefined && p.minutes > anchorRow.minutes;
	const light = first(points.filter(p => p.cost < anchorRow.cost && !slower(p)), (a, b) => descending(saving(a), saving(b)) || descending(a.score, b.score) || bySelector(a, b));
	return { light: route(light), standard, hard: route(hard) };
}
