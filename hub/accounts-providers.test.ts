import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkNow, decisionsFile, rulesFile, setRuleList } from "./account-rules.ts";
import { resetStickyForTest } from "./account-sticky.ts";
import { applyProviderPick, ownProviderPins, providerPinsFile, usageLeft } from "./accounts-providers.ts";
import { authFile } from "./apikey-policy.ts";

// Another provider's rules reach OmO as that pool's own pin (auth.json "<provider>".pinned; OmO re-reads it on each request, verified
// 2026-11-16 with a throwaway agent dir): a change is written once, with OmO's backup copy, nothing when unchanged, and the owner's own
// pin is never moved by a rule.
const NOW = Date.parse("2026-11-16T10:00:00+09:00");
const agentDir = () => dirname(authFile());
const backups = () => readdirSync(agentDir()).filter(f => f.startsWith("auth.json.dotz-account-backup-"));
const files = () => [authFile(), rulesFile(), decisionsFile(), providerPinsFile(), ...backups().map(f => join(agentDir(), f))];
const readAuth = () => JSON.parse(readFileSync(authFile(), "utf8"));
function writeAuth(pinned?: string): void {
	writeFileSync(authFile(), JSON.stringify({ "chatgpt-subscription": { type: "oauth", ...(pinned ? { pinned } : {}), accounts: [{ name: "default", access: "c" }, { name: "login-2", access: "d" }] } }, null, 2));
}
beforeEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});
afterEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});

test("a rule's pick is written to OmO's pin once, with a backup of the bytes before; the same pick again writes nothing", () => {
	writeAuth();
	const original = readFileSync(authFile(), "utf8");
	expect(applyProviderPick("chatgpt-subscription", "login-2", NOW)).toBe("written");
	expect(readAuth()["chatgpt-subscription"].pinned).toBe("login-2");
	expect(ownProviderPins()).toEqual({ "chatgpt-subscription": "login-2" });
	expect(backups()).toHaveLength(1);
	expect(readFileSync(join(agentDir(), backups()[0]!), "utf8")).toBe(original);
	const stamp = statSync(authFile()).mtimeMs;
	expect(applyProviderPick("chatgpt-subscription", "login-2", NOW)).toBe("unchanged");
	expect(statSync(authFile()).mtimeMs).toBe(stamp);
	// handing the choice back clears the pin and dotz's record of it
	expect(applyProviderPick("chatgpt-subscription", undefined, NOW)).toBe("written");
	expect(readAuth()["chatgpt-subscription"].pinned).toBeUndefined();
	expect(ownProviderPins()).toEqual({});
	expect(applyProviderPick("google", "x", NOW)).toBe("missing");
});

test("the owner's own pin stands: a rule never moves it and never clears it", () => {
	writeAuth("default");
	expect(applyProviderPick("chatgpt-subscription", "login-2", NOW)).toBe("owner");
	expect(applyProviderPick("chatgpt-subscription", undefined, NOW)).toBe("owner");
	expect(readAuth()["chatgpt-subscription"].pinned).toBe("default");
	expect(existsSync(providerPinsFile())).toBe(false);
});

test("checkNow applies another provider's rules through the pin, and an emptied rule list hands the choice back to OmO", async () => {
	writeAuth();
	setRuleList("chatgpt-subscription", [{ do: { pin: "login-2" } }]);
	await checkNow(NOW);
	expect(readAuth()["chatgpt-subscription"].pinned).toBe("login-2");
	setRuleList("chatgpt-subscription", []);
	await checkNow(NOW + 60_000);
	expect(readAuth()["chatgpt-subscription"].pinned).toBeUndefined();
	expect(ownProviderPins()).toEqual({});
});

test("usageLeft: an account's own 5-hour and 7-day windows; a model-scoped window and an old reading past its reset are left out", () => {
	const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
	const usage = { accounts: {
		"chatgpt-subscription/default": { windows: [{ label: "5h", windowMinutes: 300, usedPercent: 85, resetsAt: at(1) }, { label: "7d", windowMinutes: 10_080, usedPercent: 30, resetsAt: at(40) }, { label: "7d fable", windowMinutes: 10_080, usedPercent: 99, resetsAt: at(40) }] },
		"chatgpt-subscription/login-2": { windows: [{ label: "5h", windowMinutes: 300, usedPercent: 50, resetsAt: at(-1) }] },
		"anthropic-subscription/default": { windows: [{ label: "5h", windowMinutes: 300, usedPercent: 10, resetsAt: at(2) }] },
	} };
	expect(usageLeft(usage, "chatgpt-subscription", ["default", "login-2"], NOW)).toEqual({ default: { five_hour_left: 15, seven_day_left: 70 } });
	expect(usageLeft(usage, "anthropic", ["default"], NOW)).toEqual({ default: { five_hour_left: 90 } });
});
