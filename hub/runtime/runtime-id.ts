import { cfg } from "../config.ts";
import type { Role } from "./types.ts";

export const DEFAULT_RUNTIME = "omo";
/** The runtimes dotz has an adapter for; hub/runtime/index.ts holds exactly one adapter per name. */
export const RUNTIME_IDS = ["omo", "omp", "claude"];

/** The runtime name config.json gives a role: `orchestrator.runtime` / `lanes.runtime`, else `runtime`, else the default. As written: a typo is still seen. */
export const configuredRuntime = (role: Role): string => (role === "orchestrator" ? cfg.orchestrator?.runtime : cfg.lanes?.runtime) ?? cfg.runtime ?? DEFAULT_RUNTIME;

/** The runtime that runs a role, as hub/runtime/index.ts runtimeFor decides it: the configured name when an adapter answers to it, else the default. */
export const runtimeIdOf = (role: Role): string => {
	const id = configuredRuntime(role);
	return RUNTIME_IDS.includes(id) ? id : DEFAULT_RUNTIME;
};

/** Whether the orchestrator or the lanes run on this runtime. */
export const rolesOn = (id: string): boolean => runtimeIdOf("orchestrator") === id || runtimeIdOf("lane") === id;
