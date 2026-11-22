import { execFileSync } from "node:child_process";
import { BUDGET_5H_EST } from "./budget.ts";
import { type Fields, fieldsOf } from "./host-types.ts";
import { WORKER_FOOTER_LINES } from "./spawn-rules.ts";

const MAX_BRIEF_CHARS = 8000;
const MAX_FENCE_LINES = 40;
const MAX_OUTPUT_CHARS = 2000;
const MAX_CHANGE_ITEMS = 6;
const WRITING_AGENTS = new Set(["task", "sonic"]);
const DONE_MARKER = /acceptance|done when|done-condition|end state|success criteria|완료 조건|완료 기준|끝 조건/i;
const ESTIMATE_RE = /^\s*Estimate:\s*(\d+(?:\.\d+)?)\s*%?/im;

/** Marks the budget line the guard appends to a brief, so a brief that already carries it is not footed twice. */
export const BUDGET_MARKER = "[orchestrator-guard]";
/** The answer and context budget appended to every worker brief. */
export const BUDGET_LINE = `${BUDGET_MARKER} Final answer: at most 800 characters - outcome, changed paths, verification, blockers. Context budget 300K tokens; if you near it, stop and hand back partial findings.`;
/** The whole footer appended to every worker brief: the budget line, then the worker rules. */
export const BRIEF_FOOTER = `${BUDGET_LINE}\n${WORKER_FOOTER_LINES.join("\n")}`;

function longestFence(text: string): number {
	let longest = 0;
	for (const block of text.match(/```[\s\S]*?```/g) ?? []) longest = Math.max(longest, block.split("\n").length - 2);
	return longest;
}

/** Whether `cwd` is inside a git work tree. Isolation needs one; outside it an isolated worker cannot start, so writing workers run in place there. */
export function inGitRepo(cwd: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Checkout roots an isolated worker must not reach by absolute path: the cwd's own toplevel and the repo's main checkout
 * (a lane worktree's brief still names the main checkout). omp copies the repo but does not remap absolute paths, so a
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
		const roots = [top, main, logicalTop].filter(Boolean);
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

/** Top-level list items under a brief's `# Change` heading, up to the next heading. */
export function changeItems(brief: string): number {
	const section = /^#+[ \t]*Change\b[^\n]*\n([\s\S]*?)(?=^#+[ \t]|(?![\s\S]))/im.exec(brief)?.[1] ?? "";
	return section.split("\n").filter(line => /^(?:\d+[.)]|[-*])[ \t]/.test(line)).length;
}

/**
 * Refuses a task call whose briefs lack a done-condition, paste contents or code blocks, or list too many change items;
 * otherwise returns the input with the budget footer appended to every brief and writing agents forced isolated.
 * `isolate` is false outside a git repo. `roots`: checkout paths rewritten to cwd-relative in isolated briefs, so the worker edits its own copy.
 * `notice` names every task whose isolation or paths the guard changed, for the main agent; absent when it changed neither.
 */
export function checkTaskInput(input: unknown, isolate = true, roots: string[] = []): { reason: string } | { input: unknown; notice?: string } {
	const fields = fieldsOf(input);
	const context = typeof fields.context === "string" ? fields.context : "";
	const items: unknown[] = Array.isArray(fields.tasks) ? fields.tasks : [];
	if (!items.length) return { input };
	const problems: string[] = [];
	items.forEach((item, i) => {
		const entry = fieldsOf(item);
		const brief = typeof entry.task === "string" ? entry.task : "";
		const label = `tasks[${i}]`;
		if (!DONE_MARKER.test(`${brief}\n${context}`)) problems.push(`${label} has no observable done-condition (add an "Acceptance:" or "Done when:" line)`);
		if (brief.length + context.length > MAX_BRIEF_CHARS) problems.push(`${label} brief is ${brief.length + context.length} chars; pass paths instead of pasted contents (limit ${MAX_BRIEF_CHARS})`);
		if (longestFence(`${brief}\n${context}`) > MAX_FENCE_LINES) problems.push(`${label} pastes a code block over ${MAX_FENCE_LINES} lines; pass the path and line range instead`);
		if (WRITING_AGENTS.has(String(entry.agent ?? "task")) && changeItems(brief) > MAX_CHANGE_ITEMS)
			problems.push(`${label} lists ${changeItems(brief)} change items; a worker that large stops at its context limit before it verifies anything. Split it: at most ${MAX_CHANGE_ITEMS} items and one module per worker; when the tests already exist, name the test files the worker must turn green`);
	});
	if (problems.length) return { reason: `Worker brief rejected by orchestrator-guard (RULES.md):\n- ${problems.join("\n- ")}\nRewrite the task call and retry.` };
	let anyIsolated = false;
	const forced: string[] = [];
	const rewritten: string[] = [];
	const tasks = items.map((item, i) => {
		const entry = fieldsOf(item);
		const label = `tasks[${i}]${typeof entry.name === "string" && entry.name ? ` (${entry.name})` : ""}`;
		const next: Fields = typeof entry.task === "string" && !entry.task.includes(BUDGET_MARKER) ? { ...entry, task: `${entry.task}\n\n${BRIEF_FOOTER}` } : { ...entry };
		if (isolate && WRITING_AGENTS.has(String(entry.agent ?? "task")) && entry.isolated !== true) {
			next.isolated = true;
			forced.push(label);
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
		forced.length ? `${forced.join(", ")} spawned with isolated: true: writing workers always run in their own worktree, so their changes come back as a .patch you read and apply with git apply, not in this checkout.` : "",
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
