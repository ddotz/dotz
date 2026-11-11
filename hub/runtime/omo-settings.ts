// The OmO orchestrator's compaction tail. OmO reads `compaction.keepRecentTokens` (default 20000) from the global settings.json
// or from <cwd>/.omo/settings.json, and reads the project file only when the project is trusted; the gateway starts the
// orchestrator with --approve (omo.ts), which keeps the data folder exactly as trusted as it is without the file.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DEFAULTS, log, writeAtomic } from "../config.ts";

export const ORCH_KEEP_RECENT_MIN = 5_000;

// orchestrator.keep_recent in OmO's token estimate (4 characters per token); a missing or invalid value is the default, a small one is raised.
export function orchestratorKeepRecent(): number {
	const v = cfg.orchestrator?.keep_recent;
	return Math.max(ORCH_KEEP_RECENT_MIN, typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULTS.orch_keep_recent);
}

// Sets compaction.keepRecentTokens in <cwd>/.omo/settings.json, keeping every other key; writes only when the value differs.
// A file that is not a JSON object is left alone. Returns true when the file was written.
export function syncKeepRecent(cwd: string, value = orchestratorKeepRecent()): boolean {
	const file = join(cwd, ".omo", "settings.json");
	let doc: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		doc = parsed as Record<string, unknown>;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			log(`omo project settings left alone (${file}): ${(e as Error).message}`);
			return false;
		}
	}
	const compaction = doc.compaction && typeof doc.compaction === "object" && !Array.isArray(doc.compaction) ? (doc.compaction as Record<string, unknown>) : {};
	if (compaction.keepRecentTokens === value) return false;
	mkdirSync(join(cwd, ".omo"), { recursive: true });
	writeAtomic(file, `${JSON.stringify({ ...doc, compaction: { ...compaction, keepRecentTokens: value } }, null, 2)}\n`);
	return true;
}
