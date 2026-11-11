import { expect, test } from "bun:test";
import { BOARD_URL, boardRows, collectFromBoard, fetchCapped } from "./effort-collect.ts";
import { benchmarkEffort, cleanRows } from "./effort-knee.ts";

const tr = (...cells: string[]): string => `<tr class="x">${cells.map((c, i) => (i === 0 ? `<th class="a"><button>${c}</button></th>` : `<td class="b"><span>${c}</span></td>`)).join("")}</tr>`;
const row = (name: string, score: string, cost: string, min = "3.0"): string => tr(name, "1M", "Anthropic", score, cost, min, "5.00", "Model Providers");
const PAGE = `<html><body><table>
${tr("", "Features", "Intelligence", "Price", "Speed", "Latency", "")}
${tr("Model", "Context Window", "Creator", "Artificial Analysis Intelligence Index", "Cost per Task USD", "Time per Task Minutes", "First Answer Token (s)", "Further Analysis")}
${row("Claude Sonnet 5.5 (max)", "55", "$10.02", "32.7")}
${row("Claude Sonnet 5.5 (xhigh)", "50", "$4.09", "14.6")}
${row("Claude Sonnet 5.5 (high)", "42", "$1.64", "6.9")}
${row("Claude Sonnet 5.5 (medium)", "31", "$0.78", "3.7")}
${row("Claude Sonnet 5.5 (low)", "26", "$0.51", "2.5")}
${row("Claude Sonnet 5.5 (June 2026)", "99", "$0.01")}
${row("Claude Sonnet 5.5 Ultrafast (high)", "10", "$9.00")}
${row("Claude Sonnet 5 (high)", "11", "$9.00")}
${row("Claude Sonnet 5.55 (high)", "12", "$9.00")}
${row("DeepSeek V4.1 Flash 1017 (max)", "33", "$0.60")}
${row("DeepSeek V4.1 Flash 1017 (high)", "29", "$0.46")}
${row("DeepSeek V4.1 Flash 1017 (non-reasoning)", "19", "$0.43")}
${row("Claude Fable 5.2 (high)", "62", "<script>alert(1)</script>")}
${row("GPT-6.1 Sol (medium)", "46", "$0.36")}
</table></body></html>`;

test("the rows of a model are the ones whose name matches its id, with the effort in the brackets", () => {
	const rows = boardRows(PAGE, "claude-sonnet-5-5");
	expect(rows.map(r => [r.effort, r.score, r.cost])).toEqual([["max", 55, 10.02], ["xhigh", 50, 4.09], ["high", 42, 1.64], ["medium", 31, 0.78], ["low", 26, 0.51]]);
	expect(rows[0]?.minutes).toBe(32.7);
	expect(benchmarkEffort(cleanRows(rows))).toBe("high");
});

test("a build number on the page name and a date on the id are allowed, no-reasoning counts as off, other bracket text is dropped", () => {
	const rows = boardRows(PAGE, "deepseek-v4.1-flash");
	expect(rows.map(r => r.effort).sort()).toEqual(["high", "max", "off"]);
	expect(boardRows(PAGE, "claude-sonnet-5-5-20261001").length).toBe(5);
	expect(boardRows(PAGE, "anthropic/claude-sonnet-5-5").length).toBe(0);
});

test("a cost that is not a number, a page without the table header and a model the page lacks give no rows", () => {
	expect(boardRows(PAGE, "claude-fable-5-2")).toEqual([]);
	expect(boardRows(PAGE, "gpt-9-nothing")).toEqual([]);
	expect(boardRows("<table><tr><td>Claude Sonnet 5.5 (high)</td><td>42</td></tr></table>", "claude-sonnet-5-5")).toEqual([]);
});

test("the collector returns the rows with the board url as the source, and nothing when the page is unreadable or has no rows", async () => {
	const seen: string[] = [];
	const collect = collectFromBoard(async url => (seen.push(url), PAGE));
	const got = await collect("claude-sonnet-5-5");
	expect(seen).toEqual([BOARD_URL]);
	expect(got?.sources).toEqual([{ url: BOARD_URL }]);
	expect(cleanRows(got?.rows).length).toBe(5);
	expect(await collect("gpt-9-nothing")).toBeUndefined();
	expect(await collectFromBoard(async () => undefined)("claude-sonnet-5-5")).toBeUndefined();
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
