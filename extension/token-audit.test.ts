// The session token audit (module form of the owner's harness script) and the harness tools' guard health check.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS } from "./guard-config.ts";
import { guardHealth, installHarnessTools } from "./harness-tools.ts";
import { runTokenAudit } from "./token-audit.ts";

// The audit reads file mtimes, so every session file is stamped with this fixed time instead of the real clock.
const NOW = Date.parse("2026-10-23T00:00:00Z");
const put = (file: string, text: string) => {
	writeFileSync(file, text);
	utimesSync(file, NOW / 1000, NOW / 1000);
};

let dir: string;
let sessions: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-audit-"));
	sessions = join(dir, "sessions");
	mkdirSync(join(sessions, "--tmp-proj--"), { recursive: true });
	const now = NOW;
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
	put(join(sessions, "--tmp-proj--", "2026-10-19_abcdef12.jsonl"), `${lines.join("\n")}\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("audit: repeated-call finding, expensive-model finding only when configured, report written", async () => {
	const reportDir = join(dir, "logs");
	const plain = await runTokenAudit({ hours: 1, sessionsDir: sessions, reportDir, lang: "en", now: NOW });
	expect(plain.sessions).toBe(1);
	expect(plain.flags).toBe(1);
	expect(plain.text).toContain("Token audit");
	expect(plain.text).toContain("Repeated call");
	expect(plain.text).not.toContain("Expensive model");
	const gated = await runTokenAudit({ hours: 1, sessionsDir: sessions, reportDir, lang: "en", now: NOW, expensiveModels: ["fable", ":max"] });
	expect(gated.flags).toBe(2);
	expect(gated.text).toContain("Expensive model");
	expect(readFileSync(gated.report!, "utf8")).toContain("the same tool call 6 times in a row");
	const ko = await runTokenAudit({ hours: 1, sessionsDir: sessions, reportDir: false, lang: "ko", now: NOW });
	expect(ko.text).not.toContain("Token audit");
	expect(ko.report).toBeUndefined();
});

test("audit: a session older than the window is skipped; a missing directory is an empty audit", async () => {
	const none = await runTokenAudit({ hours: 1, sessionsDir: join(dir, "nope"), reportDir: false, lang: "en", now: NOW });
	expect(none).toMatchObject({ sessions: 0, flags: 0 });
	const later = await runTokenAudit({ hours: 1, sessionsDir: sessions, reportDir: false, lang: "en", now: NOW + 5 * 3600e3 });
	expect(later.sessions).toBe(0);
});

test("audit: OmO sessions are read with the OmO rules (only its wake events count as an idle wake)", async () => {
	const now = NOW;
	const at = (min: number) => new Date(now - min * 60_000).toISOString();
	const reply = (min: number) => ({
		type: "message",
		timestamp: at(min),
		message: { role: "assistant", provider: "anthropic", model: "opus", stopReason: "stop", usage: { totalTokens: 1000, input: 100, output: 20, cacheRead: 800, cacheWrite: 100, cost: { total: 0.1 } }, content: [] },
	});
	const custom = (min: number, customType: string) => ({ type: "custom_message", timestamp: at(min), customType });
	const lines = [reply(9), custom(8, "senpi-monitor:notification"), reply(7), custom(6, "todo-state"), reply(5)];
	const tree = (name: string) => {
		const root = join(dir, name);
		mkdirSync(join(root, "--tmp-proj--"), { recursive: true });
		put(join(root, "--tmp-proj--", "2026-10-19_0a1b2c3d.jsonl"), `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
		return root;
	};
	const reportDir = join(dir, "logs-omo");
	const omo = await runTokenAudit({ hours: 1, roots: [{ dir: tree("omo"), runtime: "omo" }], reportDir, lang: "en", now });
	const omoReport = readFileSync(omo.report!, "utf8");
	expect(omo.sessions).toBe(1);
	expect(omoReport).toContain("/tmp/proj 0a1b2c3d [OmO]");
	expect(omoReport).toContain("1 turn(s) woke with nothing to do");
	const omp = await runTokenAudit({ hours: 1, roots: [{ dir: tree("omp"), runtime: "omp" }], reportDir, lang: "en", now });
	expect(readFileSync(omp.report!, "utf8")).toContain("2 turn(s) woke with nothing to do");
});

test("guardHealth: unmarked briefs and unisolated writers are reported", () => {
	const dirOf = join(dir, "health");
	mkdirSync(dirOf, { recursive: true });
	const entry = (task: string, isolated: boolean) =>
		JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", name: "task", arguments: { tasks: [{ agent: "task", task, isolated }] } }] } });
	put(join(dirOf, "s.jsonl"), `${entry("a\n[orchestrator-guard] Final answer", true)}\n${entry("bare brief", false)}\n`);
	const health = guardHealth(dirOf, NOW);
	expect(health.problems.some(p => p.includes("did not process 1 of 2 worker briefs"))).toBe(true);
	expect(health.problems.some(p => p.includes("1 of 2 writing workers ran without isolation"))).toBe(true);
	expect(guardHealth(join(dir, "absent"), NOW).problems).toEqual([]);
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
