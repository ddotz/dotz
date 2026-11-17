import { expect, test } from "bun:test";
import { join } from "node:path";

const run = (value?: string) => {
	const env: Record<string, string | undefined> = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: value };
	if (value === undefined) delete env.ENABLE_CLAUDEAI_MCP_SERVERS;
	const script = 'await import("./extension/index.ts"); console.log("[" + process.env.ENABLE_CLAUDEAI_MCP_SERVERS + "]"); process.exit(0);';
	const r = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	return r.stdout.toString().trim();
};

test("merely loading the extension in an owner's own session leaves the claude.ai connectors switch alone (the role branches set it: omp-host.test.ts)", () => {
	expect(run()).toBe("[undefined]");
});

test("an owner-set value stays", () => {
	expect(run("true")).toBe("[true]");
});
