// PreToolUse hook that Claude Code runs before every Bash call (wired by claude.ts through a per-run --settings file).
// It applies the owner's RULES.md "## Blocked commands" lines (`- deny: <regex> | <reason>`) and the deny lists of the
// feature folders, the same matching the omp extension does (extension/index.ts `blockedBy`, featuredirs.ts), on the
// command text. Blocking = exit code 2 with the reason on stderr, which Claude Code hands back to the model as the
// tool result. Anything unexpected (unreadable stdin, a bad regex) lets the call through: a guard bug must not veto work.
// Pure fs + featuredirs.ts, so each Bash call starts a light bun process.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockedByFeatures } from "../featuredirs.ts";

export const BLOCK_EXIT_CODE = 2;

export function denyReason(command: string, dataDir: string): string | undefined {
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
	try {
		const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: { command?: unknown } };
		const command = input.tool_name === "Bash" ? String(input.tool_input?.command ?? "") : "";
		const reason = command ? denyReason(command, process.env.DOTZ_DIR ?? join(homedir(), ".dotz")) : undefined;
		if (reason) {
			process.stderr.write(`${reason}\n`);
			process.exit(BLOCK_EXIT_CODE);
		}
	} catch {
		// allow
	}
}
