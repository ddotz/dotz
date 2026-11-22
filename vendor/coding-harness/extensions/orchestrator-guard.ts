import { evalExternalAction, externalAction } from "../harness/guard/eval-scan.ts";
import type { HostApi } from "../harness/guard/host-types.ts";
import { registerGuardHooks } from "../harness/guard/hooks.ts";
import { machineRuleProblem } from "../harness/guard/machine-rules.ts";
import { workerBashInput } from "../harness/guard/worker-env.ts";

export { evalExternalAction, externalAction, machineRuleProblem, workerBashInput };
export { type BlockRow } from "../harness/guard/block-log.ts";
export { clearUsageCache } from "../harness/guard/budget.ts";

/**
 * orchestrator-guard: enforces the RULES.md worker-brief and worker-boundary rules on the agent's tool calls, and keeps
 * per-project worker state across compactions and sessions. The policy lives in harness/guard/*.ts; `registerGuardHooks`
 * wires it to omp's hooks.
 */
export default function orchestratorGuard(pi: HostApi): void {
	registerGuardHooks(pi);
}
