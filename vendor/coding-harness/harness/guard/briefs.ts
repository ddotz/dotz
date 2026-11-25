import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { whereis } from "../checkouts/place.ts";
import { BUDGET_5H_EST } from "./budget.ts";
import { type Fields, fieldsOf } from "./host-types.ts";
import { WRITING_AGENTS } from "./shell.ts";

const MAX_OUTPUT_CHARS = 2000;
const ESTIMATE_RE = /^\s*Estimate:\s*(\d+(?:\.\d+)?)\s*%?/im;
const APPLIES_PATCH = /\bgit\s+(?:apply|am)\b(?!\s+--(?:check|stat|numstat|summary)\b)/;
const WHOLE_SUITE = /(?<!\b(?:not|never|no|without)\s+(?:(?:run|running)\s+)?(?:the\s+)?)\b(?:whole|full|entire)\s+(?:test\s+)?suite\b|(?:테스트|스위트|suite|bun test).{0,3}전체|전체.{0,3}(?:테스트|스위트|suite|bun test)/i;
const BRIEF_FILE = /(?<![\w.-])(\/[^\s`'"()<>]+\.md)\b/g;
const MAX_BRIEF_FILES = 5;
const MAX_BRIEF_FILE_BYTES = 64 * 1024;

/** Marks the budget line the guard appends to a brief, so a brief that already carries it is not footed twice. */
export const BUDGET_MARKER = "[orchestrator-guard]";
/** The answer and context budget appended to every worker brief. */
export const BUDGET_LINE = `${BUDGET_MARKER} Final answer: at most 800 characters - outcome, changed paths, verification, blockers. Context budget 400K tokens; if you near it, stop and hand back partial findings.`;
/** The footer appended to every worker brief: the budget line, then a pointer to the worker rules. */
export const BRIEF_FOOTER = `${BUDGET_LINE}\nRead skill://ulw/worker.md before anything else.`;

/** Whether `cwd` is inside a git work tree. Isolation needs one; outside it an isolated worker cannot start, so writing workers run in place there. */
export function inGitRepo(cwd: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/** The text of a brief file a task names by absolute path; undefined when it is missing, unreadable or over 64 KB. */
export function readBriefFile(path: string): string | undefined {
	try {
		return statSync(path).size > MAX_BRIEF_FILE_BYTES ? undefined : readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function withBriefFiles(text: string, read: (path: string) => string | undefined): string {
	const paths = [...new Set([...text.matchAll(BRIEF_FILE)].map(m => m[1]!))].slice(0, MAX_BRIEF_FILES);
	return [text, ...paths.map(path => read(path) ?? "")].join("\n");
}

/**
 * Checkout roots an isolated worker must not reach by absolute path: the cwd's own toplevel, the repo's main checkout
 * (a lane worktree's brief still names the main checkout) and, in a checkout slot, the folder the slot belongs to.
 * omp copies the repo but does not remap absolute paths, so a
 * brief with /abs/repo/file makes the worker edit the real repo (onboard-perms lane, 2026-10-17). git prints resolved
 * paths, while briefs use the path the session was started with: /tmp/x resolves to /private/tmp/x on macOS and the
 * brief's /tmp/x passed through unchanged (ulwp probe, 2026-11-16). Both spellings count.
 */
export function checkoutRoots(cwd: string): string[] {
	try {
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5_000 }).trim();
		const top = git("rev-parse", "--show-toplevel");
		const prefix = git("rev-parse", "--show-prefix").replace(/\/$/, "");
		const main = git("worktree", "list", "--porcelain").split("\n").find(line => line.startsWith("worktree "))?.slice(9) ?? "";
		const logicalTop = prefix && cwd.endsWith(`/${prefix}`) ? cwd.slice(0, -prefix.length - 1) : prefix ? "" : cwd.replace(/\/$/, "");
		const roots = [top, main, logicalTop, whereis(cwd)?.folder ?? ""].filter(Boolean);
		for (const root of [...roots]) if (/^\/private\/(tmp|var|etc)\//.test(root)) roots.push(root.slice("/private".length));
		return [...new Set(roots)].sort((a, b) => b.length - a.length);
	} catch {
		return [];
	}
}

/** `text` with every `<root>/` prefix removed and every bare `<root>` turned into `.`, so a path names the worker's own copy. */
export function relativizeRoots(text: string, roots: string[]): string {
	let out = text;
	for (const root of roots) {
		const esc = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`${esc}/`, "g"), "").replace(new RegExp(`${esc}(?![\\w./-])`, "g"), ".");
	}
	return out;
}

/** Top-level list items and numbered `REQn` lines under a brief's `# Change` or `## Changes` heading, up to the next heading; a brief with no such heading counts its numbered and `REQn` lines across the whole text. */
export function changeItems(brief: string): number {
	const section = /^#+[ \t]*Changes?\b[^\n]*\n([\s\S]*?)(?=^#+[ \t]|(?![\s\S]))/im.exec(brief)?.[1];
	if (section !== undefined) return section.split("\n").filter(line => /^(?:\d+[.)]|[-*])[ \t]|^REQ\d+\b/.test(line)).length;
	return brief.split("\n").filter(line => /^(?:\d+[.)][ \t]|(?:[-*][ \t]+)?REQ\d+\b)/.test(line)).length;
}

/**
 * Refuses a task call that asks a writing worker for the whole test suite or tells a shared-checkout worker to apply a patch;
 * otherwise returns the input with the budget footer appended to every brief and writing agents forced isolated.
 * `isolate` is false outside a git repo. `roots`: checkout paths rewritten to cwd-relative in isolated briefs, so the worker edits its own copy.
 * `notice` names every task whose isolation or paths the guard changed, for the main agent; absent when it changed neither.
 * `read` returns the text of a brief file a task names by absolute path (readBriefFile); a task that does not run isolated and is told, inline or in
 * that file, to apply a patch is refused, because it would apply it in the checkout the main session and other sessions share.
 */
export function checkTaskInput(input: unknown, isolate = true, roots: string[] = [], read: (path: string) => string | undefined = readBriefFile): { reason: string } | { input: unknown; notice?: string } {
	const fields = fieldsOf(input);
	const context = typeof fields.context === "string" ? fields.context : "";
	const items: unknown[] = Array.isArray(fields.tasks) ? fields.tasks : [];
	if (!items.length) return { input };
	const problems: string[] = [];
	items.forEach((item, i) => {
		const entry = fieldsOf(item);
		const brief = typeof entry.task === "string" ? entry.task : "";
		const label = `tasks[${i}]`;
		if (WRITING_AGENTS.has(String(entry.agent ?? "task")) && WHOLE_SUITE.test(`${brief}\n${context}`))
			problems.push(`${label} asks a writing worker for the whole test suite; a worker runs only the tests of the files it changed and the whole suite is run once per batch in the main session. Name the affected test files instead (e.g. "bun test <files>") and run the whole suite yourself before landing`);
		if (isolate && entry.isolated !== true && !WRITING_AGENTS.has(String(entry.agent ?? "task")) && APPLIES_PATCH.test(withBriefFiles(`${brief}\n${context}`, read)))
			problems.push(`${label} tells a worker that shares this checkout to apply a patch (git apply / git am); a patch is applied only in a private copy: add isolated: true to that task`);
	});
	if (problems.length) return { reason: `Worker brief rejected by orchestrator-guard (RULES.md):\n- ${problems.join("\n- ")}\nRewrite the task call and retry.` };
	let anyIsolated = false;
	const parallel = isolate && items.filter(item => WRITING_AGENTS.has(String(fieldsOf(item).agent ?? "task"))).length > 1;
	const forced: string[] = [];
	const rewritten: string[] = [];
	const tasks = items.map((item, i) => {
		const entry = fieldsOf(item);
		const label = `tasks[${i}]${typeof entry.name === "string" && entry.name ? ` (${entry.name})` : ""}`;
		const next: Fields = typeof entry.task === "string" && !entry.task.includes(BUDGET_MARKER) ? { ...entry, task: `${entry.task}\n\n${BRIEF_FOOTER}` } : { ...entry };
		if (WRITING_AGENTS.has(String(entry.agent ?? "task"))) {
			if (parallel && entry.isolated !== true) forced.push(label);
			next.isolated = parallel;
		}
		if (next.isolated && roots.length && typeof next.task === "string") {
			const relative = relativizeRoots(next.task, roots);
			if (relative !== next.task) rewritten.push(label);
			next.task = relative;
			anyIsolated = true;
		}
		return next;
	});
	const relativeContext = anyIsolated && context ? relativizeRoots(context, roots) : context;
	if (relativeContext !== context) rewritten.push("context");
	const notice = [
		forced.length ? `${forced.join(", ")} spawned with isolated: true: parallel writing workers each run in their own worktree (a lone writer runs in this checkout). Give each one files no other writer touches and, when the repo uses bun, have it run bun install in its worktree first. Each change comes back as a .patch: read and git apply them one by one in this checkout, run the check after each, then delete the kept patches; finished task worktrees are swept by worktree cleanup.` : "",
		rewritten.length ? `Absolute checkout paths in ${rewritten.join(", ")} were rewritten relative to the worktree root, so the worker edits its own copy.` : "",
	].filter(Boolean);
	return {
		input: { ...fields, ...(relativeContext !== context ? { context: relativeContext } : {}), tasks },
		...(notice.length ? { notice: `orchestrator-guard changed this task call (not a mistake in it): ${notice.join(" ")}` } : {}),
	};
}

/** Percent of the 5h window a task call is expected to use: the sum of the "Estimate: N%" lines of its briefs (or of its context when no brief has one), capped at 100; BUDGET_5H_EST when there is none. */
export function estimateFrom(input: unknown): number {
	const fields = fieldsOf(input);
	const pick = (text: unknown) => {
		const found = ESTIMATE_RE.exec(typeof text === "string" ? text : "")?.[1];
		return found === undefined ? undefined : Number(found);
	};
	const own = (Array.isArray(fields.tasks) ? fields.tasks : []).map(item => pick(fieldsOf(item).task)).filter((n): n is number => n !== undefined);
	const total = own.length ? own.reduce((a, b) => a + b, 0) : pick(fields.context);
	return total === undefined ? BUDGET_5H_EST : Math.min(total, 100);
}

/** `text` with every `<task-result>` output over 2000 chars cut and pointed at `history://<id>`. */
export function trimWaitOutput(text: string): string {
	return text.replace(
		/(<task-result\b[^>]*\bid="([^"]+)"[^>]*>\s*<output>\n?)([\s\S]*?)(\n?<\/output>)/g,
		(whole, open: string, id: string, body: string, close: string) =>
			body.length <= MAX_OUTPUT_CHARS
				? whole
				: `${open}${body.slice(0, MAX_OUTPUT_CHARS)}\n[orchestrator-guard: output trimmed from ${body.length} chars; full text at history://${id}]${close}`,
	);
}

/** Deletes `ttl: "1h"` from every `cache_control` in `value` (a provider payload) in place and returns how many it dropped. */
export function dropLongTtl(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((n, item) => n + dropLongTtl(item), 0);
	if (!value || typeof value !== "object") return 0;
	const record = value as Fields;
	let dropped = 0;
	const cache = record.cache_control;
	if (cache && typeof cache === "object" && (cache as Fields).ttl === "1h") {
		delete (cache as Fields).ttl;
		dropped++;
	}
	for (const key of Object.keys(record)) if (key !== "cache_control") dropped += dropLongTtl(record[key]);
	return dropped;
}
