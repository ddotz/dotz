// Which runtime runs a role: `orchestrator.runtime` / `lanes.runtime`, else the global `runtime`, else omp. A name no
// adapter answers to is logged once and falls back to omp, so a typo in config.json never leaves the gateway without an agent.
import { cfg, log } from "../config.ts";
import { claude } from "./claude.ts";
import { omo } from "./omo.ts";
import { omp } from "./omp.ts";
import type { Role, RuntimeAdapter } from "./types.ts";

export const adapters: Record<string, RuntimeAdapter> = { omp, claude, omo };
const warned = new Set<string>();

export function runtimeFor(role: Role): RuntimeAdapter {
	const id = (role === "orchestrator" ? cfg.orchestrator?.runtime : cfg.lanes?.runtime) ?? cfg.runtime ?? "omp";
	if (Object.hasOwn(adapters, id)) return adapters[id];
	if (!warned.has(`${role}:${id}`)) {
		warned.add(`${role}:${id}`);
		log(`unknown runtime "${id}" for the ${role}; using omp`);
	}
	return omp;
}
