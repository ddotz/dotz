// One owner alert per usage-limit reset. A pause re-armed by a failed probe, a gateway restart or a model switch inside the
// same window says nothing new (2026-10-20: three near-identical 429 alerts for one reset). Kept on disk, so a restart
// does not forget what was already said.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";

export const rateAlertsFile = () => join(DATA_DIR, "rate-alerts.json");

// True the first time `who` (orchestrator, lane:<name>) pauses until this reset (to the minute), false after that.
export function firstAlertForReset(who: string, until: number): boolean {
	const key = new Date(Math.round(until / 60_000) * 60_000).toISOString();
	let seen: Record<string, string> = {};
	try {
		seen = JSON.parse(readFileSync(rateAlertsFile(), "utf8"));
	} catch {}
	if (seen[who] === key) return false;
	seen[who] = key;
	writeAtomic(rateAlertsFile(), `${JSON.stringify(seen)}\n`);
	return true;
}
