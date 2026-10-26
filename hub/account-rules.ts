// Which Claude subscription account dotz runs on, decided by the owner's rules (owner 2026-10-21: switch by time windows,
// usage conditions, an own script, or a manual pick). <DATA_DIR>/accounts/rules.json:
//   { "manual": { "account", "until"?, "reason"? },
//     "rules":  [ { "name"?, "when"?: { days, from, to, five_hour_left_below, seven_day_left_below, rate_limited, auth_error, unavailable },
//                   "do": { "pin": X } | { "prefer": [X, Y] } | { "auto": true } } ],
//     "script": { "path", "timeout_ms"?, "every_minutes"? },
//     "order": [X, Y, Z] }   the owner's account order: the fallback order of 자동 전환 (usableFirst in account-sticky.ts)
// Precedence: manual (not expired) > the script's opinion > the first matching rule > automatic (decide() in account-sticky.ts).
// The manual pick is the owner's 고정 mode: it holds while blocked (no other account takes over; the work pauses). A layer's
// account that is blocked (OmO's rate_limit/auth block, not expired) or not in OmO's pool is skipped: script and pin fall
// through to the next layer, prefer takes the next listed usable one (and skips one whose known usage is under the rule's
// threshold). Candidates are only OmO's anthropic-subscription accounts (readPool); an API-key slot is never one. Times are the
// gateway's TZ (Asia/Seoul); from > to wraps midnight and the window belongs to the day it started on. `when` conditions are
// ANDed; usage/rate_limited/auth_error describe the account dotz runs on now, and unknown usage means "not met".
//
// evaluate() is pure and synchronous (no model call, no I/O): the usage numbers are the cached oauth/usage reports
// (setUsage, fed by the usage source main.ts registers) and the script's last opinion is cached too. checkNow() refreshes both,
// then lets account-sticky.ts apply the decision. After a rule window ends dotz stays on its account (sticky, as always) until
// another rule or a limit moves it.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountsDir, aliasesFile, aliasOf, readAliases, resolveAccount } from "./account-alias.ts";
import { type AccountSwitch, currentAccount, decide, MAX_LOG_LINES, type Pool, readPool, stickyAccount } from "./account-sticky.ts";
import { log, TZ, writeAtomic } from "./config.ts";

export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type When = { days?: Day[]; from?: string; to?: string; five_hour_left_below?: number; seven_day_left_below?: number; rate_limited?: true; auth_error?: true; unavailable?: string };
export type Action = { pin: string } | { prefer: string[] } | { auto: true };
type Rule = { name?: string; when?: When; do: Action };
export type Manual = { account: string; until?: string; reason?: string };
type ScriptConfig = { path: string; timeout_ms?: number; every_minutes?: number };
export type Rules = { manual?: Manual; rules?: Rule[]; script?: ScriptConfig; order?: string[] };
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
function bad(where: string, why: string): never {
	throw new Error(`${where}: ${why}`);
}
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
	if (o.five_hour_left_below !== undefined) out.five_hour_left_below = percent(`${where}.five_hour_left_below`, o.five_hour_left_below);
	if (o.seven_day_left_below !== undefined) out.seven_day_left_below = percent(`${where}.seven_day_left_below`, o.seven_day_left_below);
	for (const k of ["rate_limited", "auth_error"] as const) {
		if (o[k] === undefined) continue;
		if (o[k] !== true) bad(`${where}.${k}`, "true만 쓸 수 있어요");
		out[k] = true;
	}
	if (o.unavailable !== undefined) out.unavailable = nonEmpty(`${where}.unavailable`, o.unavailable);
	return out;
}

function validateRule(i: number, r: unknown): Rule {
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

// Throws a readable Korean error naming the bad field.
export function validateRules(raw: unknown): Rules {
	if (!isObj(raw)) bad("규칙 파일", "JSON 객체여야 해요");
	const r = raw as Record<string, any>;
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
	return out;
}

// The file as written; a missing or broken file is "no rules" (dotz keeps running automatically), the break is logged once.
let brokenNote = "";
export function readRules(file = rulesFile()): Rules {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	try {
		brokenNote = "";
		return validateRules(JSON.parse(text));
	} catch (e) {
		const note = (e as Error).message;
		if (note !== brokenNote) log(`account rules ignored (${file}): ${note}`);
		brokenNote = note;
		return {};
	}
}

export function writeRules(r: unknown, file = rulesFile()): Rules {
	const clean = validateRules(r);
	mkdirSync(accountsDir(), { recursive: true });
	writeAtomic(file, `${JSON.stringify(clean, null, 2)}\n`);
	return clean;
}

// The owner's account order saved; other parts of the file stay as they are.
export function setOrder(order: string[]): Rules {
	return writeRules({ ...readRules(), order });
}

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

function matches(w: When | undefined, c: Ctx): boolean {
	if (!w) return true;
	if ((w.days || w.from !== undefined || w.to !== undefined) && !inTimeWindow(w, c.now)) return false;
	const u = c.current ? c.usage[c.current] : undefined;
	if (w.five_hour_left_below !== undefined && !(u?.five_hour_left !== undefined && u.five_hour_left < w.five_hour_left_below)) return false;
	if (w.seven_day_left_below !== undefined && !(u?.seven_day_left !== undefined && u.seven_day_left < w.seven_day_left_below)) return false;
	const block = c.current ? c.pool.blocked[c.current] : undefined;
	if (w.rate_limited && !(block && blockedKind(block.reason) === "rate_limit")) return false;
	if (w.auth_error && !(block && blockedKind(block.reason) === "auth_error")) return false;
	if (w.unavailable !== undefined) {
		const x = c.resolve(w.unavailable);
		if (x && !c.pool.blocked[x]) return false;
	}
	return true;
}

const underThreshold = (a: string, w: When | undefined, usage: Usage): boolean => {
	const u = usage[a];
	return Boolean((w?.five_hour_left_below !== undefined && u?.five_hour_left !== undefined && u.five_hour_left < w.five_hour_left_below) || (w?.seven_day_left_below !== undefined && u?.seven_day_left !== undefined && u.seven_day_left < w.seven_day_left_below));
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
	const conds: string[] = [];
	if (w.five_hour_left_below !== undefined) conds.push(`5시간 한도가 ${w.five_hour_left_below}% 밑`);
	if (w.seven_day_left_below !== undefined) conds.push(`주간 한도가 ${w.seven_day_left_below}% 밑`);
	if (w.rate_limited) conds.push("한도에 걸린");
	if (w.auth_error) conds.push("로그인이 풀린");
	if (w.unavailable !== undefined) conds.push(`${label(w.unavailable)}${josa(label(w.unavailable), "을", "를")} 못 쓰는`);
	const head = conds.length ? `${when ? `${when}에 ` : ""}${conds.join(" ")}${conds.at(-1)!.endsWith("밑") ? "이면" : "상태면"}` : when ? `${when}에는` : "항상";
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
	return lastDecision();
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
