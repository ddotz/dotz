import { expect, test } from "bun:test";
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
