import { appendFileSync } from "node:fs";

const DEBUG_LOG = process.env.ORCH_GUARD_DEBUG;

/** Appends one JSON line to the file named by ORCH_GUARD_DEBUG when it is set; a debug log that cannot be written throws, so a wrong path shows up at once. */
export function debug(entry: Record<string, unknown>): void {
	if (!DEBUG_LOG) return;
	appendFileSync(DEBUG_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
