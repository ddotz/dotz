import { familyOf } from "./worker-size.ts";

const EFFORT_RANK: Record<string, number> = { minimal: 0, lo: 0, low: 0, med: 1, medium: 1, hi: 2, high: 2, xhigh: 3, max: 4 };

const rankOf = (effort: string | undefined): number | undefined => (effort === undefined ? undefined : EFFORT_RANK[effort.trim().toLowerCase()]);

/** Refuses a spawn whose effort is more than one level above its role's effort. */
export function effortProblem(spawnEffort: string | undefined, roleEffort: string | undefined): string | undefined {
	const spawn = rankOf(spawnEffort);
	const role = rankOf(roleEffort);
	if (spawn === undefined || role === undefined || spawn - role <= 1) return undefined;
	return `orchestrator-guard: effort "${spawnEffort}"는 역할 기본값 "${roleEffort}"보다 두 단계 이상 높아서 막았어요. 어려운 작업이라도 한 단계까지만 올릴 수 있습니다. effort를 낮춰 다시 spawn하세요.`;
}

const FABLE_LIMIT_IDS = new Set(["anthropic:7d:fable", "anthropic:7d_fable", "claude:7d_fable"]);

/** Model families whose requests fill the 7d window usage reports name `fable`. Mythos is one: measured 2026-11-20, the window went from 44% to 50% used while $91 of Mythos replies and no Fable reply ran on any machine of the account. */
export const FABLE_WINDOW_FAMILIES: readonly string[] = ["fable", "mythos"];

/** True when requests to `model` (an id or a `provider/model:effort` selector) fill the 7d Fable window. */
export function fillsFableWindow(model: string): boolean {
	const id = model.toLowerCase();
	return FABLE_WINDOW_FAMILIES.some(family => id.includes(family));
}

/** Refuses a deep-tier spawn (deep-reviewer, or a model that fills the Fable window) when the 7d fable window has under `margin` percent left. */
export function deepBudgetProblem(
	limits: readonly { id: string; amount?: { remaining?: number } }[],
	agent: string | undefined,
	model: string | undefined,
	margin = 10,
): string | undefined {
	const deep = agent === "deep-reviewer" || (model !== undefined && fillsFableWindow(model));
	if (!deep) return undefined;
	const remaining = limits.find(l => FABLE_LIMIT_IDS.has(l.id))?.amount?.remaining;
	if (typeof remaining !== "number" || remaining >= margin) return undefined;
	return `orchestrator-guard: fable 7d 한도가 ${remaining}% 남아(기준 ${margin}%) deep 티어 spawn을 막았어요. 사용자에게 남은 %를 보여 주고 물어보세요: 기본 티어로 바꿔 진행할지, 리셋을 기다릴지.`;
}

const blockLinesOf = (configText: string, key: string): string[] => new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+\\S[^\\n]*\\n?)*)`, "m").exec(configText)?.[1].split("\n") ?? [];
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Every `role: selector` entry in the `modelRoles` block of a config.yml. */
export function roleSelectorsIn(configText: string): Record<string, string> {
	const roles: Record<string, string> = {};
	for (const line of blockLinesOf(configText, "modelRoles")) {
		const entry = /^\s+([\w-]+):\s*(\S+)\s*$/.exec(line);
		if (entry) roles[entry[1]] = entry[2];
	}
	return roles;
}

/** Selector (`provider/model:effort`) configured for `role` in the `modelRoles` block of a config.yml. */
export function roleSelectorIn(configText: string, role: string): string | undefined {
	return roleSelectorsIn(configText)[role];
}

/** Effort configured for `role` in the `modelRoles` block of a config.yml (`role: provider/model:effort`). */
export function roleEffortIn(configText: string, role: string): string | undefined {
	return /:([a-z]+)$/i.exec(roleSelectorIn(configText, role) ?? "")?.[1];
}

/** Value of a direct key of the `task:` block of a config.yml. */
export function taskSettingIn(configText: string, key: string): string | undefined {
	const lines = blockLinesOf(configText, "task");
	const top = lines.length ? indentOf(lines[0]) : 0;
	for (const line of lines) {
		const entry = /^\s+([\w-]+):\s*(\S+)\s*$/.exec(line);
		if (entry?.[1] === key && indentOf(line) === top) return entry[2];
	}
	return undefined;
}

/** True when `task.agentModelOverrides` of a config.yml has an entry for `agent`, which pins the model omp runs it on. */
export function agentOverrideIn(configText: string, agent: string): boolean {
	const lines = blockLinesOf(configText, "task");
	const top = lines.length ? indentOf(lines[0]) : 0;
	const start = lines.findIndex(line => indentOf(line) === top && /^\s+agentModelOverrides:\s*$/.test(line));
	if (start < 0) return false;
	for (const line of lines.slice(start + 1)) {
		if (line.trim() !== "" && indentOf(line) <= top) break;
		if (new RegExp(`^\\s+${agent}:`).test(line)) return true;
	}
	return false;
}

/** The role an agent definition runs on: `model: "@role"` in its frontmatter. */
export function agentRoleIn(agentText: string): string | undefined {
	const front = /^---\n([\s\S]*?)\n---/.exec(agentText)?.[1] ?? "";
	return /^model:\s*["']?@([\w-]+)["']?\s*$/m.exec(front)?.[1];
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const COARSE: Record<string, string> = { lo: LEVELS[0], med: LEVELS[Math.floor((LEVELS.length - 1) / 2)], hi: LEVELS[LEVELS.length - 1] };

/** The level omp runs a task item's `effort` at: `lo|med|hi` mean the lowest, middle and highest level of the model (low, high, max on Anthropic models), a plain level name is itself, and `ceiling` (`task.maxEffort`) lowers the result but never raises it. */
export function resolveEffort(effort: string, ceiling = "max"): string | undefined {
	const name = effort.trim().toLowerCase();
	const level = COARSE[name] ?? (name === "minimal" || LEVELS.includes(name) ? name : undefined);
	const limit = rankOf(ceiling);
	const rank = rankOf(level);
	return level === undefined || rank === undefined || limit === undefined || rank <= limit ? level : ceiling;
}

export type EffortSetup = { roleSelector?: string; maxEffort?: string; overridden: boolean };
export type EffortAction = { kind: "keep" } | { kind: "refuse"; problem: string } | { kind: "rewrite"; model: string; from: string };

const modelOf = (selector: string): string => selector.replace(/:[a-z]+$/i, "");

/** What to do with a task item's `effort`: keep it, refuse it when it resolves two or more levels above its role, or, when the agent's model is not pinned and `escalate` names a point on another model, rewrite the item to run there. */
export function effortAction(effort: string | undefined, setup: EffortSetup, escalate: (selector: string) => string | undefined): EffortAction {
	if (effort === undefined || setup.roleSelector === undefined) return { kind: "keep" };
	const roleLevel = /:([a-z]+)$/i.exec(setup.roleSelector)?.[1];
	const level = resolveEffort(effort, setup.maxEffort);
	const spawn = rankOf(level);
	const role = rankOf(roleLevel);
	if (spawn === undefined || role === undefined || spawn <= role) return { kind: "keep" };
	const target = setup.overridden ? undefined : escalate(setup.roleSelector);
	if (target !== undefined && modelOf(target) !== modelOf(setup.roleSelector)) return { kind: "rewrite", model: target, from: setup.roleSelector };
	const problem = effortProblem(level, roleLevel);
	return problem === undefined ? { kind: "keep" } : { kind: "refuse", problem };
}

/** Refuses a task item's per-call `model` unless it is the selector of the agent's role or that role's escalation target; nothing is refused when the role cannot be told. */
export function modelProblem(model: string, setup: EffortSetup, escalate: (selector: string) => string | undefined): string | undefined {
	if (setup.roleSelector === undefined) return undefined;
	const allowed = [...new Set([setup.roleSelector, escalate(setup.roleSelector)].filter((s): s is string => s !== undefined))];
	if (allowed.includes(model.trim())) return undefined;
	return `orchestrator-guard: per-call model "${model}"는 이 에이전트 역할의 모델이나 그 상향 대상(${allowed.join(", ")})이 아니라서 막았어요. 어려운 작업은 model 없이 effort "hi"로 spawn하면 가드가 상향 대상으로 바꿔 줍니다. model을 빼거나 위 값 중 하나로 다시 spawn하세요.`;
}

/** Refuses an escalating spawn (the role's escalation target as model, or an effort the guard rewrites to it) unless `name` is in the family of a worker already in `known` (a retry such as `FooRetry` after `Foo`); an unnamed spawn proves no retry. */
export function escalationProblem(name: unknown, known: Iterable<string>): string | undefined {
	const family = typeof name === "string" && name.trim() !== "" ? familyOf(name.trim()) : undefined;
	if (family !== undefined) for (const id of known) if (familyOf(id) === family) return undefined;
	return "orchestrator-guard: 상향 모델(escalation target)로 바로 spawn하는 건 막았어요. 먼저 역할 모델(model·effort 없이)로 돌리고, 실패한 worker의 재시도만 상향하세요. 재시도는 같은 family 이름으로 지어야 합니다(예: `Foo`가 실패했다면 `FooRetry`).";
}
