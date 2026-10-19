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
}

export const GUARD_DEFAULTS: GuardConfig = {
	enabled: true,
	max_brief_chars: 8000,
	max_fence_lines: 40,
	max_output_chars: 2000,
	worker_answer_chars: 800,
	worker_context_tokens: 400_000,
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
	};
}

export function loadGuardConfig(dir = dataDir()): GuardConfig {
	try {
		return guardConfigFrom(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).guard);
	} catch {
		return guardConfigFrom(undefined);
	}
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

// omp marks the session's own agent in ctx.agent (main / sub). OmO has no ctx.agent and runs task workers in its rpc host,
// which does not load this extension, so there every session that loads it is the main one.
export const isMain = (ctx: any) => (ctx?.agent ? ctx.agent.kind === "main" : process.env.DOTZ_RUNTIME === "omo");
