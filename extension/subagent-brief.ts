import { checkoutRoots, checkTaskInput, gitTop, shouldIsolate } from "./guard-brief.ts";
import { type GuardConfig, installedOriginal, loadGuardConfig } from "./guard-config.ts";
import type { Host } from "./omp-host.ts";

type TaskCall = { toolName?: unknown; input?: unknown };
type Runner = { cwd?: unknown };

export function installSubagentBrief(pi: Pick<Host, "on">, config: GuardConfig = loadGuardConfig()): void {
	if (!config.enabled || (config.defer_to_installed && installedOriginal(pi, "orchestrator-guard"))) return;
	pi.on("tool_call", (event, ctx) => {
		const call = event as TaskCall | undefined;
		if (call?.toolName !== "task") return undefined;
		const runner = ctx as Runner | undefined;
		const cwd = typeof runner?.cwd === "string" ? runner.cwd : process.cwd();
		const isolate = shouldIsolate(gitTop(cwd), false);
		const verdict = checkTaskInput(call.input, isolate, isolate ? checkoutRoots(cwd) : [], config);
		return "reason" in verdict ? { block: true, reason: verdict.reason } : { input: verdict.input };
	});
}
