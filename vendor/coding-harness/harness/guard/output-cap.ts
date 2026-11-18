import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { debug } from "./debug.ts";
import { fieldsOf } from "./host-types.ts";
import { stateDir } from "./state.ts";

/** Characters a worker's shell or search result may carry before it is cut. Below omp's own 50 KiB cut, which reads already reach first. */
export const CAP_CHARS = 20_000;
/** Characters of a shell result's head that are kept; the rest of `CAP_CHARS` is its tail. */
export const SHELL_HEAD = 15_000;

const SHELL_TOOLS = ["bash", "eval"];
const SEARCH_TOOLS = ["grep", "glob", "find", "ast_grep", "ast-grep"];
const SPILL_DIR = "output-cap";
const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Block = { type: string; text?: string; [key: string]: unknown };

/** Writes the whole text under the guard state dir and returns its path, or undefined when it cannot be written. */
export type Spill = (text: string) => string | undefined;

/**
 * The full text saved under a name made from its hash (the same text always lands in the same file, so a re-cut result
 * carries the same marker). Files older than a week are removed on the way. Undefined when the file cannot be written.
 */
export function spillToStateDir(text: string): string | undefined {
	try {
		const dir = join(stateDir(), SPILL_DIR);
		const file = join(dir, `${createHash("sha1").update(text).digest("hex").slice(0, 16)}.txt`);
		const now = new Date();
		if (existsSync(file)) utimesSync(file, now, now);
		else {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, text, { mode: 0o600 });
			renameSync(tmp, file);
		}
		for (const name of readdirSync(dir)) {
			const stale = join(dir, name);
			if (stale !== file && now.getTime() - statSync(stale).mtimeMs > SPILL_MAX_AGE_MS) unlinkSync(stale);
		}
		return file;
	} catch (error) {
		debug({ phase: "output-cap-spill-error", message: String(error) });
		return undefined;
	}
}

const lineCut = (text: string, max: number) => {
	const at = text.lastIndexOf("\n", max);
	return at > 0 ? at : Math.min(text.length, max);
};

function headTail(text: string, spill: Spill): string {
	const head = lineCut(text, SHELL_HEAD);
	const tailAt = text.indexOf("\n", text.length - (CAP_CHARS - SHELL_HEAD));
	const tail = tailAt >= 0 ? tailAt + 1 : text.length - (CAP_CHARS - SHELL_HEAD);
	if (tail <= head) return text;
	const file = spill(text);
	const where = file
		? `full output: ${file} (read it there in ranges); or rerun narrower (grep -m N / head / tail, git diff --stat or one path, a smaller range)`
		: "rerun narrower to see them (grep -m N / head / tail, git diff --stat or one path, a smaller range), or write the output to a file and read it in ranges";
	return `${text.slice(0, head)}\n[orchestrator-guard: ${tail - head} chars of ${text.length} left out here; ${where}]\n${text.slice(tail)}`;
}

function cutText(tool: string, text: string, spill: Spill): string {
	if (SHELL_TOOLS.includes(tool)) return headTail(text, spill);
	const end = lineCut(text, CAP_CHARS);
	return `${text.slice(0, end)}\n[orchestrator-guard: result cut at ${end} of ${text.length} chars; narrow the pattern or path, or add a match limit, to see the rest]`;
}

/**
 * The capped content of one worker tool result, or undefined when it stays as it is (the cache needs an under-cap result
 * byte-identical). Only bash and eval (head and tail around a marker, the whole text spilled to a file), grep, glob, find
 * and ast_grep are cut. Reads are left to omp, which cuts them at 50 KiB itself; a result omp already cut
 * (`details.meta.truncation`) is never cut a second time. The result is a pure function of its arguments.
 */
export function capToolResult(tool: string, content: unknown, details: unknown, spill: Spill): Block[] | undefined {
	if (!Array.isArray(content) || !(SHELL_TOOLS.includes(tool) || SEARCH_TOOLS.includes(tool))) return undefined;
	const detail = fieldsOf(details);
	if (detail.truncation != null || fieldsOf(detail.meta).truncation != null) return undefined;
	const blocks = content as Block[];
	const isText = (block: Block) => block?.type === "text" && typeof block.text === "string";
	const total = blocks.reduce((sum, block) => sum + (isText(block) ? (block.text as string).length : 0), 0);
	if (total <= CAP_CHARS) return undefined;
	const joined = blocks.filter(isText).map(block => block.text).join("\n");
	const cut = cutText(tool, joined, spill);
	if (cut === joined) return undefined;
	return [{ type: "text", text: cut }, ...blocks.filter(block => !isText(block))];
}
