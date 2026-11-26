// The lane's identity-and-rules text, built once here: sent with the launch prompt and with a fresh session (rotation, handover), and
// written to the lane's dir at every spawn, where the extension in the lane's process re-reads it after a compaction
// (extension/index.ts laneSession). The extension cannot build it (it needs the gateway's config, catalog and limits), so the gateway hands it over.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, paths, writeAtomic } from "./config.ts";
import { featurePrompt } from "./featuredirs.ts";
import { lang, modeFile, msg, withReplyLine } from "./i18n.ts";
import { languageName } from "./language.ts";
import { identityText } from "./recall-contract.ts";
import { boundaryEntries, sessionRules } from "./recall-parts.ts";
import { dir, type Lane, laneWorkerModel } from "./lanestate.ts";
import { laneLimits } from "./lanelimits.ts";
import { HARNESS_NAMES, runtimeFor } from "./runtime/index.ts";
import { worktreeNote } from "./lanetree.ts";

export function footer(lane: Lane): string {
	const features = featurePrompt(DATA_DIR, "lanes", log);
	const rules = existsSync(paths.rules) ? sessionRules(readFileSync(paths.rules, "utf8")).slice(0, 12000) : "";
	const boundaries = existsSync(paths.boundaries) ? boundaryEntries(readFileSync(paths.boundaries, "utf8")) : "";
	return withReplyLine(msg().footer({ lane: lane.name, language: languageName(lang()), mode: modeFile(), workerModel: laneWorkerModel(lane), slots: lane.workerSlots ?? laneLimits(lane).workers, worktree: worktreeNote(lane.worktree), identity: identityText(DATA_DIR).trim(), rules, harness: HARNESS_NAMES[runtimeFor("lane").id] })) + (boundaries ? `\n\n${boundaries}` : "") + (features ? `\n\n${features}` : "");
}

/** Writes the footer into the lane's dir and returns the path (the extension gets it as DOTZ_LANE_CONTRACT). */
export function writeContract(lane: Lane): string {
	mkdirSync(dir(lane.name), { recursive: true });
	const file = join(dir(lane.name), "contract.md");
	writeAtomic(file, `${footer(lane).trim()}\n`);
	return file;
}
