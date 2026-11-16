// Which subscription account dotz runs on, per provider, decided by the owner's rules (owner 2026-10-21: switch by time windows,
// usage conditions, an own script, or a manual pick; 2026-11-16: several accounts across several providers, conditions about a
// named account). <DATA_DIR>/accounts/rules.json (v2, one part per provider):
//   { "v": 2, "providers": { "anthropic": {
//     "manual": { "account", "until"?, "reason"? },
//     "rules":  [ { "name"?, "when"?: { days, from, to, conditions: [ { account?: X | "current", <one state> } ] },
//                   "do": { "pin": X } | { "prefer": [X, Y] } | { "auto": true } } ],
//     "script": { "path", "timeout_ms"?, "every_minutes"? },
//     "order": [X, Y, Z],
//     "on_limit": "switch" | "wait" },   the owner's answer for a pinned account at its usage limit; absent = ask once
//     "chatgpt-subscription": { "rules": [...] } } }   every other provider keeps rules only
// A state is five_hour_left_below: n | seven_day_left_below: n | rate_limited | auth_error | blocked (any block, or the account
// left the pool); its account is the one dotz runs on now unless `account` names another. A v1 file (the anthropic part at the
// top level, flat `when` keys, `unavailable: X`) reads as the anthropic part with the same decisions: each flat key becomes one
// condition on the current account and `unavailable: X` becomes { account: X, blocked: true }. The next write stores v2.
// Other providers' rules reach OmO as its own pin of that pool (applyProviderRules below).
// Precedence: manual (not expired) > the script's opinion > the first matching rule > automatic (decide() in account-sticky.ts).
// The manual pick is the owner's 고정 mode: it holds while blocked (no other account takes over; the work pauses). A layer's
// account that is blocked (OmO's rate_limit/auth block, not expired) or not in OmO's pool is skipped: script and pin fall
// through to the next layer, prefer takes the next listed usable one (and skips one whose known usage is under the rule's
// threshold). Candidates are only OmO's anthropic-subscription accounts (readPool); an API-key slot is never one. Times are the
// gateway's TZ (Asia/Seoul); from > to wraps midnight and the window belongs to the day it started on. `when` conditions are
// ANDed, and unknown usage means "not met".
//
// evaluate() is pure and synchronous (no model call, no I/O): the usage numbers are the cached oauth/usage reports
// (setUsage, fed by the usage source main.ts registers) and the script's last opinion is cached too. checkNow() refreshes both,
// then lets account-sticky.ts apply the decision. After a rule window ends dotz stays on its account (sticky, as always) until
// another rule or a limit moves it.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountsDir, aliasesFile, aliasesOf, aliasOf, readAliases, resolveAccount } from "./account-alias.ts";
import { type AccountSwitch, currentAccount, decide, MAX_LOG_LINES, type Pool, readPool, stickyAccount } from "./account-sticky.ts";
import { applyProviderPick, ownProviderPins, providerUsage } from "./accounts-providers.ts";
import { log, TZ, writeAtomic } from "./config.ts";
import { usedAccount } from "./usage-account.ts";

export const ANTHROPIC = "anthropic";
export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
// One condition: an account (absent = the one dotz runs on now) and exactly one state.
export type Cond = { account?: string; five_hour_left_below?: number; seven_day_left_below?: number; rate_limited?: true; auth_error?: true; blocked?: true };
// The v1 keys, still read (a hand-written file, an older client): each is one condition (condsOf).
type LegacyWhen = { five_hour_left_below?: number; seven_day_left_below?: number; rate_limited?: true; auth_error?: true; unavailable?: string };
export type When = { days?: Day[]; from?: string; to?: string; conditions?: Cond[] } & LegacyWhen;
export type Action = { pin: string } | { prefer: string[] } | { auto: true };
export type Rule = { name?: string; when?: When; do: Action };
export type Manual = { account: string; until?: string; reason?: string };
// A pinned account at its usage limit: switch to 자동 전환, or wait until the limit clears (asked once when unset).
export type OnLimit = "switch" | "wait";
type ScriptConfig = { path: string; timeout_ms?: number; every_minutes?: number };
export type Rules = { manual?: Manual; rules?: Rule[]; script?: ScriptConfig; order?: string[]; on_limit?: OnLimit };
export type RulesFile = { v: 2; providers: Record<string, Rules> };
export type Usage = Record<string, { five_hour_left?: number; seven_day_left?: number }>;
export type ScriptErrorKind = "timeout" | "exit" | "spawn" | "unknown_account";
type ScriptOpinion = { account?: string; reason?: string; error?: ScriptErrorKind; at: string };
export type ScriptInput = { now: string; current: string | null; accounts: { name: string; alias: string | null; blocked: null | "rate_limit" | "auth_error" | string; blocked_until: string | null; five_hour_left: number | null; seven_day_left: number | null }[] };
// hard: the owner's 고정 mode. Requests stay on `account` even while it is blocked, and OmO is told not to fall back (account-sticky.ts).
export type Decision = { account?: string; source: "manual" | "script" | "rule" | "auto"; rule?: string; reason: string; at: string; hard?: true };
export type Evaluated = Decision & { change?: Omit<AccountSwitch, "at"> };

export const rulesFile = () => join(accountsDir(), "rules.json");
export const decisionsFile = () => join(accountsDir(), "decisions.jsonl");
export const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;
export const DEFAULT_EVERY_MINUTES = 5;
const SCRIPT_DEDUPE_MS = 30_000;

const DAYS: Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (x: unknown): x is Record<string, any> => Boolean(x) && typeof x === "object" && !Array.isArray(x);
// A bad field: `where` names it ("규칙 1번.when.conditions[0].five_hour_left_below"), `why` says what it needs.
export class RuleError extends Error {
	constructor(readonly where: string, readonly why: string) {
		super(`${where}: ${why}`);
	}
}
function bad(where: string, why: string): never {
	throw new RuleError(where, why);
}
const STATES = ["five_hour_left_below", "seven_day_left_below", "rate_limited", "auth_error", "blocked"] as const;
const percent = (where: string, v: unknown): number => {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) bad(where, "0~100 사이의 숫자여야 해요");
	return v as number;
};
const nonEmpty = (where: string, v: unknown): string => {
	if (typeof v !== "string" || !v.trim()) bad(where, "비어 있지 않은 글자여야 해요");
	return (v as string).trim();
};

function validateWhen(where: string, w: unknown): When {
	if (!isObj(w)) bad(where, "조건은 객체여야 해요");
	const o = w as Record<string, any>;
	const out: When = {};
	if (o.days !== undefined) {
		if (!Array.isArray(o.days) || !o.days.length || o.days.some((d: unknown) => !DAYS.includes(d as Day))) bad(`${where}.days`, `mon,tue,wed,thu,fri,sat,sun 중에서 골라야 해요`);
		out.days = [...new Set<Day>(o.days)];
	}
	for (const k of ["from", "to"] as const) {
		if (o[k] === undefined) continue;
		if (typeof o[k] !== "string" || !HHMM.test(o[k])) bad(`${where}.${k}`, "HH:MM 형식이어야 해요 (예: 09:00)");
		out[k] = o[k];
	}
	if (out.from !== undefined && out.from === out.to) bad(where, "from과 to가 같을 수 없어요");
	if (o.conditions !== undefined && !Array.isArray(o.conditions)) bad(`${where}.conditions`, "목록이어야 해요");
	const conds = (o.conditions ?? []).map((c: unknown, n: number) => validateCond(`${where}.conditions[${n}]`, c));
	// the v1 keys, checked in place and stored as conditions
	const legacy: Record<string, unknown> = {};
	for (const k of ["five_hour_left_below", "seven_day_left_below"] as const) if (o[k] !== undefined) legacy[k] = percent(`${where}.${k}`, o[k]);
	for (const k of ["rate_limited", "auth_error"] as const) {
		if (o[k] === undefined) continue;
		if (o[k] !== true) bad(`${where}.${k}`, "true만 쓸 수 있어요");
		legacy[k] = true;
	}
	if (o.unavailable !== undefined) legacy.unavailable = nonEmpty(`${where}.unavailable`, o.unavailable);
	conds.push(...condsOf(legacy as LegacyWhen));
	if (conds.length) out.conditions = conds;
	return out;
}

function validateCond(where: string, c: unknown): Cond {
	if (!isObj(c)) bad(where, "조건은 객체여야 해요");
	const o = c as Record<string, any>;
	const states = STATES.filter(k => o[k] !== undefined);
	if (states.length !== 1) bad(where, `상태를 하나만 골라야 해요 (${STATES.join(", ")})`);
	const out: Cond = o.account === undefined || o.account === "current" ? {} : { account: nonEmpty(`${where}.account`, o.account) };
	const k = states[0]!;
	if (k === "five_hour_left_below" || k === "seven_day_left_below") out[k] = percent(`${where}.${k}`, o[k]);
	else if (o[k] !== true) bad(`${where}.${k}`, "true만 쓸 수 있어요");
	else out[k] = true;
	return out;
}

// Every condition of a `when`, the v1 keys included: each flat key is one condition on the current account, `unavailable: X` is X blocked.
export function condsOf(w: When | LegacyWhen | undefined): Cond[] {
	if (!w) return [];
	const out: Cond[] = [...((w as When).conditions ?? [])];
	if (w.five_hour_left_below !== undefined) out.push({ five_hour_left_below: w.five_hour_left_below });
	if (w.seven_day_left_below !== undefined) out.push({ seven_day_left_below: w.seven_day_left_below });
	if (w.rate_limited) out.push({ rate_limited: true });
	if (w.auth_error) out.push({ auth_error: true });
	if (w.unavailable !== undefined) out.push({ account: w.unavailable, blocked: true });
	return out;
}

export function validateRule(i: number, r: unknown): Rule {
	const where = `규칙 ${i + 1}번`;
	if (!isObj(r)) bad(where, "객체여야 해요");
	const o = r as Record<string, any>;
	if (o.name !== undefined && typeof o.name !== "string") bad(`${where}.name`, "글자여야 해요");
	const d = o.do;
	if (!isObj(d)) bad(`${where}.do`, "pin, prefer, auto 중 하나가 필요해요");
	const kinds = ["pin", "prefer", "auto"].filter(k => d[k] !== undefined);
	if (kinds.length !== 1) bad(`${where}.do`, "pin, prefer, auto 중 정확히 하나만 써야 해요");
	let action: Action;
	if (kinds[0] === "pin") action = { pin: nonEmpty(`${where}.do.pin`, d.pin) };
	else if (kinds[0] === "prefer") {
		if (!Array.isArray(d.prefer) || !d.prefer.length) bad(`${where}.do.prefer`, "계정 이름 목록이 필요해요");
		action = { prefer: d.prefer.map((x: unknown, n: number) => nonEmpty(`${where}.do.prefer[${n}]`, x)) };
	} else {
		if (d.auto !== true) bad(`${where}.do.auto`, "true만 쓸 수 있어요");
		action = { auto: true };
	}
	return { ...(o.name?.trim() ? { name: o.name.trim() } : {}), ...(o.when !== undefined ? { when: validateWhen(`${where}.when`, o.when) } : {}), do: action };
}

// One provider's part; throws a readable Korean error naming the bad field. Only Claude's part holds the manual pick, the
// script, the order and the limit answer (they act through Claude's own pin env); every other provider keeps its rules only.
export function validateRules(raw: unknown, provider = ANTHROPIC): Rules {
	if (!isObj(raw)) bad("규칙 파일", "JSON 객체여야 해요");
	const r = raw as Record<string, any>;
	if (provider !== ANTHROPIC) {
		const extra = Object.keys(r).find(k => k !== "rules");
		if (extra) bad(`providers.${provider}.${extra}`, "이 공급자는 rules만 쓸 수 있어요 (manual, script, order, on_limit은 Claude 구독만)");
	}
	const out: Rules = {};
	if (r.manual !== undefined) {
		const m = r.manual;
		if (!isObj(m)) bad("manual", "객체여야 해요");
		if (m.until !== undefined && (typeof m.until !== "string" || Number.isNaN(Date.parse(m.until)))) bad("manual.until", "ISO 시각이어야 해요 (예: 2026-10-21T18:00:00+09:00)");
		if (m.reason !== undefined && typeof m.reason !== "string") bad("manual.reason", "글자여야 해요");
		out.manual = { account: nonEmpty("manual.account", m.account), ...(m.until ? { until: m.until } : {}), ...(m.reason?.trim() ? { reason: m.reason.trim() } : {}) };
	}
	if (r.rules !== undefined) {
		if (!Array.isArray(r.rules)) bad("rules", "목록이어야 해요");
		out.rules = r.rules.map((x: unknown, i: number) => validateRule(i, x));
	}
	if (r.script !== undefined) {
		const s = r.script;
		if (!isObj(s)) bad("script", "객체여야 해요");
		const positive = (k: string, v: unknown): number => {
			if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`script.${k}`, "0보다 큰 숫자여야 해요");
			return v as number;
		};
		out.script = { path: nonEmpty("script.path", s.path), ...(s.timeout_ms !== undefined ? { timeout_ms: positive("timeout_ms", s.timeout_ms) } : {}), ...(s.every_minutes !== undefined ? { every_minutes: positive("every_minutes", s.every_minutes) } : {}) };
	}
	if (r.order !== undefined) {
		if (!Array.isArray(r.order)) bad("order", "계정 이름 목록이어야 해요");
		out.order = [...new Set<string>(r.order.map((x: unknown, n: number) => nonEmpty(`order[${n}]`, x)))];
	}
	if (r.on_limit !== undefined) {
		if (r.on_limit !== "switch" && r.on_limit !== "wait") bad("on_limit", '"switch" 또는 "wait"여야 해요');
		out.on_limit = r.on_limit;
	}
	return out;
}

// The whole file, v1 read as the anthropic part (see the head of this file).
export function validateRulesFile(raw: unknown): RulesFile {
	if (!isObj(raw)) bad("규칙 파일", "JSON 객체여야 해요");
	const r = raw as Record<string, any>;
	if (r.v === undefined && r.providers === undefined) return { v: 2, providers: { [ANTHROPIC]: validateRules(r) } };
	if (r.v !== 2) bad("v", "2여야 해요");
	if (!isObj(r.providers)) bad("providers", "공급자별 객체여야 해요");
	return { v: 2, providers: Object.fromEntries(Object.entries(r.providers as Record<string, unknown>).map(([id, part]) => [id, validateRules(part, id)])) };
}

// The file as written; a missing or broken file is "no rules" (dotz keeps running automatically), the break is logged once.
let brokenNote = "";
export function readRulesFile(file = rulesFile()): RulesFile {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { v: 2, providers: {} };
	}
	try {
		brokenNote = "";
		return validateRulesFile(JSON.parse(text));
	} catch (e) {
		const note = (e as Error).message;
		if (note !== brokenNote) log(`account rules ignored (${file}): ${note}`);
		brokenNote = note;
		return { v: 2, providers: {} };
	}
}
export const readRules = (provider = ANTHROPIC): Rules => readRulesFile().providers[provider] ?? {};

// One provider's part replaced; every other provider's part stays as it is. The file is written as v2.
export function writeRules(r: unknown, provider = ANTHROPIC): Rules {
	const clean = validateRules(r, provider);
	const file = readRulesFile();
	if (Object.keys(clean).length) file.providers[provider] = clean;
	else delete file.providers[provider];
	mkdirSync(accountsDir(), { recursive: true });
	writeAtomic(rulesFile(), `${JSON.stringify(file, null, 2)}\n`);
	return clean;
}

// The rules dialog's save: the rule list only (and Claude's script when the dialog's JSON view sent one, null removes it), so a
// stale copy of the order, the manual pick or the limit answer can never come back with it.
export function setRuleList(provider: string, rules: unknown, script?: unknown): Rules {
	if (!Array.isArray(rules)) bad("rules", "목록이어야 해요");
	const next: Record<string, unknown> = { ...readRules(provider) };
	if (rules.length) next.rules = rules;
	else delete next.rules;
	if (script === null) delete next.script;
	else if (script !== undefined) next.script = script;
	return writeRules(next, provider);
}

// The dialog's live check (POST /api/accounts/rules/check): each rule's sentence, or the field that is wrong. `known` says whether
// an account name (slot or alias) is one of this provider's accounts.
export type RuleCheck = { errors: { index: number; field: string; text: string }[]; texts: (string | null)[] };
export function checkRules(list: unknown, label: (name: string) => string, known?: (name: string) => boolean): RuleCheck {
	if (!Array.isArray(list)) return { errors: [{ index: -1, field: "rules", text: "목록이어야 해요" }], texts: [] };
	const out: RuleCheck = { errors: [], texts: [] };
	list.forEach((raw, i) => {
		try {
			const r = validateRule(i, raw);
			const named: [string, string][] = [
				...condsOf(r.when).flatMap((c, n): [string, string][] => (c.account ? [[`when.conditions[${n}].account`, c.account]] : [])),
				...("pin" in r.do ? [["do.pin", r.do.pin] as [string, string]] : "prefer" in r.do ? r.do.prefer.map((p, n): [string, string] => [`do.prefer[${n}]`, p]) : []),
			];
			const unknown = known && named.find(([, n]) => !known(n));
			if (unknown) bad(`규칙 ${i + 1}번.${unknown[0]}`, `모르는 계정이에요: ${unknown[1]}`);
			out.texts.push(describeRule(r, label));
		} catch (e) {
			if (!(e instanceof RuleError)) throw e;
			out.errors.push({ index: i, field: e.where.replace(/^규칙 \d+번\.?/, ""), text: e.why });
			out.texts.push(null);
		}
	});
	return out;
}

// The owner's account order saved; other parts of the file stay as they are.
export function setOrder(order: string[]): Rules {
	return writeRules({ ...readRules(), order });
}

// The owner's answer for a pinned account at its usage limit, saved once; undefined asks again next time.
export function setOnLimit(on_limit: OnLimit | undefined): Rules {
	const next = { ...readRules() };
	if (on_limit === undefined) delete next.on_limit;
	else next.on_limit = on_limit;
	return writeRules(next);
}

export const readOnLimit = (): OnLimit | undefined => readRules().on_limit;

// The manual pick set, or cleared with undefined; other parts of the file stay as they are.
export function setManual(account: string | undefined, reason?: string, until?: string): Rules {
	const next = { ...readRules() };
	if (account === undefined || !account.trim()) delete next.manual;
	else next.manual = { account, ...(until ? { until } : {}), ...(reason?.trim() ? { reason: reason.trim() } : {}) };
	return writeRules(next);
}

function zoned(now: number, tz = TZ): { day: number; minutes: number } {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
	const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
	const day = DAYS.findIndex(d => d === get("weekday").slice(0, 3).toLowerCase());
	return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function inTimeWindow(w: When, now: number): boolean {
	const z = zoned(now);
	const from = w.from === undefined ? undefined : toMinutes(w.from);
	const to = w.to === undefined ? undefined : toMinutes(w.to);
	let day = z.day;
	let inside = true;
	if (from !== undefined && to !== undefined && from > to) {
		inside = z.minutes >= from || z.minutes < to;
		if (z.minutes < to) day = (day + 6) % 7; // after midnight still belongs to the day the window started on
	} else {
		if (from !== undefined) inside &&= z.minutes >= from;
		if (to !== undefined) inside &&= z.minutes < to;
	}
	return inside && (!w.days || w.days.includes(DAYS[day]));
}

export const blockedKind = (reason: string): string => (/auth/i.test(reason) ? "auth_error" : /rate|limit|429|quota/i.test(reason) ? "rate_limit" : reason);

type Ctx = { now: number; pool: Pool; current?: string; usage: Usage; resolve: (t: string) => string | undefined };

// One condition about its account: the one named (by id or alias), else the one dotz runs on now.
function condMet(cnd: Cond, c: Ctx): boolean {
	const who = cnd.account === undefined ? c.current : c.resolve(cnd.account);
	// a named account that left the pool is not usable either
	if (cnd.blocked) return who ? Boolean(c.pool.blocked[who]) : cnd.account !== undefined;
	const u = who ? c.usage[who] : undefined;
	if (cnd.five_hour_left_below !== undefined) return u?.five_hour_left !== undefined && u.five_hour_left < cnd.five_hour_left_below;
	if (cnd.seven_day_left_below !== undefined) return u?.seven_day_left !== undefined && u.seven_day_left < cnd.seven_day_left_below;
	const block = who ? c.pool.blocked[who] : undefined;
	if (cnd.rate_limited) return Boolean(block && blockedKind(block.reason) === "rate_limit");
	if (cnd.auth_error) return Boolean(block && blockedKind(block.reason) === "auth_error");
	return true;
}

function matches(w: When | undefined, c: Ctx): boolean {
	if (!w) return true;
	if ((w.days || w.from !== undefined || w.to !== undefined) && !inTimeWindow(w, c.now)) return false;
	return condsOf(w).every(cnd => condMet(cnd, c));
}

// prefer skips a candidate that is itself under one of the rule's usage thresholds
const underThreshold = (a: string, w: When | undefined, usage: Usage): boolean => {
	const u = usage[a];
	return condsOf(w).some(cnd => (cnd.five_hour_left_below !== undefined && u?.five_hour_left !== undefined && u.five_hour_left < cnd.five_hour_left_below) || (cnd.seven_day_left_below !== undefined && u?.seven_day_left !== undefined && u.seven_day_left < cnd.seven_day_left_below));
};

type EvaluateInput = { now: number; pool: Pool | undefined; current?: string; usage: Usage; rules: Rules; script?: ScriptOpinion; aliases?: Record<string, string> };

// Pure: the account to run on now, which layer chose it, and the switch when it differs from `current`.
export function evaluate(i: EvaluateInput): Evaluated {
	const at = new Date(i.now).toISOString();
	const { pool, current, rules } = i;
	if (!pool) return { ...(current ? { account: current } : {}), source: "auto", reason: "OmO에 구독 계정이 없어요", at };
	const aliases = i.aliases ?? readAliases();
	const resolve = (t: string) => resolveAccount(t, pool.names, aliases);
	const usable = (n: string | undefined): n is string => n !== undefined && pool.names.includes(n) && !pool.blocked[n];
	const pick = (account: string, source: "manual" | "script" | "rule", reason: string, rule?: string): Evaluated => ({
		account,
		source,
		...(source === "manual" ? { hard: true as const } : {}),
		...(rule ? { rule } : {}),
		reason,
		at,
		...(account !== current ? { change: { ...(current ? { from: current } : {}), to: account, kind: source, ...(rule ? { rule } : {}), reason } } : {}),
	});
	const m = rules.manual;
	if (m && (!m.until || Date.parse(m.until) > i.now)) {
		const a = resolve(m.account);
		// 고정: the pick holds even while blocked (work pauses until the block ends); only a pick that left OmO's pool falls through.
		// A dead login (auth_error) is no limit to wait out: when another account works (a fresh /login, Mac mini 2026-10-26), the pick
		// yields to the layers below until the picked one works again. A limit (rate_limit) still holds the pick.
		const dead = !!a && pool.blocked[a]?.reason === "auth_error" && pool.names.some(n => n !== a && usable(n));
		if (a && pool.names.includes(a) && !dead) return pick(a, "manual", m.reason ? `직접 고름: ${m.reason}` : "직접 고름");
	}
	const s = i.script;
	if (s && !s.error && s.account && usable(s.account)) return pick(s.account, "script", s.reason ? `스크립트: ${s.reason}` : "스크립트가 골랐어요");
	const ctx: Ctx = { now: i.now, pool, current, usage: i.usage, resolve };
	const rule = (rules.rules ?? []).find(r => matches(r.when, ctx));
	if (rule) {
		const name = rule.name ?? describeRule(rule, n => aliasOf(n, undefined, aliases) ?? n);
		if ("pin" in rule.do) {
			const a = resolve(rule.do.pin);
			if (usable(a)) return pick(a, "rule", `규칙 "${name}"`, rule.name);
		} else if ("prefer" in rule.do) {
			const a = rule.do.prefer.map(resolve).find(x => usable(x) && !underThreshold(x, rule.when, i.usage));
			if (a) return pick(a, "rule", `규칙 "${name}"`, rule.name);
		}
		// an unusable pin/prefer (or an explicit auto) falls through to the automatic layer
	}
	const auto = decide(current, { ...pool, order: rules.order }, i.now);
	return { ...(auto.account ? { account: auto.account } : {}), source: "auto", reason: auto.change?.reason ?? (current ? `${current} 계정을 계속 써요` : "OmO 계정 풀"), at, ...(auto.change ? { change: auto.change } : {}) };
}

const KO_DAY: Record<Day, string> = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };
export const josa = (word: string, withFinal: string, without: string): string => {
	const code = word.trim().charCodeAt(word.trim().length - 1) - 0xac00;
	if (code < 0 || code > 11171) return without;
	const final = code % 28;
	return final === 0 || final === 8 ? without : withFinal;
};
const sameDays = (d: Day[], want: Day[]) => d.length === want.length && want.every(x => d.includes(x));

export function describeRule(rule: Rule, label: (name: string) => string): string {
	const w = rule.when ?? {};
	const days = w.days ? (sameDays(w.days, ["mon", "tue", "wed", "thu", "fri"]) ? "평일" : sameDays(w.days, ["sat", "sun"]) ? "주말" : sameDays(w.days, DAYS) ? "매일" : `${w.days.map(d => KO_DAY[d]).join("·")}요일`) : "";
	const span = w.from && w.to ? `${w.from}-${w.to}` : w.from ? `${w.from} 이후` : w.to ? `${w.to} 전` : "";
	const when = [days, span].filter(Boolean).join(" ");
	const conds = condsOf(w).map(c => {
		const s = c.account === undefined ? "" : label(c.account);
		if (c.five_hour_left_below !== undefined) return `${s ? `${s}의 ` : ""}5시간 한도가 ${c.five_hour_left_below}% 밑`;
		if (c.seven_day_left_below !== undefined) return `${s ? `${s}의 ` : ""}주간 한도가 ${c.seven_day_left_below}% 밑`;
		if (c.rate_limited) return s ? `${s}${josa(s, "이", "가")} 한도에 걸린` : "한도에 걸린";
		if (c.auth_error) return s ? `${s}의 로그인이 풀린` : "로그인이 풀린";
		return `${s || "지금 계정"}${josa(s || "지금 계정", "을", "를")} 못 쓰는`;
	});
	// "... 20% 밑이고 한도에 걸린 상태면": each condition but the last ends in "이고"/"상태이고", the last in "이면"/"상태면"
	const joined = conds.map((c, i) => `${c}${c.endsWith("밑") ? (i < conds.length - 1 ? "이고" : "이면") : i < conds.length - 1 ? " 상태이고" : " 상태면"}`).join(" ");
	const head = conds.length ? `${when ? `${when}에 ` : ""}${joined}` : when ? `${when}에는` : "항상";
	const d = rule.do;
	const tail = "pin" in d ? `${label(d.pin)}${josa(label(d.pin), "으로", "로")} 고정` : "prefer" in d ? `${d.prefer.map(label).join(", ")} 순서로 우선 사용` : "다음 계정으로";
	return `${head} ${tail}`;
}

const expand = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
const RUN_WITH_BUN = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

// Runs the owner's script: JSON on stdin, the account (id or alias) on the first stdout line, an optional reason on the second.
// Empty output is no opinion; a timeout (killed), a non-zero exit or an unknown account is no opinion with an error kind.
export async function runScript(path: string, input: ScriptInput, timeoutMs: number): Promise<ScriptOpinion> {
	const at = input.now;
	const file = expand(path);
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(RUN_WITH_BUN.test(file) ? [process.execPath, file] : [file], {
			stdin: Buffer.from(JSON.stringify(input)),
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, DOTZ_ACCOUNT_CURRENT: input.current ?? "" },
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
	} catch {
		return { error: "spawn", at };
	}
	const out = new Response(proc.stdout as ReadableStream).text().catch(() => "");
	const code = await proc.exited;
	if (proc.signalCode) return { error: "timeout", at };
	if (code !== 0) return { error: "exit", at };
	// A grandchild that inherited stdout can keep the pipe open after the script exits: give it 500 ms after exit, then treat it as no output.
	const text = await Promise.race([out, Bun.sleep(500).then(() => "")]);
	const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
	if (!lines.length) return { at };
	const aliases = Object.fromEntries(input.accounts.flatMap(a => (a.alias ? [[a.name, a.alias]] : [])));
	const account = resolveAccount(lines[0], input.accounts.map(a => a.name), aliases);
	if (!account) return { error: "unknown_account", at };
	return { account, ...(lines[1] ? { reason: lines[1] } : {}), at };
}

let usage: Usage = {};
let opinion: ScriptOpinion | undefined;
let version = 0;
let lastScriptRun = Number.NEGATIVE_INFINITY;
let scriptKey = "";
let inflight: Promise<void> | undefined;
let usageSource: (() => Promise<Usage>) | undefined;
let last: Decision | undefined;
let loggedKey: string | undefined;

export const getUsage = (): Usage => usage;
export const getScriptOpinion = (): ScriptOpinion | undefined => opinion;
// What makes a cached evaluation stale besides auth.json and the pool state: the rules file, aliases, usage, the script's opinion.
export function stateStamp(): string {
	const st = (f: string) => {
		try {
			const s = statSync(f);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return "-";
		}
	};
	return `${st(rulesFile())}|${st(aliasesFile())}|${version}`;
}

// The usage numbers per account, as the cached reports give them (hub/providers.ts usageSnapshot); a change re-evaluates.
export function setUsage(next: Usage): void {
	if (JSON.stringify(next) === JSON.stringify(usage)) return;
	usage = next;
	version++;
}
export function setUsageSource(fn: (() => Promise<Usage>) | undefined): void {
	usageSource = fn;
}
const setOpinion = (next: ScriptOpinion | undefined): void => {
	if (opinion?.account !== next?.account || opinion?.error !== next?.error || opinion?.reason !== next?.reason) version++;
	opinion = next;
};

type Row = Decision & { script_error?: string };
const rowKey = (r: Row) => `${r.account ?? ""}|${r.source}|${r.script_error ?? ""}`;
function decisionRows(): Row[] {
	try {
		return readFileSync(decisionsFile(), "utf8").split("\n").flatMap(l => {
			try {
				return l.trim() ? [JSON.parse(l) as Row] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}
// Oldest first; a line that repeats the previous line's decision changed nothing and is dropped.
const dropRepeats = (rows: Row[]): Row[] => rows.filter((r, i) => i === 0 || rowKey(r) !== rowKey(rows[i - 1]));

// Called by account-sticky.ts on every evaluation: remembers it, and logs a decisions.jsonl line only when the decision
// (account + source) or the script's error kind changed since the last line, which after a restart is the last line on disk.
// The file keeps its last MAX_LOG_LINES lines.
export function record(d: Decision): void {
	last = { ...(d.account ? { account: d.account } : {}), source: d.source, ...(d.rule ? { rule: d.rule } : {}), reason: d.reason, at: d.at, ...(d.hard ? { hard: true as const } : {}) };
	const err = opinion?.error ?? "";
	const row: Row = { ...last, ...(err ? { script_error: err } : {}) };
	const key = rowKey(row);
	const rows = loggedKey === undefined ? decisionRows() : undefined;
	if (rows) loggedKey = rows.length ? rowKey(rows[rows.length - 1]) : "";
	if (key === loggedKey) return;
	loggedKey = key;
	try {
		mkdirSync(accountsDir(), { recursive: true });
		writeAtomic(decisionsFile(), `${dropRepeats([...(rows ?? decisionRows()), row]).slice(-MAX_LOG_LINES).map(r => JSON.stringify(r)).join("\n")}\n`);
	} catch (e) {
		log(`account decision log failed: ${(e as Error).message}`);
	}
}

export function lastDecision(): Decision {
	if (!last) stickyAccount();
	return last ?? { source: "auto", reason: "아직 계정을 고르지 않았어요", at: new Date().toISOString() };
}

function scriptInput(now: number): ScriptInput {
	const pool = readPool(undefined, now);
	const aliases = readAliases();
	return {
		now: new Date(now).toISOString(),
		current: currentAccount() ?? null,
		accounts: (pool?.names ?? []).map(name => {
			const b = pool?.blocked[name];
			return { name, alias: aliases[name] ?? null, blocked: b ? blockedKind(b.reason) : null, blocked_until: b?.until ? new Date(b.until).toISOString() : null, five_hour_left: usage[name]?.five_hour_left ?? null, seven_day_left: usage[name]?.seven_day_left ?? null };
		}),
	};
}

// One script run at most every 30 s (the cached opinion serves the calls in between); a run in flight is shared.
async function refreshScript(rules: Rules, now: number, due: boolean): Promise<void> {
	const s = rules.script;
	if (!s) {
		scriptKey = "";
		setOpinion(undefined);
		return;
	}
	const key = `${s.path}|${s.timeout_ms ?? ""}`;
	if (!due || (key === scriptKey && now - lastScriptRun < SCRIPT_DEDUPE_MS)) return inflight;
	scriptKey = key;
	lastScriptRun = now;
	inflight = runScript(s.path, scriptInput(now), s.timeout_ms ?? DEFAULT_SCRIPT_TIMEOUT_MS).then(setOpinion, () => setOpinion({ error: "spawn", at: new Date(now).toISOString() }));
	const mine = inflight;
	void mine.finally(() => {
		if (inflight === mine) inflight = undefined;
	});
	return mine;
}

async function refresh(now: number, scriptDue: boolean): Promise<Decision> {
	const rules = readRules();
	if (usageSource && (rules.rules?.length || rules.script)) {
		try {
			setUsage(await usageSource());
		} catch (e) {
			log(`account usage read failed: ${(e as Error).message}`);
		}
	}
	await refreshScript(rules, now, scriptDue);
	stickyAccount(now);
	applyProviderRules(now);
	return lastDecision();
}

// What a rule picks for a provider other than Claude: the account to pin in OmO, or undefined to let OmO choose. Sticky like
// Claude's: once a rule picked an account it stays while usable and no other rule matches; a matching `auto` rule, a pick that got
// blocked or left the pool, and an empty rule list hand the choice back to OmO.
export function providerPick(i: { now: number; pool: Pool; own?: string; usage: Usage; rules: Rule[]; aliases: Record<string, string> }): string | undefined {
	const { pool } = i;
	if (!i.rules.length) return undefined;
	const usable = (n: string | undefined) => n !== undefined && pool.names.includes(n) && !pool.blocked[n];
	const current = usedAccount(i.own, pool.names, n => Boolean(pool.blocked[n]), n => pool.lastSuccess[n] ?? 0);
	const ctx: Ctx = { now: i.now, pool, current, usage: i.usage, resolve: t => resolveAccount(t, pool.names, i.aliases) };
	const hit = i.rules.find(r => matches(r.when, ctx));
	if (hit && "auto" in hit.do) return undefined;
	const d = evaluate({ now: i.now, pool, current, usage: i.usage, rules: { rules: i.rules }, aliases: i.aliases });
	if (d.source === "rule") return d.account;
	return usable(i.own) ? i.own : undefined;
}

// Every other provider's rules reach OmO as its own pin of that pool (OmO re-reads auth.json `pinned` on each request and serves
// the pinned account first; verified 2026-11-16 with a throwaway agent dir, ~/.dotz/logs/model-account-audit-20261116/repro/
// omo-pinned-verify.txt). OmO still moves a request to another account of the pool while the pinned one is blocked: no stop as in
// Claude's 고정. A pin the owner set himself (고정) is never touched: the rules rest until it is cleared.
function applyProviderRules(now: number): void {
	const parts = readRulesFile().providers;
	const own = ownProviderPins();
	for (const id of new Set([...Object.keys(parts), ...Object.keys(own)])) {
		if (id === ANTHROPIC) continue;
		try {
			const pool = readPool(undefined, now, id);
			if (!pool || (pool.pinned && pool.pinned !== own[id])) continue;
			const pick = providerPick({ now, pool: { ...pool, pinned: undefined }, own: own[id], usage: providerUsage(id, pool.names, now), rules: parts[id]?.rules ?? [], aliases: aliasesOf(id) });
			applyProviderPick(id, pick, now);
		} catch (e) {
			log(`account rules (${id}) failed: ${(e as Error).message}`);
		}
	}
}

// Runs the script (deduped to once per 30 s), reads the usage, evaluates and applies; the answer to POST /api/accounts/check.
export const checkNow = (now = Date.now()): Promise<Decision> => refresh(now, true);
// The once-a-minute tick from main.ts: the script only when its every_minutes elapsed.
export function tick(now = Date.now()): Promise<Decision> {
	const every = (readRules().script?.every_minutes ?? DEFAULT_EVERY_MINUTES) * 60_000;
	return refresh(now, now - lastScriptRun >= every);
}
// Before a prompt is handed to the orchestrator or a lane: the same check, not waited for.
export function checkSoon(): void {
	void checkNow().catch(e => log(`account check failed: ${(e as Error).message}`));
}

export function resetRulesForTest(): void {
	usage = {};
	opinion = undefined;
	version = 0;
	lastScriptRun = Number.NEGATIVE_INFINITY;
	scriptKey = "";
	inflight = undefined;
	usageSource = undefined;
	last = undefined;
	loggedKey = undefined;
	brokenNote = "";
}
