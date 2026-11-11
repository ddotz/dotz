// The Codex (ChatGPT subscription) limits and 리셋권 on the usage screen, from the Codex CLI's own login: <CODEX_HOME, default
// ~/.codex>/auth.json (tokens.access_token, tokens.account_id). The same backend the CLI reads: GET .../wham/usage gives the windows
// and rate_limit_reset_credits (how many are held, how many apply now), and GET .../wham/rate-limit-reset-credits each held credit's
// id and expiry (read only when one is held). Read only like hub/usage-account.ts: the token is never refreshed (the CLI does that on
// its next run), and a refused one is reported as "expired".
// The one write is useResetCredit (POST .../rate-limit-reset-credits/consume), reached only from POST /api/quota/reset-credit with
// confirm: true, and only after a fresh read shows a credit held and a window at its limit; one use runs at a time.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./config.ts";
import type { QuotaLimit } from "./usage-account.ts";

const BASE = "https://chatgpt.com/backend-api/wham";
const FRESH_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

type Json = Record<string, any>;
type Login = { token: string; accountId: string };
export type CodexUsage = { provider: "codex"; name: "Codex"; account: string; plan?: string; limits: QuotaLimit[]; resets: { held: number; usable: boolean; expires_at: number | null } };
type Read = { usage?: CodexUsage; problem?: "expired" | "failed" };
class Expired extends Error {}

function login(): Login | undefined {
	try {
		const t = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"), "utf8"))?.tokens;
		return typeof t?.access_token === "string" && typeof t?.account_id === "string" ? { token: t.access_token, accountId: t.account_id } : undefined;
	} catch {
		return undefined;
	}
}
const headers = (l: Login) => ({ authorization: `Bearer ${l.token}`, "chatgpt-account-id": l.accountId, accept: "application/json", "user-agent": "dotz" });
async function get(l: Login, path: string): Promise<Json> {
	const res = await fetch(`${BASE}${path}`, { headers: headers(l), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (res.status === 401 || res.status === 403) throw new Expired(`${path} ${res.status}`);
	if (!res.ok) throw new Error(`${path} ${res.status}`);
	return (await res.json()) as Json;
}

// limit_window_seconds names the window: 18000 is "5시간 한도", 604800 "7일 한도" (a free plan has one 30-day window).
const windowOf = (secs: number): { id: string; label: string } =>
	secs >= 86_400 && secs % 86_400 === 0 ? { id: `${secs / 86_400}d`, label: `${secs / 86_400}일 한도` } : { id: `${Math.round(secs / 3600)}h`, label: `${Math.round(secs / 3600)}시간 한도` };
const msOf = (v: unknown): number | null => (typeof v === "number" ? v * 1000 : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

export function codexLimits(rate: Json | undefined): QuotaLimit[] {
	return [rate?.primary_window, rate?.secondary_window].filter((w): w is Json => !!w && typeof w.used_percent === "number").map(w => {
		const used = Math.max(0, Math.min(100, w.used_percent));
		const { id, label } = windowOf(Number(w.limit_window_seconds) || 0);
		return { id: `codex:${id}`, label, window: id, used, limit: 100, remaining: 100 - used, unit: "percent", resets_at: msOf(w.reset_at), status: used >= 100 ? "exhausted" : "ok" };
	});
}

// How many 리셋권 are held, the nearest expiry, and whether one may be used now: a credit applies (applicable_available_count) and a
// window is at its limit. creditId is the available credit that expires first, the one a use spends.
export function codexResets(usage: Json, list: Json | undefined): { resets: CodexUsage["resets"]; creditId?: string } {
	const c = usage.rate_limit_reset_credits ?? {};
	const held = Math.max(0, Number(c.available_count) || 0);
	const applies = typeof c.applicable_available_count === "number" ? c.applicable_available_count : held;
	const rate = usage.rate_limit ?? {};
	const limited = rate.limit_reached === true || rate.allowed === false || codexLimits(rate).some(l => l.status === "exhausted");
	const credits = (Array.isArray(list?.credits) ? (list.credits as Json[]) : [])
		.filter(x => x?.status === "available" && typeof x.id === "string")
		.map(x => ({ id: String(x.id), expires: msOf(x.expires_at) }))
		.sort((a, b) => (a.expires ?? Number.MAX_SAFE_INTEGER) - (b.expires ?? Number.MAX_SAFE_INTEGER));
	return { resets: { held, usable: held > 0 && applies > 0 && limited, expires_at: credits[0]?.expires ?? null }, ...(credits[0] ? { creditId: credits[0].id } : {}) };
}

async function read(l: Login): Promise<{ usage: CodexUsage; held: number; creditId?: string }> {
	const body = await get(l, "/usage");
	const held = Number(body.rate_limit_reset_credits?.available_count) || 0;
	// Without the list the count still shows; only the expiry and the credit to spend are unknown.
	const list = held > 0 ? await get(l, "/rate-limit-reset-credits").catch(e => void log(`codex: reset credit list failed: ${(e as Error).message}`)) : undefined;
	const { resets, creditId } = codexResets(body, list ?? undefined);
	const plan = typeof body.plan_type === "string" && body.plan_type ? body.plan_type[0]!.toUpperCase() + body.plan_type.slice(1) : undefined;
	const account = typeof body.email === "string" && body.email ? body.email : l.accountId;
	return { usage: { provider: "codex", name: "Codex", account, ...(plan ? { plan } : {}), limits: codexLimits(body.rate_limit), resets }, held, ...(creditId ? { creditId } : {}) };
}

// The usage screen's read, at most every FRESH_MS. Undefined: this machine has no Codex login.
let last: { at: number; read: Promise<Read> } | undefined;
export function codexUsage(now = Date.now()): Promise<Read> | undefined {
	const l = login();
	if (!l) return undefined;
	if (!last || now - last.at >= FRESH_MS)
		last = { at: now, read: read(l).then(r => ({ usage: r.usage }), (e: Error): Read => (e instanceof Expired ? { problem: "expired" } : (log(`codex: usage read failed: ${e.message}`), { problem: "failed" }))) };
	return last.read;
}
export const resetCodexForTest = (): void => void (last = undefined);

// The quota with the Codex card added (GET /api/quota, hub/providers.ts readQuota), or with Codex listed among the ones that cannot be read.
type Built = { providers: { provider: string; account?: string; plan?: string; limits: QuotaLimit[] }[]; unavailable: { provider: string; reason: string }[] };
export function withCodex<B extends Built>(b: B, codex: Read | undefined) {
	const why = codex?.problem === "expired" ? "로그인이 풀려서 사용량을 읽지 못해요. 이 컴퓨터에서 codex를 한 번 실행해 주세요" : "사용량을 읽지 못했어요. 조금 뒤 다시 읽어요";
	return { providers: [...b.providers, ...(codex?.usage ? [codex.usage] : [])], unavailable: [...b.unavailable, ...(codex?.problem ? [{ provider: "codex", name: "Codex", reason: why }] : [])] };
}

// POST /api/quota/reset-credit {account, confirm: true}. Never spends on a stale page: the account must be the one logged in now, and
// a fresh read must show a credit held and a window at its limit.
let using = false;
export async function useResetCredit(b: Json): Promise<{ status: number; body: Json }> {
	if (b.confirm !== true) return { status: 400, body: { error: "리셋권은 확인을 거친 뒤에만 써요" } };
	if (using) return { status: 409, body: { error: "리셋권을 쓰는 중이에요" } };
	using = true;
	try {
		const l = login();
		if (!l) return { status: 404, body: { error: "이 컴퓨터에 Codex 로그인이 없어요" } };
		const now = await read(l);
		last = undefined;
		if (b.account !== now.usage.account) return { status: 409, body: { error: "Codex 계정이 바뀌었어요. 사용량을 새로 고친 뒤 다시 해 주세요" } };
		if (now.held < 1) return { status: 409, body: { error: "남은 리셋권이 없어요" } };
		if (!now.usage.resets.usable) return { status: 409, body: { error: "한도에 걸린 곳이 없어서 쓰지 않았어요" } };
		const res = await fetch(`${BASE}/rate-limit-reset-credits/consume`, {
			method: "POST",
			headers: { ...headers(l), "content-type": "application/json" },
			body: JSON.stringify({ redeem_request_id: randomUUID(), ...(now.creditId ? { credit_id: now.creditId } : {}) }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) return { status: 502, body: { error: `리셋권을 쓰지 못했어요 (${res.status})` } };
		const out = (await res.json()) as Json;
		const outcome = String(out.code ?? out.outcome ?? "").replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
		log(`codex: reset credit used for ${now.usage.account}: ${outcome}`);
		return { status: 200, body: { ok: true, outcome, left: outcome === "reset" ? now.held - 1 : now.held } };
	} catch (e) {
		if (!(e instanceof Expired)) log(`codex: reset credit use failed: ${(e as Error).message}`);
		return { status: 502, body: { error: e instanceof Expired ? "Codex 로그인이 풀렸어요. 이 컴퓨터에서 codex를 한 번 실행해 주세요" : "리셋권을 쓰지 못했어요" } };
	} finally {
		using = false;
	}
}
