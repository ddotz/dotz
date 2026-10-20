// Every slash command answers with a card (title, facts, plain-text fallback) that carries no internal words or paths.
// bunfig.toml preloads hub/runtime/test-setup.ts, which points DOTZ_DIR at a temp folder before any hub module loads.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { limitsCard, runCommand, setGatewayRestart } from "./control.ts";
import type { AccountReport } from "./usage-account.ts";

const STATUS_WORDS = /\b(working|idle|stopped|exited|starting)\b/;
const COMMANDS = [
	"/help",
	"/status",
	"/context",
	"/compact nosuchlane",
	"/lanes",
	"/model",
	"/model orchestrator",
	"/model nosuchlane",
	"/effort",
	"/effort nosuchlane high",
	"/restart nosuchlane",
	"/restart gateway",
	"/stop nosuchlane",
	"/resume nosuchlane",
	"/abort nosuchlane",
	"/providers",
	"/login",
	"/login cancel",
	"/logout nosuchprovider",
	"/quota",
	"/nosuchcommand",
];

function expectCard(card: Awaited<ReturnType<typeof runCommand>>): void {
	expect(card.title.trim()).not.toBe("");
	expect(Array.isArray(card.facts)).toBe(true);
	expect(card.text.trim()).not.toBe("");
	for (const f of card.facts) {
		expect(f.label.trim()).not.toBe("");
		expect(f.value).not.toMatch(STATUS_WORDS);
		expect(f.value).not.toContain(homedir());
	}
	for (const a of card.actions ?? []) {
		expect(a.label.trim()).not.toBe("");
		expect(a.send.startsWith("/")).toBe(true);
	}
}

test("every command returns a card with a plain-text fallback", async () => {
	setGatewayRestart(() => "gateway restarting");
	for (const text of COMMANDS) {
		const card = await runCommand(text);
		expectCard(card);
		expect(card.text).toContain(card.title);
	}
});

test("a failed command is an err card with a one-line reason and no home path", async () => {
	const card = await runCommand("/stop");
	expect(card.tone).toBe("err");
	expect(card.note).toBeTruthy();
	expect(card.note).not.toContain("\n");
	expect(card.note).not.toContain(homedir());
});

test("/help groups the commands", async () => {
	const card = await runCommand("/help");
	expect(card.facts.length).toBeGreaterThan(1);
	for (const name of ["status", "model", "effort", "quota", "login"]) expect(card.facts.some(f => f.value.includes(`/${name}`))).toBe(true);
});

test("/effort offers the other levels as commands to send", async () => {
	const card = await runCommand("/effort orchestrator");
	expectCard(card);
	expect(card.actions?.length).toBeGreaterThan(0);
	for (const a of card.actions ?? []) expect(a.send).toMatch(/^\/effort orchestrator \S+$/);
});

test("the limits card lists each window's remaining share, reset time and the last switch", () => {
	const resetsAt = Date.parse("2026-10-21T03:00:00Z");
	const window = (id: string) => ({ id, label: id, durationMs: 1, resetsAt });
	const amount = (used: number) => ({ used, limit: 100, remaining: 100 - used, usedFraction: used / 100, remainingFraction: 1 - used / 100, unit: "percent" as const });
	const report = { provider: "anthropic", account: "owner", via: "omo-pool", limits: [{ id: "anthropic:5h", label: "Claude 5 Hour", window: window("5h"), amount: amount(30) }, { id: "anthropic:7d", label: "Claude 7 Day", window: window("7d"), amount: amount(60) }] } as unknown as AccountReport;
	const card = limitsCard(report, { at: "2026-10-20T10:00:00Z", from: "a", to: "b", kind: "limit", reason: "internal reason text" });
	expect(card.facts.length).toBe(4);
	expect(card.facts[0]!.value).toContain("70%");
	expect(card.facts[1]!.value).toContain("40%");
	expect(card.facts.at(-1)!.value).toContain("a → b");
	expect(card.facts.some(f => f.value.includes("internal reason text"))).toBe(false);
	expect(limitsCard(undefined, undefined).tone).toBe("warn");
});
