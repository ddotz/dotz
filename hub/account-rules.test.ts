import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aliasesFile, setAlias } from "./account-alias.ts";
import { checkNow, decisionsFile, evaluate, lastDecision, readRules, rulesFile, runScript, type Rules, type ScriptInput, setManual, setUsage, writeRules } from "./account-rules.ts";
import { type AccountSwitch, MAX_LOG_LINES, onSwitch, type Pool, resetStickyForTest, stickyAccount, switchesFile } from "./account-sticky.ts";
import { authFile } from "./apikey-policy.ts";
import { DATA_DIR } from "./config.ts";

const MIN = 60_000;
const at = (s: string) => Date.parse(s);
const WED_10 = at("2026-10-21T10:00:00+09:00");
const WED_20 = at("2026-10-21T20:00:00+09:00");
const FRI_23 = at("2026-10-23T23:00:00+09:00");
const SAT_02 = at("2026-10-24T02:00:00+09:00");
const SAT_10 = at("2026-10-24T10:00:00+09:00");
const SAT_23 = at("2026-10-24T23:00:00+09:00");
const FRI_02 = at("2026-10-23T02:00:00+09:00");

const poolFile = () => join(process.env.OMO_CODING_AGENT_DIR!, "credential-pool-state.json");
const scriptDir = () => join(process.env.DOTZ_TEST_DIR!, "scripts");
const pool = (names: string[], blocked: Pool["blocked"] = {}): Pool => ({ names, blocked, lastSuccess: {} });
const ev = (over: Partial<Parameters<typeof evaluate>[0]> & { rules: Rules }) => evaluate({ now: WED_10, pool: pool(["personal", "work", "spare"]), current: "personal", usage: {}, aliases: {}, ...over });

function writeAuth(names: string[]): void {
	writeFileSync(authFile(), JSON.stringify({ "anthropic-subscription": { accounts: names.map(name => ({ name, access: "fake" })) } }));
}
function writeSlots(slots: Record<string, unknown>, apiKeySlots: Record<string, unknown> = {}): void {
	writeFileSync(poolFile(), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots } } }, anthropic: { lanes: { stored: { slots: apiKeySlots } } } } }));
}
function script(name: string, body: string): string {
	mkdirSync(scriptDir(), { recursive: true });
	const file = join(scriptDir(), `${name}.ts`);
	writeFileSync(file, body);
	return file;
}
const input = (over: Partial<ScriptInput> = {}): ScriptInput => ({ now: new Date(WED_10).toISOString(), current: "personal", accounts: [{ name: "personal", alias: null, blocked: null, blocked_until: null, five_hour_left: 40, seven_day_left: 70 }, { name: "work", alias: "회사 계정", blocked: null, blocked_until: null, five_hour_left: null, seven_day_left: null }], ...over });
const decisionLines = () => (existsSync(decisionsFile()) ? readFileSync(decisionsFile(), "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);

const weekdays = ["mon", "tue", "wed", "thu", "fri"] as const;
const officeRule: Rules = { rules: [{ name: "office", when: { days: [...weekdays], from: "09:00", to: "18:00" }, do: { pin: "work" } }] };

let seen: AccountSwitch[] = [];
beforeEach(() => {
	for (const f of [authFile(), poolFile(), join(DATA_DIR, "account.json"), switchesFile(), rulesFile(), decisionsFile(), aliasesFile()]) rmSync(f, { force: true });
	resetStickyForTest();
	seen = [];
	onSwitch(s => seen.push(s));
});
afterEach(() => {
	for (const f of [authFile(), poolFile(), join(DATA_DIR, "account.json"), switchesFile(), rulesFile(), decisionsFile(), aliasesFile()]) rmSync(f, { force: true });
	resetStickyForTest();
});

test("a weekday window pins inside it and leaves the account alone outside it (KST)", () => {
	expect(ev({ rules: officeRule, now: WED_10 })).toMatchObject({ account: "work", source: "rule", rule: "office" });
	expect(ev({ rules: officeRule, now: WED_20 })).toMatchObject({ account: "personal", source: "auto" });
	expect(ev({ rules: officeRule, now: SAT_10 })).toMatchObject({ account: "personal", source: "auto" });
	expect(ev({ rules: officeRule, now: at("2026-10-21T18:00:00+09:00") }).source).toBe("auto");
	expect(ev({ rules: officeRule, now: at("2026-10-21T09:00:00+09:00") }).source).toBe("rule");
});

test("a window that wraps midnight belongs to the day it started on", () => {
	const night: Rules = { rules: [{ name: "night", when: { days: ["fri"], from: "22:00", to: "06:00" }, do: { pin: "spare" } }] };
	expect(ev({ rules: night, now: FRI_23 }).account).toBe("spare");
	expect(ev({ rules: night, now: SAT_02 }).account).toBe("spare");
	expect(ev({ rules: night, now: SAT_23 }).source).toBe("auto");
	expect(ev({ rules: night, now: FRI_02 }).source).toBe("auto");
});

test("the 5-hour threshold moves off the current account, and unknown usage does not", () => {
	const low: Rules = { rules: [{ name: "low", when: { five_hour_left_below: 10 }, do: { prefer: ["work", "spare"] } }] };
	expect(ev({ rules: low, usage: { personal: { five_hour_left: 8 }, work: { five_hour_left: 50 } } })).toMatchObject({ account: "work", source: "rule", change: { from: "personal", to: "work", kind: "rule", rule: "low" } });
	expect(ev({ rules: low, usage: { personal: { five_hour_left: 30 } } })).toMatchObject({ account: "personal", source: "auto" });
	expect(ev({ rules: low, usage: {} })).toMatchObject({ account: "personal", source: "auto" });
	// the next listed account is used when the first is itself under the threshold or blocked
	expect(ev({ rules: low, usage: { personal: { five_hour_left: 8 }, work: { five_hour_left: 4 } } }).account).toBe("spare");
	expect(ev({ rules: low, pool: pool(["personal", "work", "spare"], { work: { reason: "rate_limit", until: WED_10 + MIN } }), usage: { personal: { five_hour_left: 8 } } }).account).toBe("spare");
});

test("auth_error on the current account falls back to another subscription account, never to an API-key slot", () => {
	writeAuth(["personal", "work"]);
	writeSlots({ personal: { blockReason: "auth_error", lastSuccessAt: 1 }, work: { lastSuccessAt: 2 } }, { "apikey-main": { lastSuccessAt: 9 }, "apikey-spare": {} });
	const p = readFileSync(poolFile(), "utf8");
	expect(p).toContain("apikey-main");
	const rules: Rules = { rules: [{ name: "relogin", when: { auth_error: true }, do: { prefer: ["apikey-main", "work"] } }] };
	const pl = evaluate({ now: WED_10, pool: pool(["personal", "work"], { personal: { reason: "auth_error" } }), current: "personal", usage: {}, rules, aliases: {} });
	expect(pl).toMatchObject({ account: "work", source: "rule" });
	// no rule: the automatic layer picks the other subscription account
	stickyAccount(WED_10);
	resetStickyForTest();
	writeFileSync(join(DATA_DIR, "account.json"), JSON.stringify({ account: "personal" }));
	expect(stickyAccount(WED_10)).toBe("work");
	// everything blocked: stays put rather than reaching for an API-key slot
	writeSlots({ personal: { blockReason: "auth_error" }, work: { blockReason: "auth_error" } }, { "apikey-main": { lastSuccessAt: 9 } });
	resetStickyForTest();
	writeFileSync(join(DATA_DIR, "account.json"), JSON.stringify({ account: "personal" }));
	expect(stickyAccount(WED_10)).toBe("personal");
	expect(evaluate({ now: WED_10, pool: pool(["personal", "work"], { personal: { reason: "auth_error" } }), current: "personal", usage: {}, rules: { manual: { account: "apikey-main" } }, aliases: {} }).account).toBe("work");
});

test("manual beats rules and the script; an expired manual pick is ignored", () => {
	const rules: Rules = { ...officeRule, manual: { account: "spare", reason: "test" } };
	expect(ev({ rules, script: { account: "personal", at: "" } })).toMatchObject({ account: "spare", source: "manual" });
	const expired: Rules = { ...officeRule, manual: { account: "spare", until: new Date(WED_10 - MIN).toISOString() } };
	expect(ev({ rules: expired })).toMatchObject({ account: "work", source: "rule" });
	const active: Rules = { manual: { account: "회사 계정", until: new Date(WED_10 + MIN).toISOString() } };
	expect(ev({ rules: active, aliases: { work: "회사 계정" } })).toMatchObject({ account: "work", source: "manual" });
	// 고정: a blocked manual account still holds (hard), it does not fall through to the next layer
	expect(ev({ rules: { ...officeRule, manual: { account: "spare" } }, pool: pool(["personal", "work", "spare"], { spare: { reason: "rate_limit" } }) })).toMatchObject({ account: "spare", source: "manual", hard: true });
});

test("a pin to a blocked or absent account falls through; prefer takes the next usable one", () => {
	const blocked = pool(["personal", "work", "spare"], { work: { reason: "rate_limit", until: WED_10 + MIN } });
	expect(ev({ rules: officeRule, pool: blocked })).toMatchObject({ account: "personal", source: "auto" });
	expect(ev({ rules: { rules: [{ do: { pin: "ghost" } }] } }).source).toBe("auto");
	expect(ev({ rules: { rules: [{ do: { prefer: ["work", "spare"] } }] }, pool: blocked })).toMatchObject({ account: "spare", source: "rule" });
	expect(ev({ rules: { rules: [{ when: { unavailable: "work" }, do: { pin: "spare" } }] }, pool: blocked }).account).toBe("spare");
	expect(ev({ rules: { rules: [{ when: { unavailable: "work" }, do: { pin: "spare" } }] } }).source).toBe("auto");
	expect(ev({ rules: { rules: [{ do: { auto: true } }, { do: { pin: "spare" } }] } }).source).toBe("auto");
});

test("script hook: an alias resolves to the slot id, the reason comes from line 2, and stdin carries the accounts", async () => {
	const file = script("alias", `const i = JSON.parse(await Bun.stdin.text());\nif (process.env.DOTZ_ACCOUNT_CURRENT === i.current && i.accounts.length === 2) console.log("회사 계정\\nbig meeting");`);
	expect(await runScript(file, input(), 5000)).toMatchObject({ account: "work", reason: "big meeting" });
	expect((await runScript(file, input(), 5000)).error).toBeUndefined();
});

test("script hook: empty output, a non-zero exit, an unknown account and a missing file are no opinion", async () => {
	expect(await runScript(script("empty", `console.log("");`), input(), 5000)).toEqual({ at: input().now });
	expect(await runScript(script("fail", `console.log("work"); process.exit(3);`), input(), 5000)).toMatchObject({ error: "exit" });
	expect(await runScript(script("ghost", `console.log("nobody");`), input(), 5000)).toMatchObject({ error: "unknown_account" });
	expect((await runScript(join(scriptDir(), "missing-script"), input(), 5000)).account).toBeUndefined();
	// no opinion means the rules still decide
	expect(ev({ rules: officeRule, script: { at: "" } }).source).toBe("rule");
	expect(ev({ rules: officeRule, script: { error: "exit", at: "" } }).source).toBe("rule");
	expect(ev({ rules: officeRule, script: { account: "spare", at: "" } })).toMatchObject({ account: "spare", source: "script" });
});

// A child that never finishes: a promise nothing resolves, held open by a timer that never fires. The test waits on the
// kill result of runScript's timeout, not on this script.
const NEVER_EXITS = "await new Promise(() => setInterval(() => {}, 2 ** 30))";

test("script hook: a script that outlives its timeout is killed and reported as a timeout", async () => {
	const file = script("slow", `${NEVER_EXITS}; console.log("work");`);
	const opinion = await runScript(file, input(), 50);
	expect(opinion).toMatchObject({ error: "timeout" });
	expect(opinion.account).toBeUndefined();
});

test("checkNow: the script's pick is applied, the script runs at most once per 30 s, decisions.jsonl logs changes only", async () => {
	writeAuth(["personal", "work"]);
	writeSlots({ personal: { lastSuccessAt: 2 }, work: { lastSuccessAt: 1 } });
	setAlias("work", "회사 계정");
	const counter = join(scriptDir(), "runs.log");
	mkdirSync(scriptDir(), { recursive: true });
	const file = script("pick", `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "x\\n");\nconsole.log("회사 계정");\nconsole.log("owner script");`);
	writeRules({ script: { path: file, timeout_ms: 5000 } });
	const d = await checkNow(WED_10);
	expect(d).toMatchObject({ account: "work", source: "script" });
	expect(JSON.parse(readFileSync(join(DATA_DIR, "account.json"), "utf8")).account).toBe("work");
	expect(seen.map(s => [s.kind, s.to])).toEqual([["script", "work"]]);
	await checkNow(WED_10 + 10_000);
	await checkNow(WED_10 + 20_000);
	expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
	await checkNow(WED_10 + 40_000);
	expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
	expect(lastDecision()).toMatchObject({ account: "work", source: "script" });
	expect(decisionLines()).toHaveLength(1);
	// the decision changes: one more line, not one per run
	setManual("personal", "back", undefined);
	await checkNow(WED_10 + 80_000);
	await checkNow(WED_10 + 81_000);
	expect(decisionLines().map(l => [l.account, l.source])).toEqual([["work", "script"], ["personal", "manual"]]);
	expect(seen.map(s => s.kind)).toEqual(["script", "manual"]);
});

test("checkNow: a restart with the same decision adds no decisions.jsonl line", async () => {
	writeAuth(["personal", "work"]);
	writeSlots({ personal: { lastSuccessAt: 2 }, work: { lastSuccessAt: 1 } });
	await checkNow(WED_10);
	expect(decisionLines().map(l => [l.account, l.source])).toEqual([["personal", "auto"]]);
	for (let i = 1; i <= 3; i++) {
		resetStickyForTest(); // a gateway restart: memory gone, the files stay
		await checkNow(WED_10 + i * 5 * MIN);
	}
	expect(decisionLines()).toHaveLength(1);
	expect(lastDecision()).toMatchObject({ account: "personal", source: "auto" });
	expect(existsSync(switchesFile()) ? readFileSync(switchesFile(), "utf8").trim().split("\n") : []).toHaveLength(1);
});

test("decisions.jsonl keeps its last 20 lines and drops repeated ones when it is trimmed", async () => {
	writeAuth(["personal", "work"]);
	writeSlots({ personal: { lastSuccessAt: 2 }, work: { lastSuccessAt: 1 } });
	const row = (i: number) => ({ account: i % 2 ? "x" : "y", source: "auto", reason: "r", at: new Date(WED_10 + i * MIN).toISOString() });
	const seed = [...Array.from({ length: 24 }, (_, i) => row(i)), row(23)]; // ends with a repeat
	mkdirSync(dirname(decisionsFile()), { recursive: true });
	writeFileSync(decisionsFile(), `${seed.map(r => JSON.stringify(r)).join("\n")}\n`);
	await checkNow(WED_10 + 30 * MIN);
	const lines = decisionLines();
	expect(lines).toHaveLength(MAX_LOG_LINES);
	expect(lines.at(-1)).toMatchObject({ account: "personal", source: "auto" });
	expect(lines.every((l, i) => i === 0 || l.account !== lines[i - 1].account)).toBe(true);
});

test("checkNow: a script timeout is logged once with its error kind, and the rules decide meanwhile", async () => {
	writeAuth(["personal", "work"]);
	writeSlots({ personal: { lastSuccessAt: 2 }, work: { lastSuccessAt: 1 } });
	const file = script("hang", NEVER_EXITS);
	writeRules({ ...officeRule, script: { path: file, timeout_ms: 50 } });
	const d = await checkNow(WED_10);
	expect(d).toMatchObject({ account: "work", source: "rule", rule: "office" });
	await checkNow(WED_10 + 5000);
	await checkNow(WED_10 + 6000);
	const lines = decisionLines();
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({ account: "work", source: "rule", script_error: "timeout" });
});

test("stickyAccount follows the usage numbers once they are known", () => {
	writeAuth(["personal", "work"]);
	writeSlots({ personal: { lastSuccessAt: 2 }, work: { lastSuccessAt: 1 } });
	writeRules({ rules: [{ name: "low 5h", when: { five_hour_left_below: 10 }, do: { prefer: ["work"] } }] });
	expect(stickyAccount(WED_10)).toBe("personal");
	setUsage({ personal: { five_hour_left: 6 }, work: { five_hour_left: 80 } });
	expect(stickyAccount(WED_10 + 1000)).toBe("work");
	expect(seen[0]).toMatchObject({ kind: "rule", rule: "low 5h", from: "personal", to: "work" });
});

test("the rules file: round trip, a manual pick set and cleared, and bad input rejected with the field named", () => {
	const rules: Rules = { manual: { account: "work", reason: "r" }, rules: officeRule.rules, script: { path: "~/pick.sh", every_minutes: 10 } };
	expect(writeRules(rules)).toEqual(rules);
	expect(readRules()).toEqual(rules);
	expect(setManual(undefined).manual).toBeUndefined();
	expect(readRules().rules).toEqual(officeRule.rules);
	expect(setManual("spare", "x", "2030-01-01T00:00:00Z").manual).toEqual({ account: "spare", reason: "x", until: "2030-01-01T00:00:00Z" });
	expect(() => writeRules({ rules: [{ when: { from: "9am" }, do: { pin: "work" } }] })).toThrow("from");
	expect(() => writeRules({ rules: [{ do: { pin: "a", auto: true } }] })).toThrow("do");
	expect(() => writeRules({ manual: { account: "a", until: "someday" } })).toThrow("manual.until");
	expect(() => writeRules({ script: { path: "" } })).toThrow("script.path");
	writeFileSync(rulesFile(), "{ not json");
	expect(readRules()).toEqual({});
});
