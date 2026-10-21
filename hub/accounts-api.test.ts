import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aliasesFile, readAliases, setAlias } from "./account-alias.ts";
import { decisionsFile, readRules, rulesFile, setUsage, writeRules } from "./account-rules.ts";
import { type AccountSwitch, resetStickyForTest, stickyAccount, switchesFile } from "./account-sticky.ts";
import { accountAnswer, accountAsk, accountsBody, KIND_TEXT, accountsRoute, accountText, labeledAccountView, switchNotice, switchText } from "./accounts-api.ts";
import { authFile } from "./apikey-policy.ts";
import { DATA_DIR } from "./config.ts";
import { msg } from "./i18n.ts";
import { limitsCard, runCommand } from "./control.ts";
import { buildQuota } from "./providers.ts";
import { limitsOf, type AccountReport } from "./usage-account.ts";

const WED_10 = Date.parse("2026-10-21T10:00:00+09:00");
const ALIASES = { default: "개인 계정", work: "회사 계정" };
const poolFile = () => join(process.env.OMO_CODING_AGENT_DIR!, "credential-pool-state.json");
const files = () => [authFile(), poolFile(), join(DATA_DIR, "account.json"), switchesFile(), rulesFile(), decisionsFile(), aliasesFile()];

function writeAuth(names: string[]): void {
	writeFileSync(authFile(), JSON.stringify({ "anthropic-subscription": { accounts: names.map(name => ({ name, access: "fake" })) } }));
}
function writeSlots(slots: Record<string, unknown>): void {
	writeFileSync(poolFile(), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots } } } } }));
}
const report = (account: string): AccountReport => ({ provider: "anthropic", account, via: "omo-sticky", limits: limitsOf({ five_hour: { utilization: 38 }, seven_day: { utilization: 20 } }), fetchedAt: WED_10 });
const sw = (over: Partial<AccountSwitch> = {}): AccountSwitch => ({ at: "2026-10-21T01:00:00.000Z", from: "default", to: "work", kind: "rule", rule: "근무 시간", reason: '규칙 "근무 시간"', ...over });
const cmdNote = async (text: string) => (await runCommand(text)).note ?? "";
const call = (method: string, path: string, body?: unknown) => accountsRoute(new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://x${path}`));

beforeEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});
afterEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});

test("the 한도 card names the account by its alias; the raw ids only sit on the note line", () => {
	const c = limitsCard(report("default"), sw(), ALIASES);
	expect(c.facts.find(f => f.label === msg().cmd.account)!.value).toBe("개인 계정");
	expect(c.facts.find(f => f.label === msg().cmd.lastSwitch)!.value).toContain("개인 계정");
	for (const f of c.facts) expect(`${f.label} ${f.value}`).not.toMatch(/default|work/);
	expect(c.note).toBe(`${msg().cmd.accountId}: default → work`);
	expect(c.text).toContain("개인 계정");
});

test("without an alias the 한도 card shows the id and adds no id line", () => {
	const c = limitsCard(report("default"), undefined, {});
	expect(c.facts.find(f => f.label === msg().cmd.account)!.value).toBe("default");
	expect(c.note).toBeUndefined();
	expect(limitsCard(undefined, undefined, {}).tone).toBe("warn");
});

test("a first pick is not announced as a switch in the 한도 card", () => {
	const c = limitsCard(report("default"), sw({ kind: "start", from: undefined, to: "default" }), ALIASES);
	expect(c.facts.some(f => f.label === msg().cmd.lastSwitch)).toBe(false);
	expect(c.note).toBe(`${msg().cmd.accountId}: default`);
});

test("switchText and switchNotice use labels, never raw ids", () => {
	expect(switchText(sw(), ALIASES)).toBe('개인 계정 → 회사 계정 (규칙 "근무 시간")');
	const limit = sw({ kind: "limit", rule: undefined, reason: "default blocked (rate_limit, until 2026-10-21T05:00:00.000Z); work is usable" });
	expect(switchText(limit, ALIASES)).toBe(`개인 계정 → 회사 계정 (${KIND_TEXT.limit})`);
	expect(switchText(sw({ kind: "start", from: undefined, to: "default", rule: undefined, reason: "first account" }), ALIASES)).toBe(`개인 계정 (${KIND_TEXT.start})`);
	expect(switchText(sw({ to: "other" }), {})).toBe('default → other (규칙 "근무 시간")');
	// The notice names both accounts by label, from before to, and never a raw id; a rule switch also names the rule.
	const manual = sw({ from: "work", to: "default", kind: "manual", rule: undefined, reason: "직접 고름" });
	for (const [s, from, to] of [[sw(), "개인 계정", "회사 계정"], [limit, "개인 계정", "회사 계정"], [manual, "회사 계정", "개인 계정"]] as const) {
		const n = switchNotice(s, ALIASES);
		expect(n).not.toMatch(/default|work/);
		expect(n.indexOf(from)).toBeGreaterThanOrEqual(0);
		expect(n.indexOf(to)).toBeGreaterThan(n.indexOf(from));
	}
	expect(switchNotice(sw(), ALIASES)).toContain("근무 시간");
	expect(new Set([sw(), limit, manual].map(s => switchNotice(s, ALIASES))).size).toBe(3);
});

test("accountsBody carries labels, states, decision, rules as text, manual pick, script and files", () => {
	writeAuth(["default", "work"]);
	writeSlots({ work: { blockReason: "rate_limit", blockedUntil: WED_10 + 3_600_000 } });
	for (const [k, v] of Object.entries(ALIASES)) setAlias(k, v);
	setUsage({ default: { five_hour_left: 62, seven_day_left: 80 } });
	writeRules({ manual: { account: "회사 계정", until: "2026-10-21T18:00:00+09:00" }, rules: [{ name: "근무 시간", when: { days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" }, do: { pin: "work" } }], script: { path: "/tmp/pick.sh" } });
	const b = accountsBody(WED_10);
	expect(b.accounts).toEqual([
		{ name: "default", alias: "개인 계정", label: "개인 계정", current: true, blocked: null, blocked_until: null, five_hour_left: 62, seven_day_left: 80 },
		{ name: "work", alias: "회사 계정", label: "회사 계정", current: false, blocked: "rate_limit", blocked_until: new Date(WED_10 + 3_600_000).toISOString(), five_hour_left: null, seven_day_left: null },
	]);
	expect(b.decision).toMatchObject({ account: "default", label: "개인 계정", source: "auto" });
	expect(b.rules.rules?.[0]?.name).toBe("근무 시간");
	expect(b.rules_text.map(r => r.index)).toEqual([0]);
	for (const part of ["09:00-18:00", "회사 계정"]) expect(b.rules_text[0]!.text).toContain(part);
	for (const part of ["회사 계정", "18:00"]) expect(b.manual_text).toContain(part);
	expect(b.script).toEqual({ path: "/tmp/pick.sh", timeout_ms: 5000, every_minutes: 5, last: null });
	expect(Object.keys(b.files).sort()).toEqual(["aliases", "decisions", "rules"]);
	for (const f of Object.values(b.files)) expect(f.startsWith("/")).toBe(true);
	expect(Array.isArray(b.switches)).toBe(true);
	expect(Object.keys(b).sort()).toEqual(["accounts", "decision", "files", "manual_text", "rules", "rules_text", "script", "switches"]);
});

test("accountsBody switches carry from_label/to_label/kind_text and labeledAccountView mirrors them", () => {
	writeAuth(["default", "work"]);
	for (const [k, v] of Object.entries(ALIASES)) setAlias(k, v);
	expect(stickyAccount()).toBe("default");
	writeSlots({ default: { blockReason: "rate_limit", blockedUntil: Date.now() + 3_600_000 } });
	expect(stickyAccount(Date.now() + 61_000)).toBe("work");
	const s = accountsBody().switches[0];
	expect(s).toMatchObject({ from: "default", to: "work", from_label: "개인 계정", to_label: "회사 계정", kind: "limit", kind_text: KIND_TEXT.limit });
	const v = labeledAccountView();
	expect(v.account).toBe("work");
	expect(v.account_label).toBe("회사 계정");
	expect(v.switches[0]).toMatchObject({ from_label: "개인 계정", to_label: "회사 계정", kind_text: KIND_TEXT.limit });
});

test("/account shows the account, why, each account, the rules and the script; ids only on a detail line", async () => {
	writeAuth(["default", "work"]);
	writeSlots({ work: { blockReason: "rate_limit", blockedUntil: Date.now() + 3_600_000 } });
	for (const [k, v] of Object.entries(ALIASES)) setAlias(k, v);
	setUsage({ default: { five_hour_left: 62, seven_day_left: 80 } });
	writeRules({ rules: [{ name: "근무 시간", when: { days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" }, do: { pin: "work" } }], script: { path: "/tmp/pick.sh" } });
	const out = await cmdNote("/account");
	for (const part of ["개인 계정", "회사 계정", "62%", "80%", "09:00-18:00", "/tmp/pick.sh"]) expect(out).toContain(part);
	for (const l of out.split("\n").filter(l => l.includes("default") || l.includes("work"))) expect(l.startsWith("-# ")).toBe(true);
	expect(await cmdNote("!account")).toBe(out);
	expect(accountText()).toBe(out);
});

test("/account <alias> picks manually, /account auto clears it, /account alias sets and clears an alias", async () => {
	writeAuth(["default", "work"]);
	for (const [k, v] of Object.entries(ALIASES)) setAlias(k, v);
	expect(stickyAccount()).toBe("default");
	const picked = await cmdNote("/account 회사 계정");
	expect(picked.split("\n")).toHaveLength(1);
	expect(picked).toContain("회사 계정");
	expect(readRules().manual).toEqual({ account: "work" });
	expect(stickyAccount()).toBe("work");
	expect((await cmdNote("/account work")).split("\n")).toHaveLength(1);
	const auto = await cmdNote("/account auto");
	expect(auto.split("\n")).toHaveLength(1);
	expect(readRules().manual).toBeUndefined();
	const setNote = await cmdNote("/account alias work 출장 계정");
	for (const part of ["work", "출장 계정"]) expect(setNote).toContain(part);
	expect(readAliases().work).toBe("출장 계정");
	expect(await cmdNote("/account alias work")).toContain("work");
	expect(readAliases().work).toBeUndefined();
	for (const bad of ["/account nobody", "/account alias nobody 이름"]) {
		const c = await runCommand(bad);
		expect(c.tone).toBe("err");
		expect(c.note).toContain("nobody");
	}
});

test("a manual pick of a blocked account is stored but not applied, and the note names both accounts", async () => {
	writeAuth(["default", "work"]);
	writeSlots({ work: { blockReason: "rate_limit", blockedUntil: Date.now() + 3_600_000 } });
	for (const [k, v] of Object.entries(ALIASES)) setAlias(k, v);
	const out = await cmdNote("/account work");
	expect(readRules().manual).toEqual({ account: "work" });
	expect(stickyAccount()).toBe("default");
	for (const part of ["회사 계정", "개인 계정"]) expect(out).toContain(part);
});

test("quota providers carry the account's label next to its id", () => {
	setAlias("default", "개인 계정");
	const q = buildQuota([{ provider: "anthropic", account: "default", limits: [{ id: "anthropic:5h", label: "Claude 5 Hour", window: { id: "5h" }, amount: { used: 38, limit: 100, remaining: 62, unit: "percent" }, status: "ok" }] } as any], ["anthropic"]);
	expect(q.providers[0]).toMatchObject({ account: "default", account_label: "개인 계정" });
});

const NAMES = ["default", "work"];
const ask = (t: string) => accountAsk(t, NAMES, ALIASES);

test("chat matcher: short account requests match", () => {
	expect(ask("계정 바꿔줘")).toEqual({ kind: "other" });
	expect(ask("계정 전환해줘")).toEqual({ kind: "other" });
	expect(ask("다른 계정으로 바꿔줘")).toEqual({ kind: "other" });
	expect(ask("개인 계정으로 바꿔줘")).toEqual({ kind: "use", account: "default" });
	expect(ask("회사 계정으로")).toEqual({ kind: "use", account: "work" });
	expect(ask("회사 계정으로 전환해줘")).toEqual({ kind: "use", account: "work" });
	expect(ask("회사 계정 써줘")).toEqual({ kind: "use", account: "work" });
	expect(ask("work로 바꿔줘")).toEqual({ kind: "use", account: "work" });
	expect(ask("계정 자동으로")).toEqual({ kind: "auto" });
	expect(ask("계정 자동으로 해줘")).toEqual({ kind: "auto" });
	expect(ask("지금 무슨 계정이야?")).toEqual({ kind: "show" });
	expect(ask("현재 계정 알려줘")).toEqual({ kind: "show" });
});

test("chat matcher: ordinary sentences about accounts are left to the orchestrator", () => {
	for (const t of [
		"계정 관련 버그 고쳐줘",
		"깃허브 계정으로 로그인하는 법 알려줘",
		"회사 계정으로 로그인 기능 추가해줘",
		"회사 계정으로 보낸 메일 확인해줘",
		"계정 삭제해줘",
		"계정 바꾸는 기능 만들어줘",
		"계정 변경 이력 보여줘",
		"work 폴더 정리해줘",
		"개인 계정",
		"회사 계정 한도 올려줘",
		"계정 전환 로직을 리팩터링해줘",
		"",
		"계정 바꿔줘\n그리고 테스트도 돌려줘",
		"지금 무슨 계정이야 그리고 왜 한도에 자꾸 걸리는지 로그를 보고 원인을 분석해서 정리해줘",
	])
		expect(ask(t)).toBeUndefined();
	expect(accountAsk("깃허브 계정으로 바꿔줘", NAMES, ALIASES)).toBeUndefined();
});

test("chat answers: a named account picks, 자동 clears, one other usable account switches, several are listed", async () => {
	writeAuth(["default", "work"]);
	for (const [k, v] of Object.entries(ALIASES)) setAlias(k, v);
	expect(stickyAccount()).toBe("default");
	expect(await accountAnswer({ kind: "show" })).toContain("개인 계정");
	expect(stickyAccount()).toBe("default");
	expect(await accountAnswer({ kind: "other" })).toContain("회사 계정");
	expect(stickyAccount()).toBe("work");
	expect(await accountAnswer({ kind: "use", account: "default" })).toContain("개인 계정");
	expect(stickyAccount()).toBe("default");
	expect(readRules().manual).toEqual({ account: "default" });
	await accountAnswer({ kind: "auto" });
	expect(readRules().manual).toBeUndefined();

	writeAuth(["default", "work", "spare"]);
	setAlias("spare", "예비 계정");
	const listed = await accountAnswer({ kind: "other" });
	expect(listed).toContain("회사 계정");
	expect(listed).toContain("예비 계정");
	expect(listed).not.toContain("default");
	expect(stickyAccount()).toBe("default");
});

test("API: GET body, PUT alias (empty clears), POST use (unknown -> 400, auto clears)", async () => {
	writeAuth(["default", "work"]);
	const got = await call("GET", "/api/accounts");
	expect(got?.status).toBe(200);
	expect(((await got!.json()) as any).accounts).toHaveLength(2);

	const set = await call("PUT", "/api/accounts/alias", { key: "work", alias: "회사 계정" });
	expect(((await set!.json()) as any).accounts[1]).toMatchObject({ alias: "회사 계정", label: "회사 계정" });
	const cleared = await call("PUT", "/api/accounts/alias", { key: "work", alias: "" });
	expect(((await cleared!.json()) as any).accounts[1]).toMatchObject({ alias: null, label: "work" });
	expect((await call("PUT", "/api/accounts/alias", { alias: "x" }))?.status).toBe(400);

	setAlias("work", "회사 계정");
	const used = await call("POST", "/api/accounts/use", { account: "회사 계정" });
	expect(used?.status).toBe(200);
	const body = (await used!.json()) as any;
	expect(body.decision).toMatchObject({ account: "work", source: "manual" });
	expect(body.manual_text).toContain("회사 계정");
	const bad = await call("POST", "/api/accounts/use", { account: "nobody" });
	expect(bad?.status).toBe(400);
	expect(((await bad!.json()) as any).error).toContain("nobody");
	const auto = await call("POST", "/api/accounts/use", { account: "auto" });
	expect(((await auto!.json()) as any).manual_text).toBeNull();
	expect((await call("POST", "/api/accounts/use", { account: "work", until: "not a date" }))?.status).toBe(400);
	expect(await call("POST", "/api/accounts/check")).toBeUndefined();
});

test("API: PUT rules stores the whole file; a validation error is a 400 naming the field and changes nothing", async () => {
	writeAuth(["default", "work"]);
	const ok = await call("PUT", "/api/accounts/rules", { rules: { rules: [{ name: "밤", when: { from: "22:00", to: "06:00" }, do: { pin: "work" } }] } });
	expect(ok?.status).toBe(200);
	const text = ((await ok!.json()) as any).rules_text[0].text as string;
	for (const part of ["22:00-06:00", "work"]) expect(text).toContain(part);
	const bad = await call("PUT", "/api/accounts/rules", { rules: { rules: [{ when: { from: "25:00" }, do: { pin: "work" } }] } });
	expect(bad?.status).toBe(400);
	expect(((await bad!.json()) as any).error).toContain("규칙 1번.when.from");
	expect(readRules().rules?.[0]?.name).toBe("밤");
	const missing = await call("PUT", "/api/accounts/rules", {});
	expect(missing?.status).toBe(400);
	expect(typeof ((await missing!.json()) as any).error).toBe("string");
});
