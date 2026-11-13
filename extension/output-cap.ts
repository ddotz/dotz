// Size caps on tool results in lane processes and in the task workers of lanes and the orchestrator (OmO workers run as
// child processes of their parent through its worker profile, hub/runtime/omo.ts WORKER_TASK, and inherit its extensions and environment). Token analysis 2026-10-20: whole-file reads and unbounded grep / git diff / cat output were
// the largest share of what lanes and workers re-read on every later turn (read 23%, bash 16%, grep 7% of peak context).
// The cap is sized above normal work (read p50 4.3K, p90 16K chars on the MacBook's OmO sessions), and every cut says how
// to get the rest: a read without a range continues at the offset named, a ranged read (`limit` given) is never cut, and
// shell output keeps its head and tail (errors, test summaries, OmO's "[Full output: <file>]" line) with a note in the middle.
// The orchestrator itself is not capped (it reads little and the owner's questions can need a whole file); its workers are.

// A detached eval cell's result reaches the model as a custom message (senpi-codemode:notification), not as a tool result,
// so the tool_result hook never sees it; a context hook cuts those the same way (measured 2026-11-05 over 3 days: 399 notices,
// 666K chars of text, 3 over the cap; the 3.5M chars of base64 images in them are not text and stay). The cut is a pure
// function of the notice, so every request carries the same text and the prompt cache holds. A cut says where the whole
// text is: OmO's own [Full output: ...] line when the result has one, else a file saved under a name made from its hash.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CAP_CHARS = 20_000;
// A read gets more room than search and shell output: a spec or source file is judged whole, and 36 of 188 read cuts in
// 7 days (2026-11-13 diagnosis) were never followed up, so the agent worked from the first 20K chars. A patch or diff gets
// far more (judging half a patch is worse than the context it costs), still bounded so one huge diff cannot fill the window.
export const READ_CAP = 60_000;
export const PATCH_READ_CAP = 200_000;
const capOf = (tool: string, args: Record<string, unknown>): number => (tool !== "read" ? CAP_CHARS : /\.(patch|diff)$/.test(String(args.path ?? "")) ? PATCH_READ_CAP : READ_CAP);
export const NOTICE_TYPE = "senpi-codemode:notification";
// The context hook receives the converted messages (role user, customType gone), so a notice is also known by its opening.
const NOTICE_OPEN = "<system-reminder>Detached eval cell ";
const OWN_FULL = "[Full output: ";
const SHELL_HEAD = 15_000;
const SHELL = new Set(["eval", "bash", "bash_output"]);
const SEARCH = new Set(["grep", "find", "mcp__ast_grep_search"]);

type Block = { type: string; text?: string; [k: string]: unknown };

// The full text saved under a name made from its hash (the same text always lands in the same file), or undefined when
// the text has OmO's own full-output line or the file cannot be written.
function spill(t: string): string | undefined {
	if (t.includes(OWN_FULL)) return undefined;
	try {
		const dir = join(tmpdir(), "dotz-output-cap");
		const file = join(dir, `${createHash("sha1").update(t).digest("hex").slice(0, 16)}.txt`);
		if (existsSync(file)) {
			// Reused: a fresh transcript points to it, so its age starts again (the temp sweep removes files by mtime).
			const now = new Date();
			utimesSync(file, now, now);
		} else {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, t, { mode: 0o600 });
			renameSync(tmp, file);
		}
		return file;
	} catch {
		return undefined;
	}
}

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

// Head and tail of a shell result or notice with the note in the middle, or the text itself when the cut would not drop anything.
function headTail(t: string): string {
	const head = lineCut(t, SHELL_HEAD);
	const tail = tailCut(t, CAP_CHARS - SHELL_HEAD);
	if (tail <= head) return t;
	const file = spill(t);
	const where = file
		? `full output: ${file} (read it there in ranges); or rerun narrower (grep -m N / head / tail, git diff --stat or one path, a smaller range)`
		: t.includes(OWN_FULL)
			? "the full output is in the [Full output: ...] file named below, read it in ranges"
			: "rerun narrower to see them (grep -m N / head / tail, git diff --stat or one path, a smaller range), or write the output to a file and read it in ranges";
	return `${t.slice(0, head)}\n[dotz: ${tail - head} chars of ${t.length} left out here; ${where}]\n${t.slice(tail)}`;
}

function cutText(tool: string, input: Record<string, unknown>, t: string): string {
	if (SHELL.has(tool)) return headTail(t);
	const end = lineCut(t, capOf(tool, input));
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
	if (total <= capOf(tool, args)) return undefined;
	// Text blocks are joined into one (results are almost always a single text block); other blocks keep their place after it.
	const joined = blocks.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
	return [{ type: "text", text: cutText(tool, args, joined) }, ...blocks.filter(b => b?.type !== "text")];
}

type Msg = { role?: string; customType?: string; content?: unknown; [k: string]: unknown };

const firstText = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? ((c as Block[]).find(b => b?.type === "text")?.text ?? "") : "");
const isNotice = (m: Msg) => (m?.role === "custom" && m.customType === NOTICE_TYPE) || (m?.role === "user" && firstText(m.content).startsWith(NOTICE_OPEN));

// The messages with over-long detached eval notices cut, or undefined when nothing changes. Images and other blocks keep their place.
export function capNotices(messages: Msg[]): Msg[] | undefined {
	let changed = false;
	const out = messages.map(m => {
		if (!isNotice(m)) return m;
		if (typeof m.content === "string") {
			if (m.content.length <= CAP_CHARS) return m;
			const cut = headTail(m.content);
			if (cut === m.content) return m;
			changed = true;
			return { ...m, content: cut };
		}
		const blocks = capToolResult("eval", {}, m.content);
		if (!blocks) return m;
		changed = true;
		return { ...m, content: blocks };
	});
	return changed ? out : undefined;
}

export function installOutputCap(pi: { on: (name: string, fn: (event: any) => any, options?: { mutatesMessages?: boolean }) => void }, env: Record<string, string | undefined> = process.env): void {
	// The orchestrator itself (DOTZ_ORCHESTRATOR without OMO_SENPI_TASK_DEPTH) stays uncapped.
	if (!env.DOTZ_LANE && !(env.DOTZ_ORCHESTRATOR === "1" && env.OMO_SENPI_TASK_DEPTH)) return;
	pi.on("tool_result", (event: any) => {
		const content = capToolResult(String(event?.toolName ?? ""), event?.input, event?.content);
		return content ? { content } : undefined;
	});
	pi.on(
		"context",
		(event: any) => {
			const messages = Array.isArray(event?.messages) ? capNotices(event.messages) : undefined;
			return messages ? { messages } : undefined;
		},
		{ mutatesMessages: false },
	);
}
