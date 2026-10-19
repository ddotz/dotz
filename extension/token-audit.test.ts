// The session token audit (module form of the owner's harness script) and the harness tools' guard health check.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS } from "./guard-config.ts";
import { guardHealth, installHarnessTools } from "./harness-tools.ts";
import { runTokenAudit } from "./token-audit.ts";

// The test preload fakes Date.now (hub/runtime/test-clock.ts); file mtimes are real, so these take the real time explicitly.
const realNow = () => new Date().getTime();

let dir: string;
let sessions: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-audit-"));
	sessions = join(dir, "sessions");
	mkdirSync(join(sessions, "--tmp-proj--"), { recursive: true });
	const now = realNow();
	const turn = (i: number, model: string) => ({
		type: "message",
		timestamp: new Date(now - (10 - i) * 60_000).toISOString(),
		message: {
			role: "assistant",
			provider: "anthropic",
			model,
			stopReason: "toolUse",
			usage: { totalTokens: 1000, input: 100, output: 50, cacheRead: 800, cacheWrite: 50, cost: { total: 0.5 } },
			content: [{ type: "toolCall", name: "read", arguments: { path: "same.txt" } }],
		},
	});
	const lines = Array.from({ length: 6 }, (_, i) => JSON.stringify(turn(i, "fable-x")));
	writeFileSync(join(sessions, "--tmp-proj--", "2026-10-19_abcdef12.jsonl"), `${lines.join("\n")}\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("audit: repeated-call finding, expensive-model finding only when configured, report written", async () => {
	const reportDir = join(dir, "logs");
	const plain = await runTokenAudit({ hours: 1, sessionsDir: sessions, reportDir, lang: "en", now: realNow() });
	expect(plain.sessions).toBe(1);
	expect(plain.flags).toBe(1);
	expect(plain.text).toContain("Token audit");
	expect(plain.text).toContain("Repeated call");
	expect(plain.text).not.toContain("Expensive model");
	const gated = await runTokenAudit({ hours: 1, sessionsDir: sessions, reportDir, lang: "en", now: realNow(), expensiveModels: ["fable", ":max"] });
	expect(gated.flags).toBe(2);
	expect(gated.text).toContain("Expensive model");
	expect(readFileSync(gated.report!, "utf8")).toContain("the same tool call 6 times in a row");
	const ko = await runTokenAudit({ hours: 1, sessionsDir: sessions, reportDir: false, lang: "ko", now: realNow() });
	expect(ko.text).toContain("토큰 점검");
	expect(ko.report).toBeUndefined();
});

test("audit: a session older than the window is skipped; a missing directory is an empty audit", async () => {
	const none = await runTokenAudit({ hours: 1, sessionsDir: join(dir, "nope"), reportDir: false, lang: "en", now: realNow() });
	expect(none).toMatchObject({ sessions: 0, flags: 0 });
	const later = await runTokenAudit({ hours: 1, sessionsDir: sessions, reportDir: false, lang: "en", now: realNow() + 5 * 3600e3 });
	expect(later.sessions).toBe(0);
});

test("guardHealth: unmarked briefs and unisolated writers are reported", () => {
	const dirOf = join(dir, "health");
	mkdirSync(dirOf, { recursive: true });
	const entry = (task: string, isolated: boolean) =>
		JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", name: "task", arguments: { tasks: [{ agent: "task", task, isolated }] } }] } });
	writeFileSync(join(dirOf, "s.jsonl"), `${entry("a\n[orchestrator-guard] Final answer", true)}\n${entry("bare brief", false)}\n`);
	const health = guardHealth(dirOf, realNow());
	expect(health.problems.some(p => p.includes("did not process 1 of 2 worker briefs"))).toBe(true);
	expect(health.problems.some(p => p.includes("1 of 2 writing workers ran without isolation"))).toBe(true);
	expect(guardHealth(join(dir, "absent"), realNow()).problems).toEqual([]);
});

test("harness tools: commands and tools registered; an installed original defers them", () => {
	const make = (agent: string) => {
		const commands: string[] = [];
		const tools: string[] = [];
		const logs: string[] = [];
		const pi = {
			pi: { getAgentDir: () => agent },
			logger: { warn: (m: string) => logs.push(m) },
			zod: { object: () => ({}), number: () => ({ optional: () => ({}) }), boolean: () => ({ optional: () => ({}) }) },
			on: () => {},
			registerCommand: (name: string) => commands.push(name),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
		};
		return { pi, commands, tools, logs };
	};
	const fresh = make(join(dir, "agent-none"));
	installHarnessTools(fresh.pi);
	expect(fresh.commands.sort()).toEqual(["doctor", "handover", "token-audit"]);
	expect(fresh.tools.sort()).toEqual(["harness_doctor", "harness_token_audit"]);

	const agent = join(dir, "agent-installed");
	mkdirSync(join(agent, "extensions"), { recursive: true });
	writeFileSync(join(agent, "extensions", "harness-tools.ts"), "export default () => {};\n");
	const deferred = make(agent);
	installHarnessTools(deferred.pi);
	expect(deferred.commands).toEqual([]);
	expect(deferred.tools).toEqual([]);
	expect(deferred.logs.length).toBe(1);
	expect(GUARD_DEFAULTS.harness_tools).toBe(true);
});
