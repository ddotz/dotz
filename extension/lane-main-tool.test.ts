import { expect, test } from "bun:test";
import { join } from "node:path";

// Which sessions get dotz_main (the lane's request to the main session): the lane itself, not its task workers, not the orchestrator or a
// conversation session (they already have dotz_conv send main).
const SCRIPT = `
const names = [];
const base = { on: () => undefined, registerTool: t => names.push(t.name), registerCommand: () => undefined };
const pi = new Proxy(base, { get: (t, p) => (p in t ? t[p] : p === "zod" ? undefined : () => undefined) });
(await import("./extension/index.ts")).default(pi);
console.log(JSON.stringify(names));
process.exit(0);`;

function toolNames(env: Record<string, string>): string[] {
	const base = { ...process.env, DOTZ_RUNTIME: "omo" } as Record<string, string | undefined>;
	for (const k of ["DOTZ_ORCHESTRATOR", "DOTZ_CONV", "DOTZ_LANE", "OMO_SENPI_TASK_DEPTH"]) delete base[k];
	Object.assign(base, env);
	const r = Bun.spawnSync([process.execPath, "-e", SCRIPT], { cwd: join(import.meta.dir, ".."), env: base as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "[]");
}

test("a lane has dotz_main; its task worker, the orchestrator and a conversation session do not", () => {
	expect(toolNames({ DOTZ_LANE: "alpha" })).toContain("dotz_main");
	expect(toolNames({ DOTZ_LANE: "alpha", OMO_SENPI_TASK_DEPTH: "1" })).not.toContain("dotz_main");
	expect(toolNames({ DOTZ_ORCHESTRATOR: "1" })).not.toContain("dotz_main");
	expect(toolNames({ DOTZ_ORCHESTRATOR: "1", DOTZ_CONV: "ch:1" })).not.toContain("dotz_main");
});
