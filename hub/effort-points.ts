import type { EffortRow } from "./effort-knee.ts";
import { bareId, isId } from "./model-effort.ts";

/** Where the shipped per-effort rows were read: the Artificial Analysis leaderboard page, on this date. */
export const POINTS_SOURCE = { url: "https://artificialanalysis.ai/leaderboards/models", read: "2026-11-23" } as const;

const POINTS: ReadonlyArray<readonly [id: string, rows: EffortRow[]]> = [
	["claude-fable-5-2", [
		{ effort: "low", score: 53.92, cost: 3.1, minutes: 5.5 },
		{ effort: "medium", score: 56.41, cost: 3.8, minutes: 6.6 },
		{ effort: "high", score: 61.82, cost: 9.08, minutes: 14.8 },
		{ effort: "xhigh", score: 62.22, cost: 14.83, minutes: 24.3 },
		{ effort: "max", score: 64.56, cost: 26.54, minutes: 41.4 },
	]],
	["claude-opus-5-5", [
		{ effort: "low", score: 34.75, cost: 0.98, minutes: 3.1 },
		{ effort: "medium", score: 48.21, cost: 2.45, minutes: 6.8 },
		{ effort: "high", score: 51.84, cost: 3.46, minutes: 9.3 },
		{ effort: "xhigh", score: 57.44, cost: 6.05, minutes: 15.6 },
		{ effort: "max", score: 59.11, cost: 10.04, minutes: 25.2 },
	]],
	["claude-sonnet-5-5", [
		{ effort: "low", score: 25.65, cost: 0.51, minutes: 2.6 },
		{ effort: "medium", score: 30.82, cost: 0.78, minutes: 3.7 },
		{ effort: "high", score: 41.52, cost: 1.64, minutes: 6.9 },
		{ effort: "xhigh", score: 49.92, cost: 4.09, minutes: 14 },
		{ effort: "max", score: 54.54, cost: 10.02, minutes: 31.4 },
	]],
	["claude-haiku-5-5", [
		{ effort: "low", score: 18.62, cost: 0.04, minutes: 2.1 },
		{ effort: "medium", score: 24.6, cost: 0.09, minutes: 4 },
		{ effort: "high", score: 29.87, cost: 0.16, minutes: 6.5 },
		{ effort: "xhigh", score: 34.64, cost: 0.25, minutes: 9.5 },
		{ effort: "max", score: 36.48, cost: 0.41, minutes: 14.7 },
	]],
	["deepseek-v4.1-flash", [
		{ effort: "off", score: 18.51, cost: 0.43, minutes: 6.4 },
		{ effort: "high", score: 28.64, cost: 0.46, minutes: 10.7 },
		{ effort: "max", score: 32.59, cost: 0.6, minutes: 13.9 },
	]],
	["gpt-6-luna", [
		{ effort: "off", score: 9.44, cost: 0.07, minutes: 1.8 },
		{ effort: "low", score: 9.67, cost: 0.01, minutes: 0.6 },
		{ effort: "medium", score: 18.45, cost: 0.04, minutes: 3.4 },
		{ effort: "high", score: 21.43, cost: 0.07, minutes: 5.5 },
		{ effort: "xhigh", score: 23.45, cost: 0.1, minutes: 6.9 },
		{ effort: "max", score: 27.86, cost: 0.15, minutes: 11.5 },
	]],
];

/** The shipped rows of a model given as a selector or an id (`anthropic/claude-opus-5-5:medium`, `claude-opus-5-5-20261001`); a model without rows gives an empty list. */
export const shippedRows = (model: string): readonly EffortRow[] => {
	const bare = bareId(model);
	return POINTS.find(([id]) => isId(bare, id))?.[1] ?? [];
};
