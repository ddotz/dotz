// Which runtime runs a role: `orchestrator.runtime` / `lanes.runtime`, else the global `runtime`, else OmO (the default,
// owner 2026-10-19). A name no adapter answers to is logged once and falls back to OmO, so a typo in config.json never
// leaves the gateway without an agent; omp runs only when config.json names it.
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../config.ts";
import { ompAgentDir } from "../omp-dirs.ts";
import { claude } from "./claude.ts";
import { omo } from "./omo.ts";
import { omp } from "./omp.ts";
import { configuredRuntime, DEFAULT_RUNTIME } from "./runtime-id.ts";
import type { Role, RuntimeAdapter } from "./types.ts";

export const adapters: Record<string, RuntimeAdapter> = { omo, omp, claude };
const warned = new Set<string>();

export function runtimeFor(role: Role): RuntimeAdapter {
	const id = configuredRuntime(role);
	if (Object.hasOwn(adapters, id)) return adapters[id];
	if (!warned.has(`${role}:${id}`)) {
		warned.add(`${role}:${id}`);
		log(`unknown runtime "${id}" for the ${role}; using ${DEFAULT_RUNTIME}`);
	}
	return adapters[DEFAULT_RUNTIME];
}

// The harness that actually runs dotz's agents (orchestrator and lanes; usually one), by display name, and the folder each
// one auto-loads extensions from (dotz's own extension rides on every OmO and omp process through --extension).
export const HARNESS_NAMES: Record<string, string> = { omo: "OmO", omp: "omp", claude: "Claude Code" };
export function activeHarness(): { ids: string[]; name: string } {
	const ids = [...new Set([runtimeFor("orchestrator").id, runtimeFor("lane").id])];
	return { ids, name: ids.map(i => HARNESS_NAMES[i] ?? i).join(" · ") };
}
const home = () => process.env.HOME ?? homedir();
export const EXTENSION_DIRS: Record<string, () => string> = {
	omo: () => join(process.env.OMO_CODING_AGENT_DIR || join(home(), ".omo", "agent"), "extensions"),
	omp: () => join(ompAgentDir(process.env, home()), "extensions"),
};
