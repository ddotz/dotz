import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentHome, ompAgentDir } from "../agent-home.ts";
import { debug } from "./debug.ts";
import { fieldsOf } from "./host-types.ts";
import type { UsageLimit } from "./limit-lift.ts";
import type { Data } from "../model-tiers/plan.ts";
import { agentOverrideIn, agentRoleIn, type EffortSetup, roleSelectorIn, roleSelectorsIn, taskSettingIn } from "./spawn-rules.ts";

/** An Anthropic usage window as `omp usage --json` reports it. */
export type Limit = { id: string; window?: { resetsAt?: number }; amount?: { remaining?: number } };

/** Share of the 5h window a fan-out is assumed to use when its brief has no "Estimate: N%" line. */
export const BUDGET_5H_EST = 15;
/** How long /budget-ok lets worker spawns through a low quota. */
export const BUDGET_OK_MS = 30 * 60_000;
const BUDGET_5H_MARGIN = 10;
const USAGE_CACHE_MS = 120_000;
const OMP_BIN = /(^|\/)(bun|node)$/.test(process.execPath) ? "omp" : process.execPath;
const ompBin = () => process.env.ORCH_GUARD_OMP_BIN ?? OMP_BIN;

let usageCache: { at: number; limits: Limit[] } | undefined;

/** Forgets the cached quota so the next task call asks `omp usage` again. */
export function clearUsageCache(): void {
	usageCache = undefined;
}

const agentsDir = () => join(process.env.ORCH_GUARD_AGENT_DIR ?? agentHome(), "agents");
const ompConfig = () => join(process.env.ORCH_GUARD_AGENT_DIR ?? ompAgentDir(), "config.yml");
const textIfPresent = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** What the effort rules need for an agent: the selector of the role it runs on (the `task` agent runs the task role, others the `@role` of their definition), `task.maxEffort` and whether `task.agentModelOverrides` pins its model; the selector is undefined when it cannot be told. */
export function effortSetupOfAgent(agent: string): EffortSetup {
	const config = textIfPresent(ompConfig());
	if (config === undefined || !/^[\w-]+$/.test(agent)) return { overridden: false };
	const definition = textIfPresent(join(agentsDir(), `${agent}.md`));
	const role = agent === "task" ? "task" : definition === undefined ? undefined : agentRoleIn(definition);
	return { roleSelector: role === undefined ? undefined : roleSelectorIn(config, role), maxEffort: taskSettingIn(config, "maxEffort"), overridden: agentOverrideIn(config, agent) };
}

/** The tier data the escalation reads (`harness/model-tiers.json` of the agent directory), or undefined when it is absent or unreadable. */
export function tierData(): Data | undefined {
	const text = textIfPresent(join(process.env.ORCH_GUARD_AGENT_DIR ?? agentHome(), "harness", "model-tiers.json"));
	try {
		return text === undefined ? undefined : (JSON.parse(text) as Data);
	} catch (parseError) {
		debug({ phase: "tiers-parse-error", message: String(parseError) });
		return undefined;
	}
}

/** The selectors the `modelRoles` block of the omp config sets, the models an escalation may move to. */
export function roleSelectors(): string[] {
	const config = textIfPresent(ompConfig());
	return config === undefined ? [] : Object.values(roleSelectorsIn(config));
}

function runOmp(args: string[]): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	execFile(ompBin(), args, { timeout: 15_000 }, (error, stdout) => {
		if (error) {
			debug({ phase: "usage-error", message: String(error) });
			return resolve(undefined);
		}
		resolve(stdout);
	});
	return promise;
}

async function anthropicReport() {
	const stdout = await runOmp(["usage", "--json", "-p", "anthropic"]);
	if (stdout === undefined) return undefined;
	try {
		const reports = fieldsOf(JSON.parse(stdout)).reports;
		return fieldsOf(Array.isArray(reports) ? reports.find(r => fieldsOf(r).provider === "anthropic") : undefined);
	} catch (parseError) {
		debug({ phase: "usage-parse-error", message: String(parseError) });
		return undefined;
	}
}

/** The Anthropic quota windows from `omp usage --json` (cached for 2 minutes), or undefined when the command fails or prints something unreadable. */
export async function anthropicLimits(): Promise<Limit[] | undefined> {
	if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.limits;
	const report = await anthropicReport();
	if (!report) return undefined;
	const limits = (report.limits ?? []) as Limit[];
	usageCache = { at: Date.now(), limits };
	return limits;
}

/** The Anthropic windows read past omp's own usage cache (`omp usage invalidate` first), or undefined when the report is unreadable or names a problem. `ORCH_GUARD_OMP_BIN` replaces the omp binary. */
export async function freshAnthropicLimits(): Promise<UsageLimit[] | undefined> {
	await runOmp(["usage", "invalidate", "-p", "anthropic"]);
	const report = await anthropicReport();
	if (!report || report.problem || !Array.isArray(report.limits)) return undefined;
	return report.limits as UsageLimit[];
}

/** Why a fan-out of `workers` workers is too much for the 5h window (it would leave under 10%), or undefined. The 7d window never gates (owner rule 2026-10-18); its remaining % is only shown in the 5h message. */
export function budgetProblem(limits: Limit[], workers: number, est = BUDGET_5H_EST): string | undefined {
	const clock = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "?");
	const five = limits.find(l => l.id === "anthropic:5h");
	const week = limits.find(l => l.id === "anthropic:7d");
	if (typeof five?.amount?.remaining !== "number" || five.amount.remaining - est >= BUDGET_5H_MARGIN) return undefined;
	const weekNote = typeof week?.amount?.remaining === "number" ? `; 7d window ${week.amount.remaining}% left (info only)` : "";
	return `5h window ${five.amount.remaining}% left; this fan-out (${workers} worker(s)) is assumed to use ~${est}%, leaving under ${BUDGET_5H_MARGIN}% (resets ${clock(five.window?.resetsAt)})${weekNote}; add an "Estimate: N%" line to the brief if it is smaller`;
}
