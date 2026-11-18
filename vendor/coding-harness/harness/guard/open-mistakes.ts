import { isUnresolved, listMistakes } from "../gate/mistakes.ts";
import type { HostCtx } from "./host-types.ts";

const TEXT_PREVIEW = 80;

/** The key the done gate keeps this session's mistakes under (`sessionKey` in gate/host.ts). */
export const mistakeSessionKey = (ctx: HostCtx | undefined): string => String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.agent?.id ?? "main");

const ACTION: Record<string, string> = { "git push": "git push", "gh pr publish": "opening, merging or readying a PR" };

/** Why a push or a PR may not go out while the session has an unresolved mistake (open, or closed only by a proposal the user has not accepted), or undefined. */
export function openMistakeProblem(sessionId: string, kind: string): string | undefined {
	const open = listMistakes(sessionId)
		.filter(isUnresolved)
		.map(mistake => `${mistake.id} [${mistake.status}]: ${mistake.text.replace(/\s+/g, " ").slice(0, TEXT_PREVIEW)}`);
	if (open.length === 0) return undefined;
	return `orchestrator-guard: ${ACTION[kind] ?? `a command the guard cannot read (${kind}) that may push or open a PR`} is refused while this session has unresolved mistakes:\n${open.map(line => `- ${line}`).join("\n")}\nFix them and resolve each (mistake action resolve with a check) before pushing or opening a PR. If a finding is out of scope, resolve it with kind none and a reason the user can accept with /gate-ok.`;
}
