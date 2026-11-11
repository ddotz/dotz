// Worker brief checks, split out of guard.ts (pure functions; the configuration is always passed in): done-condition, size and
// fence limits, the answer/context budget line, isolation roots, project and folder-rule footers, and the worker model pin.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { dataDir, type GuardConfig } from "./guard-config.ts";

const WRITING_AGENTS = new Set(["task", "sonic"]);
const DONE_MARKER = /acceptance|done when|done-condition|end state|success criteria|완료 조건|완료 기준|끝 조건/i;
// Shared with the owner's original extension and the harness doctor, so a brief marked by either copy is never marked twice.
export const BUDGET_MARKER = "[orchestrator-guard]";
export const budgetLine = (g: GuardConfig) =>
	`${BUDGET_MARKER} Final answer: at most ${g.worker_answer_chars} characters - outcome, changed paths, verification, blockers. Context budget ${Math.round(g.worker_context_tokens / 1000)}K tokens; if you near it, stop and hand back partial findings. Settle reversible choices yourself and note them in the report; stop to ask only for what cannot be undone. Never end a turn to wait for a background run (a text-only turn ends your run and the wake-up can fail to start): wait inside one blocking call, e.g. an eval cell that polls up to 280s, then report.`;
function longestFence(text: string): number {
	let longest = 0;
	for (const block of text.match(/```[\s\S]*?```/g) ?? []) longest = Math.max(longest, block.split("\n").length - 2);
	return longest;
}

// The git toplevel of `cwd`, "" outside a repo.
export function gitTop(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
	} catch {
		return "";
	}
}
const real = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
};

// Whether writing workers started from a folder whose git toplevel is `top` get an isolated copy. Not outside a repo, not
// where OmO already answered isolation_unavailable, and not in the dotz data folder: ~/.dotz is a git repo only for the
// nightly settings snapshot (.gitignore `*` with a few files let back in), so a copy of it holds none of the files a worker
// touches, and OmO's baseline capture of it failed every first worker of a mail conversation on the Mac mini
// (st_01a17c03, st_01a17c1a, 2026-10-27: "isolation_unavailable: baseline capture failed: ... rev-parse --verify --quiet HEAD
// failed (128)"). A lane worktree under ~/.dotz/lanes is its own toplevel and stays isolated.
export function shouldIsolate(top: string, unavailable: boolean, home = dataDir()): boolean {
	return Boolean(top) && !unavailable && real(top) !== real(home);
}

// Checkout roots an isolated worker must not reach by absolute path: the cwd's own toplevel and the repo's main checkout
// (a lane worktree's brief still names the main checkout). omp copies the repo but does not remap absolute paths, so a
// brief with /abs/repo/file makes the worker edit the real repo (onboard-perms lane, 2026-10-17).
export function checkoutRoots(cwd: string): string[] {
	try {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5_000 }).trim();
		const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8", timeout: 5_000 });
		const main = list.split("\n").find(line => line.startsWith("worktree "))?.slice(9) ?? "";
		return [...new Set([top, main].filter(Boolean))].sort((a, b) => b.length - a.length);
	} catch {
		return [];
	}
}

export function relativizeRoots(text: string, roots: string[]): string {
	let out = text;
	for (const root of roots) {
		const esc = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`${esc}/`, "g"), "").replace(new RegExp(`${esc}(?![\\w./-])`, "g"), ".");
	}
	return out;
}

// Isolation needs a git repo; outside one an isolated worker cannot start, so writing workers run in place there.
// `roots`: checkout paths rewritten to cwd-relative in isolated briefs, so the worker edits its own copy.
export function checkTaskInput(input: any, isolate = true, roots: string[] = [], g: GuardConfig): { reason: string } | { input: any } {
	const context = typeof input?.context === "string" ? input.context : "";
	const items: any[] = Array.isArray(input?.tasks) ? input.tasks : [];
	if (!items.length) return { input };
	const problems: string[] = [];
	items.forEach((item, i) => {
		const brief = typeof item?.task === "string" ? item.task : "";
		const label = `tasks[${i}]`;
		if (!DONE_MARKER.test(`${brief}\n${context}`)) problems.push(`${label} has no observable done-condition (add an "Acceptance:" or "Done when:" line)`);
		if (brief.length + context.length > g.max_brief_chars) problems.push(`${label} brief is ${brief.length + context.length} chars; pass paths instead of pasted contents (limit ${g.max_brief_chars})`);
		if (longestFence(`${brief}\n${context}`) > g.max_fence_lines) problems.push(`${label} pastes a code block over ${g.max_fence_lines} lines; pass the path and line range instead`);
	});
	if (problems.length) return { reason: `Worker brief rejected by the guard (worker-brief rules):\n- ${problems.join("\n- ")}\nRewrite the task call and retry.` };
	let anyIsolated = false;
	const tasks = items.map(item => {
		const next = typeof item?.task === "string" && !item.task.includes(BUDGET_MARKER) ? { ...item, task: `${item.task}\n\n${budgetLine(g)}` } : { ...item };
		if (isolate && WRITING_AGENTS.has(String(item?.agent ?? "task"))) next.isolated = true;
		if (next.isolated && roots.length && typeof next.task === "string") {
			next.task = relativizeRoots(next.task, roots);
			anyIsolated = true;
		}
		return next;
	});
	return { input: { ...input, ...(anyIsolated && context ? { context: relativizeRoots(context, roots) } : {}), tasks } };
}

// A worker sees only its brief, so a task spawned for a project's work is pointed at the project's rules (owner 2026-11-02: a
// summary page delegated with only "reuse the CSS" ignored the full version's layout and the README's analysis rule). A project
// is a folder <data>/projects/<p> with a README.md, named by the conversation's channel setup (bare `projects/<p>`), by the
// brief (`~/.dotz/projects/<p>` or the absolute path) or by the task's cwd. No project, no footer.
export const PROJECT_MARKER = "Read first (project rules):";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function projectFooter(brief: string, conv = process.env.DOTZ_CONV, cwd = "", data = dataDir()): string | undefined {
	const names = new Set<string>();
	const ch = /^ch:(\d+)$/.exec(conv ?? "")?.[1];
	if (ch) {
		try {
			const s = (JSON.parse(readFileSync(join(data, "channel-setups.json"), "utf8")) as any[]).find(x => x?.channel === ch);
			for (const m of `${s?.purpose ?? ""} ${s?.standing ?? ""}`.matchAll(/(?:^|[^\w./-])(?:~\/\.dotz\/)?projects\/([\w.-]+)/g)) names.add(m[1]);
		} catch {} // no setups file (or unreadable): the brief and cwd still name the project
	}
	const under = `(?:${escRe(data)}|~/\\.dotz)/projects/([\\w.-]+)`;
	for (const m of `${brief}\n${cwd}/`.matchAll(new RegExp(under, "g"))) names.add(m[1]);
	const readmes = [...names].map(p => join(data, "projects", p, "README.md")).filter(f => existsSync(f));
	if (!readmes.length) return undefined;
	const rules = join(data, "RULES.md");
	return `${PROJECT_MARKER} ${[...readmes, ...(existsSync(rules) ? [rules] : [])].join(", ")}. A derivative of an existing artifact starts from a copy of it.`;
}
// OmO injects a folder's AGENTS.md only on the `read` tool; a worker that reads through eval or a shell gets nothing (measured
// 2026-11-05, /tmp/lessons-proof). A brief that names one of these folders carries the rules itself. Roots: the task's cwd and
// every absolute path in the brief, walked upward, so "Repo: /x/dotz ... web/a.js" works from another cwd.
export const FOLDER_RULES_MARKER = "Folder rules (";
const RULE_FOLDERS = /(?<![\w.-])(web|site)\//g;
function folderRules(brief: string, cwd: string): string[] {
	const folders = new Set([...brief.matchAll(RULE_FOLDERS)].map(m => m[1]));
	const found = new Set<string>();
	if (folders.size)
		for (const start of [cwd, ...(brief.match(/(?:~\/|\/)[\w./-]+/g) ?? [])]) {
			for (let dir = start.replace(/^~/, homedir()); dir.length > 1; dir = dirname(dir))
				for (const folder of folders) {
					const file = join(dir, folder, "AGENTS.md");
					if (existsSync(file)) found.add(file);
				}
		}
	return [...found].map(file => `${FOLDER_RULES_MARKER}${file}):\n${readFileSync(file, "utf8").trim()}`);
}

// Appends the footers to each brief in place (both task shapes: OmO `prompt`, omp `tasks[].task`), once.
export function addProjectFooter(input: any, conv = process.env.DOTZ_CONV, cwd = "", data = dataDir()): void {
	const context = typeof input?.context === "string" ? input.context : "";
	for (const item of Array.isArray(input?.tasks) ? input.tasks : [input]) {
		const field = typeof item?.prompt === "string" ? "prompt" : typeof item?.task === "string" ? "task" : undefined;
		if (!field) continue;
		const brief = `${item[field]}\n${context}`;
		const project = item[field].includes(PROJECT_MARKER) ? undefined : projectFooter(brief, conv, cwd, data);
		const folders = item[field].includes(FOLDER_RULES_MARKER) ? [] : folderRules(brief, cwd);
		for (const footer of [...(project ? [project] : []), ...folders]) item[field] = `${item[field]}\n\n${footer}`;
	}
}

// OmO's task tool (omo-task) takes one worker as `{prompt, category | subagent_type, ...}` or several as `{tasks: [{prompt, ...}]}`,
// with isolation per call or item: `isolated`, `apply` (false = keep the change as a patch and merge nothing) and `merge`
// ("patch"). The same brief rules apply; writing workers are isolated with apply:false, so their change comes back as
// `isolation: retained via <backend> -> <dir>/root.patch` in the task completion. Read-only agents run in place.
const OMO_READ_ONLY = /^(explore|librarian|oracle|plan-|.*review|.*qa-)/;
export const isOmoTaskInput = (input: any) => typeof input?.prompt === "string" || (Array.isArray(input?.tasks) && input.tasks.some((t: any) => typeof t?.prompt === "string"));
// senpi applies a tool_call handler's changes only when `event.input` is mutated in place, so the items are edited where they are.
export function checkOmoTaskInput(input: any, isolate = true, roots: string[] = [], g: GuardConfig): { reason: string } | { input: any } {
	const items: any[] = Array.isArray(input?.tasks) ? input.tasks : [input];
	const problems: string[] = [];
	items.forEach((item, i) => {
		const brief = typeof item?.prompt === "string" ? item.prompt : "";
		const label = Array.isArray(input?.tasks) ? `tasks[${i}]` : "the task";
		if (!DONE_MARKER.test(brief)) problems.push(`${label} has no observable done-condition (add an "Acceptance:" or "Done when:" line)`);
		if (brief.length > g.max_brief_chars) problems.push(`${label} brief is ${brief.length} chars; pass paths instead of pasted contents (limit ${g.max_brief_chars})`);
		if (longestFence(brief) > g.max_fence_lines) problems.push(`${label} pastes a code block over ${g.max_fence_lines} lines; pass the path and line range instead`);
	});
	if (problems.length) return { reason: `Worker brief rejected by the guard (worker-brief rules):\n- ${problems.join("\n- ")}\nRewrite the task call and retry.` };
	for (const item of items) {
		if (typeof item?.prompt === "string" && !item.prompt.includes(BUDGET_MARKER)) item.prompt = `${item.prompt}\n\n${budgetLine(g)}`;
		if (OMO_READ_ONLY.test(String(item?.subagent_type ?? ""))) continue;
		// Said explicitly, so neither the orchestrator's own `isolated: true` nor an omo.json `task.isolation.enabled` isolates
		// a worker where isolation cannot start (OmO refuses apply/merge without isolation).
		if (!isolate) {
			item.isolated = false;
			delete item.apply;
			delete item.merge;
			continue;
		}
		item.isolated = true;
		item.apply = false;
		item.merge = "patch";
		if (roots.length && typeof item.prompt === "string") item.prompt = relativizeRoots(item.prompt, roots);
	}
	return { input };
}

// The orchestrator's task workers run on its own live model and effort (owner 2026-10-27: work asked for in a mail, kakao or
// monitor conversation runs on the main orchestrator's model, never the reply model or a smaller worker model). OmO takes a
// `model` only beside `subagent_type` and refuses it beside `category` (category_with_model), so a subagent_type worker is
// pinned here and a category worker's model is dropped: its category runs on the same model through the
// dotz-orchestrator-workers profile (hub/runtime/omo.ts). Edited in place, as checkOmoTaskInput.
// Lookups run lighter (owner 2026-10-27): explore and librarian take Sonnet 5.5 medium on the subscription login (hub/runtime/omo.ts
// LOOKUP_MODEL in OmO's provider names; the quick category gets it through the profile). On an API-key session they follow the pin.
export const LOOKUP_PIN = "anthropic-subscription/claude-sonnet-5-5:medium";
const LOOKUP_AGENTS = /^(explore|librarian)$/;
export function pinOmoTaskModel(input: any, pin: string, keep: (model: unknown) => boolean = () => false): void {
	for (const item of Array.isArray(input?.tasks) ? input.tasks : [input]) {
		if (!item || typeof item !== "object") continue;
		const agent = typeof item.subagent_type === "string" ? item.subagent_type.trim() : "";
		if (agent && keep(item.model)) continue; // an expensive model the owner allowed for this job (grant) stays
		if (agent) item.model = LOOKUP_AGENTS.test(agent) && pin.startsWith("anthropic-subscription/") ? LOOKUP_PIN : pin;
		else delete item.model;
	}
	if (Array.isArray(input?.tasks)) delete input.model;
}
// A conversation on its own model keeps its workers on main's: the hub writes that pin to DOTZ_WORKER_PIN_FILE (hub/convsessions.ts) only then.
export const ownWorkerPin = (file: string | undefined): string | undefined => (file && existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined);
// The live session's model as a task pin (`provider/model[:effort]`, OmO's own provider names), or undefined before one is known.
export function livePin(model: { provider?: string; id?: string } | undefined, effort: unknown): string | undefined {
	if (!model?.provider || !model.id) return undefined;
	const level = typeof effort === "string" && effort && effort !== "off" ? `:${effort}` : "";
	return `${model.provider}/${model.id}${level}`;
}
