import { BUDGET_MARKER, briefProblems, budgetLine, hasDoneCondition, isWritingAgent } from "./guard-brief.ts";
import type { GuardConfig } from "./guard-config.ts";

const SPAWN_CALL = /(?<![\w$.])(?:agent|workpool)\s*\(/;

/** Why an eval cell that starts workers with `agent()` or `workpool()` is refused: the task tool's brief rule does not see its prompts, so the cell itself must carry an "Acceptance:" or "Done when:" line. */
export function evalSpawnProblem(tool: string, input: unknown): string | undefined {
	const code = tool === "eval" ? String((input as { code?: unknown } | undefined)?.code ?? "") : "";
	if (!SPAWN_CALL.test(code) || hasDoneCondition(code)) return undefined;
	return 'orchestrator-guard: this eval cell starts workers (agent()/workpool()) without an observable done-condition. Put an "Acceptance:" or "Done when:" line in the prompt, as a task brief needs one.';
}

/** The `before_subagent_spawn` answer for a worker started from an eval cell: a writing agent would run in the live checkout with none of the isolation, review-before-apply and brief rules of the task tool, so it is refused. Workers started by the task tool and read-only agents pass. */
export function evalSpawnBlock(event: unknown): { block: true; reason: string } | undefined {
	const { invocationKind, agent } = (event ?? {}) as { invocationKind?: unknown; agent?: unknown };
	if (invocationKind !== "eval" || !isWritingAgent(agent)) return undefined;
	return { block: true, reason: `orchestrator-guard: eval agent()/workpool() would run the writing worker "${String(agent ?? "task")}" in this checkout without the isolation, review-before-apply and brief rules of the task tool. Start it with the task tool; eval agent() is for read-only agents such as scout.` };
}

/** What a message to an agent that is not known to be running becomes: it may wake a parked worker with new work, so it meets the brief rules of a task and carries the answer and context budget. A refusal names what is missing. */
export function reviveBrief(input: Record<string, unknown>, g: GuardConfig): { reason: string } | { input: Record<string, unknown> } {
	const content = typeof input.content === "string" ? input.content : "";
	const problems = briefProblems("the message", content, "", g);
	if (problems.length) return { reason: `orchestrator-guard: a message to an agent that is not known to be running may wake it with new work, so it needs a brief:\n- ${problems.join("\n- ")}\nRewrite the message and retry, or start a fresh worker with the task tool.` };
	return { input: content.includes(BUDGET_MARKER) ? input : { ...input, content: `${content}\n\n${budgetLine(g)}` } };
}
