// Guard debug log: one JSON line per entry, appended to the file named by ORCH_GUARD_DEBUG (off when unset).
import { appendFileSync } from "node:fs";

const DEBUG_LOG = process.env.ORCH_GUARD_DEBUG;

export function debug(entry: Record<string, unknown>): void {
	if (!DEBUG_LOG) return;
	appendFileSync(DEBUG_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
