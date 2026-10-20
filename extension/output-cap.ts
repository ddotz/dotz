// Size caps on tool results in lane processes and their task workers (DOTZ_LANE set; OmO workers run as child processes
// of the lane through its worker profile, hub/runtime/omo.ts WORKER_TASK, and inherit its extensions and environment). Token analysis 2026-10-20: whole-file reads and unbounded grep / git diff / cat output were
// the largest share of what lanes and workers re-read on every later turn (read 23%, bash 16%, grep 7% of peak context).
// The cap is sized above normal work (read p50 4.3K, p90 16K chars on the MacBook's OmO sessions), and every cut says how
// to get the rest: a read without a range continues at the offset named, a ranged read (`limit` given) is never cut, and
// shell output keeps its head and tail (errors, test summaries, OmO's "[Full output: <file>]" line) with a note in the middle.
// The orchestrator is not capped (it reads little and the owner's questions can need a whole file).

export const CAP_CHARS = 20_000;
const SHELL_HEAD = 15_000;
const SHELL = new Set(["eval", "bash", "bash_output"]);
const SEARCH = new Set(["grep", "find", "mcp__ast_grep_search"]);

type Block = { type: string; text?: string; [k: string]: unknown };

// The end of the last whole line within `max` chars (the whole first line when even that is longer).
const lineCut = (t: string, max: number) => {
	const at = t.lastIndexOf("\n", max);
	return at > 0 ? at : Math.min(t.length, max);
};
// The start of the first whole line among the last `max` chars.
const tailCut = (t: string, max: number) => {
	const at = t.indexOf("\n", t.length - max);
	return at >= 0 ? at + 1 : t.length - max;
};

function cutText(tool: string, input: Record<string, unknown>, t: string): string {
	if (SHELL.has(tool)) {
		const head = lineCut(t, SHELL_HEAD);
		const tail = tailCut(t, CAP_CHARS - SHELL_HEAD);
		if (tail <= head) return t;
		return `${t.slice(0, head)}\n[dotz: ${tail - head} chars of ${t.length} left out here; rerun narrower to see them (grep -m N / head / tail, git diff --stat or one path, a smaller range), or write the output to a file and read it in ranges]\n${t.slice(tail)}`;
	}
	const end = lineCut(t, CAP_CHARS);
	if (tool === "read") {
		const shown = t.slice(0, end).split("\n").length;
		const from = Number(input.offset) > 0 ? Number(input.offset) : 1;
		return `${t.slice(0, end)}\n[dotz: read output cut after ${shown} lines (${end} of ${t.length} chars); continue with read offset=${from + shown}, pass a limit for one bigger range, or grep for the part you need]`;
	}
	return `${t.slice(0, end)}\n[dotz: result cut at ${end} of ${t.length} chars; narrow the pattern or path, or add a match limit, to see the rest]`;
}

// The capped content of one tool result, or undefined when it stays as it is.
export function capToolResult(tool: string, input: unknown, content: unknown): Block[] | undefined {
	if (!Array.isArray(content) || !(SHELL.has(tool) || SEARCH.has(tool) || tool === "read")) return undefined;
	const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	if (tool === "read" && args.limit !== undefined) return undefined;
	const blocks = content as Block[];
	const total = blocks.reduce((n, b) => n + (b?.type === "text" && typeof b.text === "string" ? b.text.length : 0), 0);
	if (total <= CAP_CHARS) return undefined;
	// Text blocks are joined into one (results are almost always a single text block); other blocks keep their place after it.
	const joined = blocks.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
	return [{ type: "text", text: cutText(tool, args, joined) }, ...blocks.filter(b => b?.type !== "text")];
}

export function installOutputCap(pi: { on: (name: string, fn: (event: any) => any) => void }, env: Record<string, string | undefined> = process.env): void {
	if (!env.DOTZ_LANE) return;
	pi.on("tool_result", (event: any) => {
		const content = capToolResult(String(event?.toolName ?? ""), event?.input, event?.content);
		return content ? { content } : undefined;
	});
}
