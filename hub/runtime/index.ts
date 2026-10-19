// Which runtime runs a role: `orchestrator.runtime` / `lanes.runtime`, else the global `runtime`, else OmO (the default,
// owner 2026-10-19). A name no adapter answers to is logged once and falls back to OmO, so a typo in config.json never
// leaves the gateway without an agent; omp runs only when config.json names it.
import { cfg, log } from "../config.ts";
import { claude } from "./claude.ts";
import { omo } from "./omo.ts";
import { omp } from "./omp.ts";
import type { Role, RuntimeAdapter } from "./types.ts";

export const DEFAULT_RUNTIME = "omo";
export const adapters: Record<string, RuntimeAdapter> = { omo, omp, claude };
const warned = new Set<string>();

export function runtimeFor(role: Role): RuntimeAdapter {
	const id = (role === "orchestrator" ? cfg.orchestrator?.runtime : cfg.lanes?.runtime) ?? cfg.runtime ?? DEFAULT_RUNTIME;
	if (Object.hasOwn(adapters, id)) return adapters[id];
	if (!warned.has(`${role}:${id}`)) {
		warned.add(`${role}:${id}`);
		log(`unknown runtime "${id}" for the ${role}; using ${DEFAULT_RUNTIME}`);
	}
	return adapters[DEFAULT_RUNTIME];
}
