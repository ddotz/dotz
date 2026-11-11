import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkEffort, cleanRows, type EffortRow, kneeEffort } from "./effort-knee.ts";
import { emptyState, learnedOf, loadState, saveState, storeFile } from "./effort-store.ts";
import { type Effort, tableEffort } from "./model-effort.ts";

// The per-effort rows of the research report (handoffs/model-sweet-spot/report.md, Artificial Analysis 2026-11-11): [effort, index, cost per task].
const R = (rows: [Effort, number, number][]): EffortRow[] => rows.map(([effort, score, cost]) => ({ effort, score, cost }));
const REPORT: Record<string, EffortRow[]> = {
	"claude-fable-5-2": R([["low", 54, 3.1], ["medium", 56, 3.8], ["high", 62, 9.08], ["xhigh", 62, 14.83], ["max", 65, 26.54]]),
	"claude-opus-5-5": R([["low", 35, 0.98], ["medium", 48, 2.45], ["high", 52, 3.46], ["xhigh", 57, 6.05], ["max", 59, 10.04]]),
	"claude-sonnet-5-5": R([["low", 26, 0.51], ["medium", 31, 0.78], ["high", 42, 1.64], ["xhigh", 50, 4.09], ["max", 55, 10.02]]),
	"deepseek-v4.1-flash": R([["off", 19, 0.43], ["high", 29, 0.46], ["max", 33, 0.6]]),
	"gpt-6-astra": R([["low", 43, 1.42], ["medium", 52, 2.73], ["high", 55, 3.24], ["xhigh", 55, 3.66], ["max", 57, 6.24]]),
	"gpt-6.1-sol": R([["low", 35, 0.16], ["medium", 46, 0.36], ["high", 50, 0.59], ["xhigh", 52, 0.76], ["max", 55, 1.27]]),
	"gpt-6-luna": R([["low", 10, 0.01], ["medium", 18, 0.04], ["high", 21, 0.07], ["xhigh", 23, 0.1], ["max", 28, 0.15]]),
};
const HAIKU = R([["low", 19, 0.04], ["medium", 25, 0.09], ["high", 30, 0.16], ["xhigh", 35, 0.25], ["max", 36, 0.41]]);

test("the knee rule gives the shipped table row of every model the report has numbers for", () => {
	for (const [id, rows] of Object.entries(REPORT)) expect([id, benchmarkEffort(rows)]).toEqual([id, tableEffort(id)]);
});

test("Haiku is the one row the rule does not reproduce: the shipped medium rests on vendor guidance, the numbers say high", () => {
	expect(tableEffort("claude-haiku-5-5")).toBe("medium");
	expect(benchmarkEffort(HAIKU)).toBe("high");
});

test("a near tie goes to the lower effort, a clear gain to the higher one", () => {
	const flat = R([["low", 30, 1], ["medium", 50, 2], ["high", 52, 3], ["xhigh", 52, 9]]);
	expect(kneeEffort(flat)).toBe("medium");
	const steep = R([["low", 30, 1], ["medium", 40, 2], ["high", 90, 3], ["xhigh", 91, 9]]);
	expect(kneeEffort(steep)).toBe("high");
});

test("the stored effort never goes above high, even when the knee is xhigh", () => {
	const rows = R([["low", 10, 1], ["medium", 12, 1.1], ["high", 14, 1.2], ["xhigh", 90, 1.3], ["max", 91, 50]]);
	expect(kneeEffort(rows)).toBe("xhigh");
	expect(benchmarkEffort(rows)).toBe("high");
});

test("rows that cannot show a knee give nothing", () => {
	expect(kneeEffort(R([["low", 10, 1], ["max", 30, 5]]))).toBeUndefined();
	expect(kneeEffort(R([["low", 10, 1], ["medium", 10, 2], ["high", 10, 3]]))).toBeUndefined();
	expect(kneeEffort(R([["low", 10, 2], ["medium", 20, 2], ["high", 30, 2]]))).toBeUndefined();
});

test("rows with a bad effort, a non-number, a negative or out-of-range value, or a repeated effort are dropped", () => {
	const raw: unknown[] = [
		{ effort: "low", score: 10, cost: 1 },
		{ effort: "turbo", score: 20, cost: 2 },
		{ effort: "medium", score: "20", cost: 2 },
		{ effort: "medium", score: 20, cost: Number.NaN },
		{ effort: "medium", score: -1, cost: 2 },
		{ effort: "medium", score: 101, cost: 2 },
		{ effort: "high", score: 30, cost: 1e9 },
		{ effort: "low", score: 11, cost: 1 },
		{ effort: "xhigh", score: 40, cost: 4, minutes: "soon" },
		null,
		"low",
	];
	expect(cleanRows(raw)).toEqual([{ effort: "low", score: 10, cost: 1 }, { effort: "xhigh", score: 40, cost: 4 }]);
	expect(cleanRows("not rows")).toEqual([]);
});

test("the store keeps a benchmark value across a write and read, and drops hostile fields on the way back", () => {
	const dir = mkdtempSync(join(tmpdir(), "effort-store-"));
	try {
		const at = "2026-11-11T00:00:00.000Z";
		const state = emptyState();
		state.baseline = ["claude-opus-5-5"];
		state.entries["claude-sonnet-5-5"] = { id: "claude-sonnet-5-5", effort: "high", rows: REPORT["claude-sonnet-5-5"]!, sources: [{ url: "https://artificialanalysis.ai/leaderboards/models", at }], at, status: "benchmark" };
		saveState(dir, state);
		expect(loadState(dir)).toEqual(state);
		expect(learnedOf(state).get("claude-sonnet-5-5")).toEqual({ effort: "high", status: "benchmark" });

		writeFileSync(storeFile(dir), JSON.stringify({
			baseline: ["good-id", "../etc/passwd", "UPPER", 5],
			entries: {
				ok: { id: "ok", effort: "medium", rows: [], sources: [], at, status: "provisional" },
				"bad/id": { id: "bad/id", effort: "medium", rows: [], sources: [], at, status: "provisional" },
				badeffort: { id: "badeffort", effort: "ultra", rows: [], sources: [], at, status: "provisional" },
				plainhttp: { id: "plainhttp", effort: "high", rows: REPORT["gpt-6-astra"], sources: [{ url: "http://example.com/x", at }], at, status: "benchmark" },
				norows: { id: "norows", effort: "high", rows: [{ effort: "high", score: "x", cost: 1 }], sources: [{ url: "https://example.com/x", at }], at, status: "benchmark" },
			},
		}));
		const back = loadState(dir);
		expect(back.baseline).toEqual(["good-id"]);
		expect(Object.keys(back.entries)).toEqual(["ok"]);
		writeFileSync(storeFile(dir), "{ not json");
		expect(loadState(dir)).toEqual(emptyState());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
