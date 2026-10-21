// What the owner sees and does about the Claude subscription accounts, from the HTTP API (GET /api/accounts, PUT
// /api/accounts/alias, PUT /api/accounts/rules, POST /api/accounts/use), the /account command (hub/control.ts) and short chat
// requests the gateway answers itself ("계정 바꿔줘", main.ts). Every account is shown by its alias (hub/account-alias.ts label);
// the raw id appears only in API fields named `name`/`key` and on "-# " detail lines.
import { aliasesFile, label, readAliases, resolveAccount, setAlias } from "./account-alias.ts";
import { blockedKind, checkNow, DEFAULT_EVERY_MINUTES, DEFAULT_SCRIPT_TIMEOUT_MS, decisionsFile, describeRule, type Decision, getScriptOpinion, getUsage, josa, lastDecision, type Manual, readRules, rulesFile, type ScriptErrorKind, setManual, validateRules, writeRules } from "./account-rules.ts";
import { type AccountSwitch, accountView, MAX_LOG_LINES, readPool, stickyAccount, type SwitchKind } from "./account-sticky.ts";
import { TZ } from "./config.ts";
import { type AccountReport, limitsText } from "./usage-account.ts";

export class AccountsError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

const SOURCE_TEXT: Record<Decision["source"], string> = { manual: "직접 고름", script: "스크립트", rule: "규칙", auto: "자동" };
export const KIND_TEXT: Record<SwitchKind, string> = { start: "처음 선택", limit: "한도", owner: "직접 변경", gone: "계정 사라짐", rule: "규칙", script: "스크립트", manual: "직접 고름" };
const SCRIPT_ERROR_TEXT: Record<ScriptErrorKind, string> = { timeout: "시간이 초과됐어요", exit: "오류로 끝났어요", spawn: "실행하지 못했어요", unknown_account: "모르는 계정을 골랐어요" };

const clock = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
const dayKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
// "18:00" today, "10월 22일 18:00" otherwise.
function clockText(ms: number, now: number): string {
	if (dayKey(ms) === dayKey(now)) return clock(ms);
	const d = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric" }).format(new Date(ms));
	return `${d} ${clock(ms)}`;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pct = (n: number) => `${Math.round(n)}%`;

// Raw account ids inside a free-text reason become their aliases.
function relabel(text: string, names: string[], aliases: Record<string, string>): string {
	let out = text;
	for (const n of [...names].sort((a, b) => b.length - a.length)) {
		const l = label(n, undefined, aliases);
		if (l !== n) out = out.replace(new RegExp(`(?<![\\w@.-])${escape(n)}(?![\\w@.-])`, "g"), l);
	}
	return out;
}

// A switch's cause in a few Korean words, without raw ids.
function switchWhy(s: AccountSwitch): string {
	switch (s.kind) {
		case "start":
			return "처음 선택";
		case "limit":
			return "한도";
		case "owner":
			return "OmO에서 직접 고정";
		case "gone":
			return "계정이 사라짐";
		case "rule":
			return s.rule ? `규칙 "${s.rule}"` : s.reason;
		default:
			return s.reason;
	}
}

// One Korean line: "개인 계정 → 회사 계정 (규칙 "근무 시간")".
export function switchText(s: AccountSwitch, aliases = readAliases()): string {
	const to = label(s.to, undefined, aliases);
	return `${s.from ? `${label(s.from, undefined, aliases)} → ` : ""}${to} (${switchWhy(s)})`;
}

// The worklog sentence for a switch other than the first pick.
export function switchNotice(s: AccountSwitch, aliases = readAliases()): string {
	const to = label(s.to, undefined, aliases);
	const head = s.from ? `계정을 ${label(s.from, undefined, aliases)}에서 ${to}${josa(to, "으로", "로")} 바꿨어요.` : `계정을 ${to}${josa(to, "으로", "로")} 정했어요.`;
	const because: Record<SwitchKind, string> = {
		start: "처음 골랐기 때문이에요.",
		limit: "이전 계정이 한도에 걸렸기 때문이에요.",
		owner: "OmO에서 직접 고정했기 때문이에요.",
		gone: "이전 계정이 사라졌기 때문이에요.",
		rule: `${s.rule ? `규칙 "${s.rule}"` : s.reason} 때문이에요.`,
		script: "스크립트가 골랐기 때문이에요.",
		manual: "직접 골랐기 때문이에요.",
	};
	return `${head} ${because[s.kind]}`;
}

export type LabeledSwitch = AccountSwitch & { from_label?: string; to_label: string; kind_text: string };
export const labeledSwitch = (s: AccountSwitch, aliases = readAliases()): LabeledSwitch => ({
	...s,
	...(s.from ? { from_label: label(s.from, undefined, aliases) } : {}),
	to_label: label(s.to, undefined, aliases),
	kind_text: KIND_TEXT[s.kind],
});

// accountView() (the usage screen's account block) plus the owner's names.
export function labeledAccountView(limit = MAX_LOG_LINES) {
	const v = accountView(limit);
	const aliases = readAliases();
	return { ...v, ...(v.account ? { account_label: label(v.account, undefined, aliases) } : {}), switches: v.switches.map(s => labeledSwitch(s, aliases)) };
}

const manualText = (m: Manual | undefined, now: number, names: string[], aliases: Record<string, string>): string | null => {
	if (!m || (m.until && Date.parse(m.until) <= now)) return null;
	const id = resolveAccount(m.account, names, aliases);
	const l = id ? label(id, undefined, aliases) : m.account;
	return `${l}${josa(l, "으로", "로")} 직접 고정${m.until ? ` · ${clockText(Date.parse(m.until), now)}까지` : ""}`;
};

export function accountsBody(now = Date.now()) {
	const current = stickyAccount(now);
	const pool = readPool(undefined, now);
	const names = pool?.names ?? [];
	const aliases = readAliases();
	const usage = getUsage();
	const rules = readRules();
	const lab = (n: string) => label(n, undefined, aliases);
	// a rule names its account by id or alias
	const labAny = (t: string) => {
		const id = resolveAccount(t, names, aliases);
		return id ? lab(id) : t;
	};
	const d = lastDecision();
	const opinion = getScriptOpinion();
	return {
		accounts: names.map(name => {
			const b = pool?.blocked[name];
			return {
				name,
				alias: aliases[name] ?? null,
				label: lab(name),
				current: name === current,
				blocked: b ? blockedKind(b.reason) : null,
				blocked_until: b?.until ? new Date(b.until).toISOString() : null,
				five_hour_left: usage[name]?.five_hour_left ?? null,
				seven_day_left: usage[name]?.seven_day_left ?? null,
			};
		}),
		decision: {
			...(d.account ? { account: d.account, label: lab(d.account) } : {}),
			source: d.source,
			source_text: SOURCE_TEXT[d.source],
			...(d.rule ? { rule: d.rule } : {}),
			reason: relabel(d.reason, names, aliases),
			at: d.at,
		},
		rules,
		rules_text: (rules.rules ?? []).map((r, index) => ({ index, text: describeRule(r, labAny) })),
		manual_text: manualText(rules.manual, now, names, aliases),
		script: {
			path: rules.script?.path ?? null,
			timeout_ms: rules.script?.timeout_ms ?? DEFAULT_SCRIPT_TIMEOUT_MS,
			every_minutes: rules.script?.every_minutes ?? DEFAULT_EVERY_MINUTES,
			last: opinion
				? {
						...(opinion.account ? { account: opinion.account, label: lab(opinion.account) } : {}),
						...(opinion.error ? { error: opinion.error, error_text: SCRIPT_ERROR_TEXT[opinion.error] } : {}),
						...(opinion.reason ? { reason: opinion.reason } : {}),
						at: opinion.at,
					}
				: null,
		},
		files: { rules: rulesFile(), aliases: aliasesFile(), decisions: decisionsFile() },
		switches: accountView(MAX_LOG_LINES).switches.map(s => labeledSwitch(s, aliases)),
	};
}
export type AccountsBody = ReturnType<typeof accountsBody>;

// ---- changes ----

// A manual pick by id or alias; "auto" (or "자동") clears it. Re-evaluates right away.
export async function useAccount(text: string, until?: string): Promise<{ auto: true } | { auto?: false; id: string; label: string; applied: boolean }> {
	const t = text.trim();
	if (!t) throw new AccountsError("어느 계정인지 알려 주세요", 400);
	if (/^(auto|자동)$/i.test(t)) {
		setManual(undefined);
		await checkNow();
		return { auto: true };
	}
	const id = resolveAccount(t, readPool()?.names ?? []);
	if (!id) throw new AccountsError(`그런 계정이 없어요: ${t}`, 400);
	if (until !== undefined && (typeof until !== "string" || Number.isNaN(Date.parse(until)))) throw new AccountsError("until은 ISO 시각이어야 해요 (예: 2026-10-21T18:00:00+09:00)", 400);
	setManual(id, undefined, until || undefined);
	const d = await checkNow();
	return { id, label: label(id), applied: d.account === id };
}

function putRules(raw: unknown): void {
	try {
		validateRules(raw);
	} catch (e) {
		throw new AccountsError((e as Error).message, 400);
	}
	writeRules(raw);
}

const readBody = async (req: Request): Promise<Record<string, any>> => {
	try {
		const b = await req.json();
		return b && typeof b === "object" ? (b as Record<string, any>) : {};
	} catch {
		return {};
	}
};

// The /api/accounts routes (the caller has already checked the token). Undefined: not one of them.
export async function accountsRoute(req: Request, url: URL): Promise<Response | undefined> {
	const p = url.pathname;
	if (p !== "/api/accounts" && !["/api/accounts/alias", "/api/accounts/rules", "/api/accounts/use"].includes(p)) return undefined;
	try {
		if (req.method === "GET" && p === "/api/accounts") return Response.json(accountsBody());
		if (req.method === "PUT" && p === "/api/accounts/alias") {
			const b = await readBody(req);
			if (typeof b.key !== "string" || !b.key.trim()) throw new AccountsError("key(계정 id 또는 이메일)가 필요해요", 400);
			if (b.alias !== undefined && b.alias !== null && typeof b.alias !== "string") throw new AccountsError("alias는 글자여야 해요", 400);
			setAlias(b.key.trim(), b.alias ?? "");
			return Response.json(accountsBody());
		}
		if (req.method === "PUT" && p === "/api/accounts/rules") {
			putRules((await readBody(req)).rules);
			return Response.json(accountsBody());
		}
		if (req.method === "POST" && p === "/api/accounts/use") {
			const b = await readBody(req);
			await useAccount(String(b.account ?? ""), b.until === undefined || b.until === null ? undefined : String(b.until));
			return Response.json(accountsBody());
		}
		return undefined;
	} catch (e) {
		if (e instanceof AccountsError) return Response.json({ error: e.message }, { status: e.status });
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

// ---- chat text ----

function stateText(a: AccountsBody["accounts"][number], now: number): string {
	if (!a.blocked) return "쓸 수 있어요";
	const until = a.blocked_until ? ` (${clockText(Date.parse(a.blocked_until), now)}까지)` : "";
	if (a.blocked === "rate_limit") return `한도에 걸렸어요${until}`;
	if (a.blocked === "auth_error") return `다시 로그인해야 해요${until}`;
	return `막혀 있어요: ${a.blocked}${until}`;
}
const leftText = (a: AccountsBody["accounts"][number]): string => {
	const parts = [a.five_hour_left !== null ? `5시간 ${pct(a.five_hour_left)}` : "", a.seven_day_left !== null ? `주간 ${pct(a.seven_day_left)}` : ""].filter(Boolean);
	return parts.length ? `${parts.join(" · ")} 남음` : "남은 한도는 아직 몰라요";
};
// Why the current account, with no raw ids: only the owner-driven layers have a reason worth quoting.
const whyText = (d: AccountsBody["decision"]): string => (d.source === "auto" ? "자동으로 골랐어요 (직접 고정·스크립트·규칙에 걸리는 게 없어요)" : d.reason.startsWith(d.source_text) ? d.reason : `${d.source_text} · ${d.reason}`);

// "/account": the whole picture in Korean, labels first.
export function accountText(now = Date.now()): string {
	const b = accountsBody(now);
	if (!b.accounts.length) return "OmO에 Claude 구독 계정이 없어요.";
	const cur = b.accounts.find(a => a.current);
	const lines = [`지금 계정: ${cur ? cur.label : "아직 안 골랐어요"}`, `이유: ${whyText(b.decision)}`];
	if (b.manual_text) lines.push(`직접 고정: ${b.manual_text} (자동으로 돌리려면 /account auto)`);
	lines.push("계정:", ...b.accounts.map(a => `- ${a.label}${a.current ? " (지금)" : ""} · ${stateText(a, now)} · ${leftText(a)}`));
	lines.push(b.rules_text.length ? "규칙:" : "규칙: 없음", ...b.rules_text.map(r => `${r.index + 1}. ${r.text}`));
	lines.push(b.script.path ? `스크립트: ${b.script.path}${b.script.last?.error_text ? ` (마지막: ${b.script.last.error_text})` : ""}` : "스크립트: 없음");
	const differ = b.accounts.filter(a => a.label !== a.name);
	if (differ.length) lines.push(`-# 계정 id: ${b.accounts.map(a => (a.label !== a.name ? `${a.label} = ${a.name}` : a.name)).join(", ")}`);
	return lines.join("\n");
}

const pickedText = (r: Awaited<ReturnType<typeof useAccount>>): string => {
	if (r.auto) return "자동으로 돌렸어요. 이제 규칙과 한도에 따라 계정을 골라요.";
	const josaTo = josa(r.label, "으로", "로");
	if (r.applied) return `${r.label}${josaTo} 바꿨어요. 자동으로 돌리려면 "계정 자동으로"라고 해 주세요.`;
	const cur = accountsBody().accounts.find(a => a.current);
	return `${r.label}${josaTo} 고정해 뒀지만 지금은 쓸 수 없어서(한도 등) ${cur ? cur.label : "다른 계정"}을 쓰고 있어요.`;
};

// "/account", "/account auto", "/account alias <id> <별칭>", "/account <id|alias>".
export async function accountCommand(rest: string): Promise<string> {
	const t = rest.trim();
	if (!t) return accountText();
	const alias = t.match(/^(?:alias|별칭)\s+(\S+)(?:\s+([\s\S]+))?$/i);
	if (alias) {
		const names = readPool()?.names ?? [];
		const id = resolveAccount(alias[1], names) ?? (alias[1].includes("@") ? alias[1] : undefined);
		if (!id) throw new AccountsError(`그런 계정이 없어요: ${alias[1]}`, 400);
		const name = alias[2]?.trim() ?? "";
		setAlias(id, name);
		return name ? `별칭을 정했어요: ${id} → ${name}` : `별칭을 지웠어요: ${id}`;
	}
	return pickedText(await useAccount(t));
}

// ---- chat requests answered by the gateway itself ----

export type AccountAsk = { kind: "show" } | { kind: "auto" } | { kind: "use"; account: string } | { kind: "other" };

const TAIL = /\s*(?:해\s*줘|해\s*주세요|해\s*줄래요?|해\s*봐|해요|해라|해|줘|주세요|줄래요?|봐|부탁(?:해요|해|드려요)?|할래요?|하자)$/;
const VERB = "(?:바꿔|바꾸자?|바꿀래|전환|변경|갈아타|옮겨|돌려|써|쓰자|쓸래|사용|고정|선택|골라)";
const SHOW = [/^(?:(?:지금|현재)\s*)?(?:무슨|어떤|뭔|어느)\s*계정(?:이야|이에요|이지|이니|인가요|인지|써|쓰고\s*있어요?|쓰고\s*있니)?$/, /^(?:지금|현재)\s*계정(?:\s*(?:뭐야|뭐에요|뭐예요|뭐지|알려|보여|확인|상태))?$/, /^계정\s*(?:확인|상태|알려|보여)$/];
const AUTO = /^(?:자동\s*계정(?:으로)?|계정(?:을|은)?\s*자동(?:으로)?|계정\s*자동\s*(?:전환|선택)?)(?:\s*(?:바꿔|전환|돌려|돌려놔|설정|맞춰|선택))?$/;
const OTHER = [new RegExp(`^(?:(?:지금|현재)\\s*)?계정(?:을)?\\s*${VERB}$`), new RegExp(`^(?:다른|딴|반대|다음)\\s*계정(?:으로|로)?(?:\\s*${VERB})?$`)];

// Pure: a short owner message that asks about or changes the account, else undefined (the message goes to the orchestrator).
// A target counts only when it is a known account id or alias, so "깃허브 계정으로 로그인하는 법 알려줘" is not a request.
export function accountAsk(text: string, names: string[], aliases: Record<string, string> = {}): AccountAsk | undefined {
	const raw = text.trim();
	if (!raw || raw.length > 40 || /[\n\r]/.test(raw)) return undefined;
	const t = raw.replace(/[?？!！.。~…,]+$/g, "").replace(/\s+/g, " ").trim().replace(TAIL, "").trim();
	if (!t) return undefined;
	if (SHOW.some(r => r.test(t))) return { kind: "show" };
	if (AUTO.test(t)) return { kind: "auto" };
	const cands = names.flatMap(n => [{ id: n, text: n }, ...(aliases[n] ? [{ id: n, text: aliases[n] }] : [])]).sort((a, b) => b.text.length - a.text.length);
	for (const c of cands) {
		const cand = c.text.trim().split(/\s+/).map(escape).join("\\s*");
		if (new RegExp(`^(?:(?:지금|이제)\\s*)?(?:계정(?:을|은)?\\s+)?${cand}(?:\\s*계정)?(?:(?:으로|로)(?:\\s*${VERB})?|\\s+${VERB})$`, "i").test(t)) return { kind: "use", account: c.id };
	}
	if (OTHER.some(r => r.test(t))) return { kind: "other" };
	return undefined;
}

// The gateway's answer to an AccountAsk (may change the manual pick).
export async function accountAnswer(ask: AccountAsk): Promise<string> {
	if (ask.kind === "auto") return pickedText(await useAccount("auto"));
	if (ask.kind === "use") return pickedText(await useAccount(ask.account));
	const b = accountsBody();
	if (!b.accounts.length) return "OmO에 Claude 구독 계정이 없어요.";
	const cur = b.accounts.find(a => a.current);
	if (ask.kind === "show") return `지금은 ${cur ? `${cur.label}${josa(cur.label, "을", "를")} 쓰고 있어요` : "계정을 아직 안 골랐어요"}. ${whyText(b.decision)}`;
	const others = b.accounts.filter(a => !a.current);
	const usable = others.filter(a => !a.blocked);
	if (usable.length === 1) return pickedText(await useAccount(usable[0].name));
	if (!others.length) return `쓸 수 있는 계정이 ${cur ? cur.label : "하나"}뿐이라 바꿀 수 없어요.`;
	return `어느 계정으로 바꿀까요? ${others.map(a => `${a.label}${a.blocked ? "(지금은 막힘)" : ""}`).join(", ")} 중에서 골라 주세요. 예: "${others[0].label}${josa(others[0].label, "으로", "로")}"`;
}
