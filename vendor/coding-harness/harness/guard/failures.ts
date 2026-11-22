import { fieldsOf, textBlocks, textOf, type ToolEvent } from "./host-types.ts";
import type { BashOutcome } from "./loops.ts";
import { WORKER_ENV_PREFIX } from "./worker-env.ts";

/** Bash outcomes kept per session for the failure streak. */
export const FAILURE_HISTORY = 16;
/** The `next` command of a streak check that has no next command: matches nothing. */
export const FAILURE_NO_NEXT = "\u0000";
/** A project-state worker still `running` after this long no longer counts as a running job for the polling rule. */
export const RUNNING_JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const ERROR_LINE = /error|fail|denied|not found|exception/i;
const EXIT_LINE = /^Command exited with code (\d+)\s*$/;

/** Per-session failure-streak state: the recent outcomes, whether the repeating command was already blocked, and whether the notice was already shown. */
export interface FailureRow { history: BashOutcome[]; blocked: boolean; told: boolean }

/** What a bash tool result says: the command without the worker env prefix, its exit code, and its first error-looking output line (else its first line). */
export function bashOutcome(event: ToolEvent): BashOutcome {
	const lines = textBlocks(event.content).join("\n").split("\n").map(line => line.trim()).filter(line => line !== "");
	const exitLine = lines.map(line => EXIT_LINE.exec(line)).find(found => found !== null);
	const detailed = fieldsOf(event.details).exitCode;
	const exitCode = typeof detailed === "number" ? detailed : exitLine ? Number(exitLine[1]) : event.isError ? 1 : 0;
	const output = lines.filter(line => !EXIT_LINE.test(line));
	const command = textOf(fieldsOf(event.input).command).replace(WORKER_ENV_PREFIX, "");
	return { command, exitCode, firstErrorLine: output.find(line => ERROR_LINE.test(line)) ?? output[0] ?? "" };
}
