import { expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { BOARD_URL, boardRows, collectFromBoard, fetchCapped } from "./effort-collect.ts";
import { benchmarkEffort, cleanRows } from "./effort-knee.ts";

const PAGE = readFileSync(new URL("./fixtures/aa-board-cut.html", import.meta.url), "utf8");

test("the rows of a model are the per-effort records of the page, in its own units, matched by the model id", () => {
	const rows = boardRows(PAGE, "claude-opus-5-5");
	expect(rows.map(r => r.effort)).toEqual(["low", "medium", "high"]);
	const medium = rows[1]!;
	expect(medium.score).toBeCloseTo(48.208, 3);
	expect(medium.cost).toBeCloseTo(2.451, 3);
	expect(medium.minutes).toBeCloseTo(407.238 / 60, 3);
	expect(rows[0]?.score).toBeCloseTo(34.753, 3);
	expect(rows[2]?.cost).toBeCloseTo(3.465, 3);
	expect(benchmarkEffort(cleanRows(rows))).toBe("medium");
});

test("a date on the id is allowed, a build number on the page name is dropped, no-reasoning counts as off, a model that differs only by a version is another model", () => {
	expect(boardRows(PAGE, "claude-opus-5-5-20261001").length).toBe(3);
	expect(boardRows(PAGE, "deepseek-v4.1-flash").map(r => r.effort)).toEqual(["off"]);
	expect(boardRows(PAGE, "claude-opus-5-55").map(r => [r.effort, r.score])).toEqual([["high", 99.5]]);
	expect(boardRows(PAGE, "anthropic/claude-opus-5-5")).toEqual([]);
});

test("a record without a score or a cost, a model the page lacks and a page without records give no rows", () => {
	expect(boardRows(PAGE, "nova-2.0-lite")).toEqual([]);
	expect(boardRows(PAGE, "gemma-4-31b")).toEqual([]);
	expect(boardRows(PAGE, "gpt-9-nothing")).toEqual([]);
	expect(boardRows("<table><tr><th>Claude Opus 5.5 Max, Default Fallback</th><td>59</td></tr></table>", "claude-opus-5-5")).toEqual([]);
	expect(boardRows(PAGE, "claude-haiku-5-5").map(r => r.effort)).toEqual(["high"]);
});

test("the collector returns the rows with the board url as the source, and nothing when the page is unreadable or has no rows", async () => {
	const seen: string[] = [];
	const collect = collectFromBoard(async url => (seen.push(url), PAGE));
	const got = await collect("claude-opus-5-5");
	expect(seen).toEqual([BOARD_URL]);
	expect(got?.sources).toEqual([{ url: BOARD_URL }]);
	expect(cleanRows(got?.rows).length).toBe(3);
	expect(await collect("gpt-9-nothing")).toBeUndefined();
	expect(await collectFromBoard(async () => undefined)("claude-opus-5-5")).toBeUndefined();
});

const streamOf = (chunks: string[]): Response => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { status: 200 });

test("fetchCapped sends a timeout signal, reads a body within the cap and refuses one over it or a non-200", async () => {
	let signal: AbortSignal | undefined;
	const fetchFn = async (_u: string, init: { signal: AbortSignal }) => ((signal = init.signal), streamOf(["abc", "def"]));
	expect(await fetchCapped("https://x.example/", fetchFn, 6)).toBe("abcdef");
	expect(signal).toBeInstanceOf(AbortSignal);
	expect(await fetchCapped("https://x.example/", async () => streamOf(["abc", "defg"]), 6)).toBeUndefined();
	expect(await fetchCapped("https://x.example/", async () => new Response("no", { status: 503 }), 6)).toBeUndefined();
});

const record = (label: string, fields: Record<string, unknown>, nameFirst = true): string => {
	const own = [["name", `Claude Opus 5.5 (${label})`], ["shortName", `Claude Opus 5.5 (${label.toLowerCase()})`]] as const;
	const rest = Object.entries(fields);
	return JSON.stringify(Object.fromEntries(nameFirst ? [...own, ...rest] : [...rest, ...own]));
};
const pageOf = (...items: string[]): string => `[${items.join(",")}]`;
const escaped = (json: string): string => json.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
const opus = (page: string) => boardRows(page, "claude-opus-5-5");

test("a record without a cost gives no row even when a neighbour that is no model record carries a cost", () => {
	const page = pageOf(record("High", { intelligenceIndex: 50 }), JSON.stringify({ kind: "ad", intelligenceIndexCostPerTask: 999.5 }));
	expect(opus(page)).toEqual([]);
	expect(opus(escaped(page))).toEqual([]);
});

test("a record whose metrics come before its name keeps its own numbers, and its neighbour keeps its own", () => {
	const page = pageOf(
		record("Low", { intelligenceIndex: 30, intelligenceIndexCostPerTask: 1.5, intelligenceIndexTimePerTask: 60 }, false),
		record("High", { intelligenceIndex: 50, intelligenceIndexCostPerTask: 3.5, intelligenceIndexTimePerTask: 120 }, false),
	);
	for (const p of [page, escaped(page)]) expect(opus(p)).toEqual([{ effort: "low", score: 30, cost: 1.5, minutes: 1 }, { effort: "high", score: 50, cost: 3.5, minutes: 2 }]);
});

test("a cost-less last record with nothing after it gives no row", () => {
	expect(opus(pageOf(record("High", { intelligenceIndex: 50 })))).toEqual([]);
});

test("only the top-level numbers of the record count: not a nested object's, not a null, not a string", () => {
	const nested = record("High", { intelligenceIndex: 50, scores: { intelligenceIndexCostPerTask: 7 } });
	expect(opus(pageOf(nested))).toEqual([]);
	expect(opus(pageOf(record("High", { intelligenceIndex: 50, intelligenceIndexCostPerTask: null })))).toEqual([]);
	expect(opus(pageOf(record("High", { intelligenceIndex: 50, intelligenceIndexCostPerTask: "3" })))).toEqual([]);
	expect(opus(pageOf(record("High", { scores: { intelligenceIndex: 1 }, intelligenceIndex: 50, intelligenceIndexCostPerTask: 3 })))).toEqual([{ effort: "high", score: 50, cost: 3 }]);
});

test("braces and quotes inside a record's strings do not move its end, and an object that does not parse gives no row", () => {
	const tricky = record("High", { note: 'a } "{" \\ end}', intelligenceIndex: 50, intelligenceIndexCostPerTask: 3 });
	expect(opus(escaped(pageOf(tricky, record("Low", { intelligenceIndex: 30, intelligenceIndexCostPerTask: 1 }))))).toEqual([{ effort: "high", score: 50, cost: 3 }, { effort: "low", score: 30, cost: 1 }]);
	const broken = record("High", { intelligenceIndex: 50, intelligenceIndexCostPerTask: 3 }).replace(',"intelligenceIndex"', ',,"intelligenceIndex"');
	expect(opus(pageOf(broken))).toEqual([]);
});

test("a record larger than the size limit is skipped and the next one is still read", () => {
	const huge = record("High", { filler: "x".repeat(40_000), intelligenceIndex: 50, intelligenceIndexCostPerTask: 3 });
	expect(opus(pageOf(huge, record("Low", { intelligenceIndex: 30, intelligenceIndexCostPerTask: 1 })))).toEqual([{ effort: "low", score: 30, cost: 1 }]);
});

test("a 4 MB page of unclosed braces and repeated record heads is read within the test timeout", () => {
	const head = '{"name":"Claude Opus 5.5 (High)","shortName":"s",';
	const page = "{".repeat(8_000) + head.repeat(Math.floor((4 * 1024 * 1024) / head.length));
	expect(opus(page)).toEqual([]);
});

test("property: every row comes from its own record whatever the field order, decoy neighbours and quoting", () => {
	const metric = fc.double({ min: 0.001, max: 99, noNaN: true, noDefaultInfinity: true });
	const entry = fc.record({
		effort: fc.constantFrom("Low", "Medium", "High", "XHigh", "Max"),
		score: metric,
		cost: fc.option(metric, { nil: undefined }),
		nameFirst: fc.boolean(),
		decoy: fc.option(metric, { nil: undefined }),
	});
	fc.assert(fc.property(fc.uniqueArray(entry, { selector: e => e.effort, maxLength: 5 }), fc.boolean(), (entries, esc) => {
		const items: string[] = [];
		for (const e of entries) {
			items.push(record(e.effort, { intelligenceIndex: e.score, ...(e.cost !== undefined ? { intelligenceIndexCostPerTask: e.cost } : {}) }, e.nameFirst));
			if (e.decoy !== undefined) items.push(JSON.stringify({ intelligenceIndexCostPerTask: e.decoy, intelligenceIndex: e.decoy }));
		}
		const page = pageOf(...items);
		const want = entries.filter(e => e.cost !== undefined).map(e => ({ effort: e.effort.toLowerCase(), score: e.score, cost: e.cost }));
		expect(opus(esc ? escaped(page) : page)).toEqual(want);
	}), { numRuns: 200 });
});
