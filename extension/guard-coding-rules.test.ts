import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_HARNESS_ENV } from "./harness-gate.ts";

let root: string;
let payload: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-guard-coding-rules-"));
	payload = join(root, "payload");
	mkdirSync(join(payload, "extensions"), { recursive: true });
	mkdirSync(join(root, "agent"), { recursive: true });
	mkdirSync(join(root, "data", "memory"), { recursive: true });
	for (const name of ["orchestrator-guard", "harness-tools", "done-gate"]) writeFileSync(join(payload, "extensions", `${name}.ts`), "export default () => {};\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const VERDICTS = `
import { installGuard } from ${JSON.stringify(join(import.meta.dir, "guard.ts"))};
import { GUARD_DEFAULTS } from ${JSON.stringify(join(import.meta.dir, "guard-config.ts"))};
const handlers = {};
const pi = { pi: { getAgentDir: () => process.env.TEST_AGENT_DIR }, zod: new Proxy({}, { get: () => () => pi.zod }), logger: { warn() {}, info() {} }, on: (n, f) => (handlers[n] ??= []).push(f), registerCommand() {}, registerTool() {}, sendMessage() {}, sendUserMessage() {}, getThinkingLevel: () => "low" };
installGuard(pi, { ...GUARD_DEFAULTS, ask_before_expensive: true, expensive_models: ["fable"] });
const ctx = { agent: { kind: "main", id: "main", depth: 0 }, cwd: process.env.DOTZ_DIR, hasUI: false, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } };
const first = async (name, ...args) => { for (const f of handlers[name] ?? []) { const r = await f(...args); if (r?.block) return "blocked"; } return "allowed"; };
console.log(JSON.stringify({
	merge: await first("tool_call", { toolName: "bash", input: { command: "gh pr merge 12 --squash" } }, ctx),
	ownerMemory: await first("tool_call", { toolName: "write", input: { path: process.env.DOTZ_DIR + "/memory/owner.md", content: "x" } }, ctx),
	broadSearch: await first("tool_call", { toolName: "grep", input: { pattern: "x", path: "/Users" } }, ctx),
	fableWorker: await first("before_subagent_spawn", { agent: "task", patterns: ["anthropic/claude-fable-5"] }, ctx),
}));
`;

function verdicts(marker: string | undefined): Record<string, string> {
	const env: Record<string, string | undefined> = { ...process.env, TEST_AGENT_DIR: join(root, "agent"), DOTZ_DIR: join(root, "data"), DOTZ_LANE: "lane1", DOTZ_RUNTIME: "omp", [CODING_HARNESS_ENV]: marker };
	const r = Bun.spawnSync([process.execPath, "-e", VERDICTS], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
}

test("a coding lane keeps the rules only dotz has: a merge outside dotz_merge, an owner-memory write and an unasked Fable worker stay blocked, while the broad-search check the payload's guard owns is left to it", () => {
	expect(verdicts(payload)).toEqual({ merge: "blocked", ownerMemory: "blocked", broadSearch: "allowed", fableWorker: "blocked" });
	expect(verdicts(undefined)).toEqual({ merge: "blocked", ownerMemory: "blocked", broadSearch: "blocked", fableWorker: "blocked" });
});
