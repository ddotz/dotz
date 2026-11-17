import { isSubagent } from "./guard-config.ts";
import { RECALL_TOOL } from "./recall-tool.ts";

type Handler = (event: unknown, ctx: unknown, ...rest: unknown[]) => unknown;
type ToolDef = { name: string; defaultInactive?: boolean };

const REFUSED = "dotz: this tool belongs to the session that started you, not to its subagents. Finish your task and say in your final answer what you needed it for.";

/** The part of omp's extension API the install functions of this extension use. */
export interface Host {
	on(name: string, handler: Handler, ...options: unknown[]): unknown;
	registerTool(tool: ToolDef): unknown;
	sendMessage(message: unknown, options?: unknown): unknown;
	getActiveTools?(): string[];
	setActiveTools?(names: string[]): unknown;
	setLabel?(label: string): unknown;
	events?: { on(name: string, listener: (data: unknown) => void): unknown };
}

// why(platform): omp reruns an extension's factory in every task subagent and sets ctx.agent only for hooks and tools, so no install function can tell its agent while the factory runs (omp@18.22.0)
const gated = (pi: Host, allow: (ctx: unknown) => boolean, registerTool?: (tool: ToolDef) => unknown): Host =>
	Object.assign(Object.create(pi) as Host, {
		on: (name: string, handler: Handler, ...options: unknown[]) =>
			pi.on(name, (event: unknown, ctx: unknown, ...rest: unknown[]) => (allow(ctx) ? handler(event, ctx, ...rest) : undefined), ...options),
		...(registerTool && { registerTool }),
	});

// why(platform): omp imports the extension again (`?mtime`, a fresh module graph) for an isolated task subagent, so a module-level counter would start at 0 there; the count lives on the process (omp@18.22.0)
const RUNS = Symbol.for("dotz.omp.factoryRuns");
const runs = globalThis as { [RUNS]?: number };

/** The hosts the install functions get on omp: the hooks of `main` answer the main agent, the hooks of `workers` a subagent. The first factory run of a process is the main agent's and registers its tools as usual; a later run is a subagent's, so a tool registered through `main` starts inactive there and its prompt and tool list never hold it (dotz_recall, the one tool a subagent keeps, is active at once). A main agent that is not the first run switches them on when its session starts. `gateway` collects the names of the tools left to the main agent. */
export function ompHosts(pi: Host): { main: Host; workers: Host; gateway: Set<string> } {
	const gateway = new Set<string>();
	// why(platform): omp runs an extension's factory for the main agent first and once more for every task subagent, all in one process (omp@18.22.0)
	const first = (runs[RUNS] = (runs[RUNS] ?? 0) + 1) === 1;
	const main = gated(pi, ctx => !isSubagent(ctx), tool => {
		if (tool.name === RECALL_TOOL) return pi.registerTool(tool);
		gateway.add(tool.name);
		return pi.registerTool(first ? tool : { ...tool, defaultInactive: true });
	});
	if (!first) {
		main.on("session_start", async () => {
			const active = pi.getActiveTools?.();
			if (active) await pi.setActiveTools?.([...new Set([...active, ...gateway])]);
		});
	}
	return { main, workers: gated(pi, isSubagent), gateway };
}

/** The backstop for the tools a subagent never has active: a call to one that still gets through is refused. */
export function refuseInSubagents(pi: Host, gateway: ReadonlySet<string>): void {
	pi.on("tool_call", (event, ctx) => {
		const name = (event as { toolName?: unknown } | undefined)?.toolName;
		return isSubagent(ctx) && typeof name === "string" && gateway.has(name) ? { block: true, reason: REFUSED } : undefined;
	});
}
