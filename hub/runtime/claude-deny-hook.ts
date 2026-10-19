// PreToolUse hook that Claude Code runs before every Bash call (wired by claude.ts through a per-run --settings file).
// It applies dotz's built-in denies (hub/systemdeny.ts), the owner's RULES.md "## Blocked commands" lines
// (`- deny: <regex> | <reason>`) and the deny lists of the feature folders, the same matching the omp extension does
// (extension/index.ts `blockedBy`, featuredirs.ts), on the command text. Blocking = exit code 2 with the reason on
// stderr, which Claude Code hands back to the model as the tool result. The process runs with
// --permission-mode bypassPermissions, so this hook is the only guard and fails closed: input it cannot read, an error,
// or no answer within HOOK_DEADLINE_MS (below the hook timeout Claude Code is given, after which it would let the call
// through) blocks the call; a crash that exits with another code is turned into a block by the hook command in
// claude.ts. A single bad regex in RULES.md is skipped like the omp extension skips it.
// Pure fs + featuredirs.ts, so each Bash call starts a light bun process.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockedByFeatures } from "../featuredirs.ts";
import { systemDeny } from "../systemdeny.ts";

export const BLOCK_EXIT_CODE = 2;
// Claude Code is told to wait 10 s (claude.ts writeSettings); the hook gives up and blocks before that.
export const HOOK_DEADLINE_MS = 8000;

export function denyReason(command: string, dataDir: string): string | undefined {
	const system = systemDeny(command);
	if (system) return `Blocked by dotz: ${system}.`;
	const rules = join(dataDir, "RULES.md");
	if (existsSync(rules)) {
		const section = readFileSync(rules, "utf8").split(/^## Blocked commands\s*$/m)[1]?.split(/^## /m)[0] ?? "";
		for (const m of section.matchAll(/^- deny:\s*(.+)\s+\|\s+(.+?)\s*$/gm)) {
			try {
				if (new RegExp(m[1], "i").test(command)) return `Blocked by the owner's rule (${rules}): ${m[2].trim()}. Do not work around it; report it if the task needs it.`;
			} catch {
				continue;
			}
		}
	}
	const feature = blockedByFeatures(dataDir, command);
	if (feature) return `Blocked by the owner's feature (${join(dataDir, "features", feature.id, "feature.md")}): ${feature.reason}. Do not work around it; report it if the task needs it.`;
	return undefined;
}

if (import.meta.main) {
	const deadline = setTimeout(() => {
		process.stderr.write("dotz could not check this command in time, so it is blocked. Report it if the task needs it.\n");
		process.exit(BLOCK_EXIT_CODE);
	}, Number(process.env.DOTZ_HOOK_DEADLINE_MS ?? HOOK_DEADLINE_MS));
	let reason: string | undefined;
	try {
		const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: { command?: unknown } };
		const command = input.tool_name === "Bash" ? String(input.tool_input?.command ?? "") : "";
		reason = command ? denyReason(command, process.env.DOTZ_DIR ?? join(homedir(), ".dotz")) : undefined;
	} catch (e) {
		reason = `dotz could not check this command (${e instanceof Error ? e.message : e}), so it is blocked. Report it if the task needs it.`;
	}
	clearTimeout(deadline);
	if (reason) {
		process.stderr.write(`${reason}\n`);
		process.exit(BLOCK_EXIT_CODE);
	}
}
