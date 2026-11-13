// Config and install-detection shared by the worker guard (guard.ts) and the harness tools (harness-tools.ts).
// Everything is read from `<DOTZ_DIR>/config.json` key `guard`; every key is optional and the defaults are the generic
// behaviour. The two owner-only rules (an expensive-model gate and its /fable-ok override) are off unless configured.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GuardConfig {
	// false turns the whole guard (every hook, command and the state files) off.
	enabled: boolean;
	// Worker brief limits: characters of brief + context, lines of one fenced code block.
	max_brief_chars: number;
	max_fence_lines: number;
	// Characters of a worker's output kept in the orchestrator's context (the full text stays in history://<id>).
	max_output_chars: number;
	// The budget line appended to every worker brief.
	worker_answer_chars: number;
	worker_context_tokens: number;
	// Anthropic 5h quota gate on `task` calls: blocks when fewer than `budget_margin_percent` would be left after the
	// estimated use (`budget_default_estimate_percent`, or an "Estimate: N%" line in the brief). Skipped silently when
	// omp reports no Anthropic usage. The 7d window is shown in the message but never gates.
	budget_gate: boolean;
	budget_margin_percent: number;
	budget_default_estimate_percent: number;
	// Minutes /budget-ok and /fable-ok stay in effect.
	override_minutes: number;
	// Identical-call loop guard: calls of a 1-call cycle before the first block (longer cycles need fewer laps).
	repeat_block_threshold: number;
	// /compact-switch compacts first only when the context holds at least this many tokens.
	switch_compact_min_tokens: number;
	// Extra regexes (case-insensitive, matched against a worker's bash command) handed back to the orchestrator like git push.
	external_commands: string[];
	// Personal rule, off by default: models matching `expensive_models` (substring of the selector; an entry starting
	// with ":" matches a thinking level such as ":max") are blocked for task workers and flagged on the main session
	// until the owner runs /fable-ok or DOTZ_OWNER_ASKED_FABLE=1 is in the environment.
	ask_before_expensive: boolean;
	expensive_models: string[];
	// When the original ~/.omp extensions (orchestrator-guard.ts, harness-tools.ts) are installed, skip the overlapping
	// hooks of this copy instead of running everything twice. Set false to run this copy regardless.
	defer_to_installed: boolean;
	// false leaves out /doctor, /handover, /token-audit and their tools (harness-tools.ts).
	harness_tools: boolean;
	// Cumulative tokens (input + cache read/write + output) an OmO task worker may use before its tools are disabled (task-cap.ts); 0 = no cap.
	task_token_cap: number;
	// Context tokens past which an OmO task worker compacts itself at a turn end between tool steps, once per crossing (task-cap.ts); 0 = never.
	task_compact_tokens: number;
	// A task worker that shows progress at a checkpoint (task-cap-grow.ts) gets its cap raised by `task_cap_step` tokens each time, up to `task_cap_ceiling` per allowance; false = the fixed `task_token_cap`.
	task_cap_grow: boolean;
	task_cap_step: number;
	task_cap_ceiling: number;
}

// A subagent's compactions: the first steers it to wrap up, the second disables its tools (guard.ts).
export const SUB_COMPACT_WRAP_UP = 1;
export const SUB_COMPACT_STOP = 2;

export const GUARD_DEFAULTS: GuardConfig = {
	enabled: true,
	max_brief_chars: 16000,
	max_fence_lines: 40,
	max_output_chars: 2000,
	worker_answer_chars: 800,
	worker_context_tokens: 300_000,
	budget_gate: true,
	budget_margin_percent: 10,
	budget_default_estimate_percent: 15,
	override_minutes: 30,
	repeat_block_threshold: 8,
	switch_compact_min_tokens: 50_000,
	external_commands: [],
	ask_before_expensive: false,
	expensive_models: [],
	defer_to_installed: true,
	harness_tools: true,
	task_token_cap: 24_000_000,
	task_compact_tokens: 400_000,
	task_cap_grow: true,
	task_cap_step: 6_000_000,
	task_cap_ceiling: 48_000_000,
};

export const dataDir = () => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");

const positive = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map(s => s.trim()) : []);

// Invalid or missing values fall back to the default one by one; a broken config.json is the all-defaults config.
export function guardConfigFrom(raw: unknown): GuardConfig {
	const g = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const D = GUARD_DEFAULTS;
	const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
	return {
		enabled: flag(g.enabled, D.enabled),
		max_brief_chars: positive(g.max_brief_chars, D.max_brief_chars),
		max_fence_lines: positive(g.max_fence_lines, D.max_fence_lines),
		max_output_chars: positive(g.max_output_chars, D.max_output_chars),
		worker_answer_chars: positive(g.worker_answer_chars, D.worker_answer_chars),
		worker_context_tokens: positive(g.worker_context_tokens, D.worker_context_tokens),
		budget_gate: flag(g.budget_gate, D.budget_gate),
		budget_margin_percent: positive(g.budget_margin_percent, D.budget_margin_percent),
		budget_default_estimate_percent: positive(g.budget_default_estimate_percent, D.budget_default_estimate_percent),
		override_minutes: positive(g.override_minutes, D.override_minutes),
		repeat_block_threshold: Math.round(positive(g.repeat_block_threshold, D.repeat_block_threshold)),
		switch_compact_min_tokens: positive(g.switch_compact_min_tokens, D.switch_compact_min_tokens),
		external_commands: strings(g.external_commands),
		ask_before_expensive: flag(g.ask_before_expensive, D.ask_before_expensive),
		expensive_models: strings(g.expensive_models),
		defer_to_installed: flag(g.defer_to_installed, D.defer_to_installed),
		harness_tools: flag(g.harness_tools, D.harness_tools),
		task_token_cap: g.task_token_cap === 0 ? 0 : positive(g.task_token_cap, D.task_token_cap),
		task_compact_tokens: g.task_compact_tokens === 0 ? 0 : positive(g.task_compact_tokens, D.task_compact_tokens),
		task_cap_grow: flag(g.task_cap_grow, D.task_cap_grow),
		task_cap_step: positive(g.task_cap_step, D.task_cap_step),
		task_cap_ceiling: Math.max(positive(g.task_cap_ceiling, D.task_cap_ceiling), g.task_token_cap === 0 ? 0 : positive(g.task_token_cap, D.task_token_cap)),
	};
}

// A model matches an `expensive_models` entry as a case-insensitive substring of its selector; an entry starting with ":"
// names a thinking level (":max" matches "model:max" and a JSON `"thinking":"max"`, not ":maximum"). The list only counts
// while `ask_before_expensive` is on, so a default install has no expensive model. The one definition the extension and the hub share.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const expensivePattern = (entry: string) => (entry.startsWith(":") ? new RegExp(`[:"']${escapeRe(entry.slice(1))}\\b`, "i") : new RegExp(escapeRe(entry), "i"));
export function expensiveMatch(value: unknown, g: GuardConfig): string | undefined {
	const patterns = (g.ask_before_expensive ? g.expensive_models : []).map(expensivePattern);
	if (!patterns.length) return undefined;
	const list = Array.isArray(value) ? value : value == null ? [] : [value];
	return list.map(v => (typeof v === "string" ? v : JSON.stringify(v))).find(s => patterns.some(p => p.test(s)));
}

// The model lookup work runs on (the `quick` category, explore, librarian): config.json `models.lookups` = { model?, thinking? }.
// Missing or empty is the built-in default; a value that is not a "<provider>/<id>" model (no colon, no space) or a thinking level
// falls back to the default whole, with one warn line. The hub (profile) and the extension (task pin) both read it through here.
const DEFAULT_LOOKUP = { model: "anthropic/claude-sonnet-5-5", thinking: "medium" };
export const DEFAULT_LOOKUP_MODEL = `${DEFAULT_LOOKUP.model}:${DEFAULT_LOOKUP.thinking}`;
const LOOKUP_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
export function lookupModelFrom(raw: unknown, warn: (message: string) => void = () => {}): string {
	if (raw === undefined || raw === null) return DEFAULT_LOOKUP_MODEL;
	const o = typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
	const model = o?.model ?? "", thinking = o?.thinking ?? "";
	const good = o && typeof model === "string" && typeof thinking === "string" && (!model || /^[^\s/:]+\/[^\s:]+$/.test(model)) && (!thinking || LOOKUP_THINKING.includes(thinking));
	if (!good) {
		warn(`dotz: models.lookups in config.json is not { model: "<provider>/<id>", thinking: <level> }; lookups use ${DEFAULT_LOOKUP_MODEL}`);
		return DEFAULT_LOOKUP_MODEL;
	}
	return `${model || DEFAULT_LOOKUP.model}:${thinking || DEFAULT_LOOKUP.thinking}`;
}
export function loadLookupModel(dir = dataDir(), warn?: (message: string) => void): string {
	try {
		return lookupModelFrom(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).models?.lookups, warn);
	} catch {
		return DEFAULT_LOOKUP_MODEL;
	}
}
// In OmO `anthropic` is the API-key provider (billed per token) and `anthropic-subscription` the Claude subscription login, which is
// what omp's `anthropic` is; dotz selectors keep omp's names, so they are mapped here (the lookup pin; hub/runtime/omo.ts omoSelector does the same, tied by a test in extension/guard.test.ts).
export const omoProviderName = (selector: string) => (selector.startsWith("anthropic/") ? `anthropic-subscription/${selector.slice("anthropic/".length)}` : selector);

export function loadGuardConfig(dir = dataDir()): GuardConfig {
	try {
		return guardConfigFrom(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).guard);
	} catch {
		return guardConfigFrom(undefined);
	}
}

// A lane's refusal for a shared data file (guard.ts sharedWriteBlock): it names the report's hand-off line (the lane footer's
// "<bot> 몫:" / "For <bot>:") in the install's name and language, read as extension/index.ts reads them.
export function laneShareReason(dir = dataDir()): string {
	let id: any = {};
	try {
		id = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).identity ?? {};
	} catch {
		// No readable config: the default name, and the language from IDENTITY.md.
	}
	const name = String(id.name ?? "").trim() || "dotz";
	const lang = typeof id.language === "string" ? id.language.trim() : "";
	const identity = join(dir, "identity", "IDENTITY.md");
	const ko = lang ? /^ko(?:[-_]|$)/i.test(lang) : /[\uAC00-\uD7AF]/.test(existsSync(identity) ? readFileSync(identity, "utf8") : "");
	return ko
		? `orchestrator-guard: state.json, RULES.md, LESSONS.md와 오너 메모는 메인 세션만 써요. 바꿀 내용을 보고에 '${name} 몫:' 줄로 적으세요.`
		: `orchestrator-guard: state.json, RULES.md, LESSONS.md and owner memory are written by the main session only. Put the change in your report's "For ${name}:" line.`;
}

// omp's own agent directory (PI_CODING_AGENT_DIR / profile aware) when the host exposes it, else the default.
export function agentDir(pi: any): string {
	try {
		const dir = pi?.pi?.getAgentDir?.();
		if (typeof dir === "string" && dir) return dir;
	} catch {}
	// Under OmO the omp directory holds originals OmO never loads, so they must not switch dotz's copies off.
	if (process.env.DOTZ_RUNTIME === "omo") return process.env.OMO_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

// Worker state (spawned workers, results, unapplied patches) per project; shared with the original orchestrator-guard.
export const stateDir = (pi?: any) => process.env.ORCH_GUARD_STATE_DIR ?? join(agentDir(pi), "orchestrator-state");

// State file of one project folder (and, for dotz lanes sharing a folder, one lane) inside `dir`.
export const statePath = (dir: string, cwd: string, lane?: string) =>
	join(dir, `${createHash("sha1").update(lane ? `${cwd}\0${lane}` : cwd).digest("hex").slice(0, 16)}.json`);

// omp exposes no list of loaded extensions to an extension: a command carries no path and a tool only the path of the
// copy that registered last. So "installed" is read from the agent directory, the one place omp auto-discovers user
// extensions from: the module is `<agentDir>/extensions/<name>.ts` (or `<name>/index.ts`), discovery is not switched off
// for this process (`--no-extensions`), and `disabledExtensions` in the agent's config.yml does not name it.
export function installedOriginal(pi: any, name: string): string | undefined {
	if (process.argv.includes("--no-extensions")) return undefined;
	const root = join(agentDir(pi), "extensions");
	const file = [join(root, `${name}.ts`), join(root, `${name}.js`), join(root, name, "index.ts")].find(existsSync);
	if (!file) return undefined;
	try {
		if (new RegExp(`extension-module:${name}\\b`).test(readFileSync(join(agentDir(pi), "config.yml"), "utf8"))) return undefined;
	} catch {}
	return file;
}

// A line in omp's log, once per process however many sessions (and rebinds) load the extension.
const logged = new Set<string>();
export function logOnce(pi: any, key: string, message: string): void {
	if (logged.has(key)) return;
	logged.add(key);
	try {
		(pi?.logger?.warn ?? pi?.logger?.info)?.call(pi.logger, message);
	} catch {}
}

// The reason of the first `- deny: <regex> | <reason>` line under "## Blocked commands" in the owner's RULES.md that matches `command`.
export function blockedBy(command: string, rulesText: string): string | undefined {
	const section = rulesText.split(/^## Blocked commands\s*$/m)[1]?.split(/^## /m)[0] ?? "";
	for (const m of section.matchAll(/^- deny:\s*(.+)\s+\|\s+(.+?)\s*$/gm)) {
		try {
			if (new RegExp(m[1], "i").test(command)) return m[2].trim();
		} catch {
			continue;
		}
	}
	return undefined;
}

// omp marks the session's own agent in ctx.agent (main / sub). OmO has no ctx.agent and runs task workers in its rpc host,
// which does not load this extension, so there every session that loads it is the main one.
export const isMain = (ctx: any) => (ctx?.agent ? ctx.agent.kind === "main" : process.env.DOTZ_RUNTIME === "omo");
