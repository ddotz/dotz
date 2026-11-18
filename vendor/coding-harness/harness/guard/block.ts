import { appendBlockRow, maskSecrets } from "./block-log.ts";
import { debug } from "./debug.ts";
import { type Fields, fieldsOf } from "./host-types.ts";
import { briefLabel } from "./state.ts";
import { WORKER_ENV_PREFIX } from "./worker-env.ts";

/** What a `tool_call` handler returns to refuse a call. */
export type Block = { block: true; reason: string };

/** First 200 chars of what the blocked call was about: its command, eval code or path, else the first brief's label; credentials masked. */
export function blockTarget(input: unknown): string {
	const fields: Fields = fieldsOf(input);
	const tasks = fields.tasks;
	const brief = Array.isArray(tasks) ? briefLabel(fieldsOf(tasks[0]).task) : "";
	const text = [fields.command, fields.code, fields.path, brief].find(value => typeof value === "string" && value !== "");
	return typeof text === "string" ? maskSecrets(text.replace(WORKER_ENV_PREFIX, "").slice(0, 4096)).slice(0, 200) : "";
}

/** Every block the guard returns is made here: one JSON line per block is appended to `<log dir>/guard-blocks.jsonl` (harness/guard-blocks.ts reports it). A logging failure never reaches the hook. */
export function block(ctx: { agent?: { kind?: unknown }; cwd?: unknown } | undefined, phase: string, tool: string, input: unknown, reason: string): Block {
	try {
		appendBlockRow({ at: new Date().toISOString(), phase, agentKind: String(ctx?.agent?.kind ?? "unknown"), cwd: String(ctx?.cwd ?? process.cwd()), tool, target: blockTarget(input) });
	} catch (error) {
		debug({ phase: "block-log-error", message: String(error) });
	}
	return { block: true, reason };
}
