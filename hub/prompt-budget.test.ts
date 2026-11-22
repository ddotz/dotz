import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, TEMPLATES } from "./config.ts";
import { BOUNDARIES_TEMPLATE_MAX_BYTES, LESSONS_TEMPLATE_MAX_BYTES, MODE_KO_MD_MAX_BYTES, MODE_MD_MAX_BYTES, OWNER_TEMPLATE_MAX_BYTES, RULES_TEMPLATE_MAX_BYTES } from "./prompt-budget.ts";

const repo = join(import.meta.dir, "..");
const bytes = (text: string | Buffer) => Buffer.byteLength(text);

const budgets: [name: string, size: number, cap: number][] = [
	["MODE.md", bytes(readFileSync(join(repo, "MODE.md"))), MODE_MD_MAX_BYTES],
	["MODE.ko.md", bytes(readFileSync(join(repo, "MODE.ko.md"))), MODE_KO_MD_MAX_BYTES],
	["RULES template (hub/config.ts)", bytes(TEMPLATES[paths.rules]), RULES_TEMPLATE_MAX_BYTES],
	["LESSONS template (hub/config.ts)", bytes(TEMPLATES[paths.lessons]), LESSONS_TEMPLATE_MAX_BYTES],
	["owner card template (hub/config.ts)", bytes(TEMPLATES[paths.owner]), OWNER_TEMPLATE_MAX_BYTES],
	["boundaries template (hub/config.ts)", bytes(TEMPLATES[paths.boundaries]), BOUNDARIES_TEMPLATE_MAX_BYTES],
];

test("prompt files stay within their byte caps", () => {
	const over = budgets
		.filter(([, size, cap]) => size > cap)
		.map(([name, size, cap]) => `${name} is ${size - cap} bytes over its cap (${size} > ${cap}); cut text to fit (the two MODE caps in hub/prompt-budget.ts are fixed; bump a template cap only if the growth is deliberate)`);
	expect(over).toEqual([]);
});

// The dotz_* tool descriptions ride along on every request of the main session (19071 characters on 2026-11-13, about as much as
// MODE itself). Measured 16240 after the diet, cap = measured + 10%, rounded up to 10: a new line has to replace an old one.
const MAIN_DOTZ_TOOL_DESCRIPTION_MAX_CHARS = 17870;

// The orchestrator's tool list, registered the way OmO loads the extension (no zod: JSON Schema parameters), in a child process
// so the env switch and the throwaway data dir stay out of this test process.
const LIST_TOOLS = `
const tools = [];
const pi = new Proxy({ registerTool: t => tools.push(t) }, { get: (t, p) => (p in t ? t[p] : p === "zod" ? undefined : () => undefined) });
(await import("./extension/index.ts")).default(pi);
console.log(JSON.stringify(tools.map(t => ({ name: t.name, chars: String(t.description ?? "").length }))));
process.exit(0);`;

test("the main session's dotz_* tool descriptions stay within their character cap", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-tool-budget-"));
	try {
		const env: Record<string, string | undefined> = { ...process.env, DOTZ_DIR: dir, DOTZ_RUNTIME: "omo", DOTZ_ORCHESTRATOR: "1" };
		for (const k of ["DOTZ_CONV", "DOTZ_LANE", "OMO_SENPI_TASK_DEPTH"]) delete env[k];
		const r = Bun.spawnSync([process.execPath, "-e", LIST_TOOLS], { cwd: repo, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
		const tools: { name: string; chars: number }[] = JSON.parse(r.stdout.toString().trim().split("\n").pop() || "[]");
		const dotz = tools.filter(t => t.name.startsWith("dotz_"));
		expect(dotz.map(t => t.name)).toContain("dotz_lane"); // the orchestrator's own tools were registered
		const total = dotz.reduce((sum, t) => sum + t.chars, 0);
		expect(total <= MAIN_DOTZ_TOOL_DESCRIPTION_MAX_CHARS ? "within cap" : `dotz_* descriptions are ${total} characters, over the ${MAIN_DOTZ_TOOL_DESCRIPTION_MAX_CHARS} cap: ${dotz.map(t => `${t.name} ${t.chars}`).join(", ")}`).toBe("within cap");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
