// 계정 groups for every provider OmO keeps an account pool for, not just the Claude subscription (owner 2026-10-26: "이거 왜
// 클로드만 추가냐. 범용 추가로 구현해야지"). Read-only over OmO's own store: <agent dir>/auth.json holds one entry per provider,
// and a provider whose sign-in can hold several logins keeps them in `accounts` ([{name, access, ...}]) with `pinned` naming the
// one OmO prefers. `credential-pool-state.json` records each account's block per provider
// (`providers.<id>.lanes.stored.slots.<name>`), and `subscription-usage.json` the usage windows per
// `<provider>/<account>`. Verified 2026-10-26 with a throwaway agent dir: `omo auth check --provider chatgpt-subscription --json`
// lists two accounts of a hand-made pool and `--provider google` one account of an API key, i.e. the pool is not Anthropic-only.
// dotz's own switching (rules, order, the Claude pin env) stays Claude-only; here a group only shows its accounts and lets the
// owner pin one in OmO, which OmO honours for its own account selection.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { log } from "./config.ts";

const SUBSCRIPTION = "anthropic-subscription";
// OmO's `anthropic-subscription` is the Claude login, which dotz (like omp) calls `anthropic`; its own `anthropic` entry is the
// API-key provider and stays out of the way while a subscription login exists (providers.ts omoSelector maps back).
const dotzProvider = (id: string): string => (id === SUBSCRIPTION ? "anthropic" : id);

// Product names the owner reads, keyed by dotz provider id. Anything else falls back to OmO's catalog name, then the raw id.
const NAMES: Record<string, string> = {
	anthropic: "Claude 구독", "chatgpt-subscription": "ChatGPT 구독", google: "Gemini", openai: "OpenAI", openrouter: "OpenRouter",
	"github-copilot": "GitHub Copilot", cursor: "Cursor", "cursor-cli-oauth": "Cursor CLI", xai: "xAI", "kimi-coding": "Kimi",
	devin: "Devin", meta: "Meta", radius: "Radius", opengateway: "OpenGateway",
};
export const providerLabel = (id: string, catalog: { id: string; name: string }[] = []): string =>
	NAMES[id] ?? catalog.find(p => p.id === id)?.name ?? id;

type Json = Record<string, any>;
const readJson = (file: string): Json | undefined => {
	try {
		const j = JSON.parse(readFileSync(file, "utf8"));
		return j && typeof j === "object" ? j : undefined;
	} catch {
		return undefined;
	}
};

export type GenericWindow = { id: string; label: string; left: number; resets_at: number | null };
export type GenericAccount = { name: string; label: string; order: number; current: boolean; pinned: boolean; blocked: string | null; blocked_until: string | null; blocked_tag: string | null; windows: GenericWindow[] };
export type ProviderGroup = { id: string; name: string; auth: "oauth" | "api_key"; multi: boolean; can_add: boolean; can_pin: boolean; can_delete: boolean; accounts: GenericAccount[] };
export type LoginProviderRow = { id: string; name: string; configured: boolean };
type Item = { name: string; access?: string; source?: string; blockedUntil?: number; blockReason?: string };

const windowText = (minutes: number): string => (minutes >= 1440 ? `${Math.round(minutes / 1440)}일` : minutes >= 60 ? `${Math.round(minutes / 60)}시간` : `${minutes}분`);
// One provider's usage windows from subscription-usage.json (`<provider>/<account>` key), newest read only.
function windowsOf(usage: Json | undefined, omoId: string, account: string): GenericWindow[] {
	const w = usage?.accounts?.[`${omoId}/${account}`]?.windows;
	if (!Array.isArray(w)) return [];
	return w.flatMap((x: Json): GenericWindow[] => {
		const used = typeof x?.usedPercent === "number" && Number.isFinite(x.usedPercent) ? x.usedPercent : undefined;
		const minutes = typeof x?.windowMinutes === "number" ? x.windowMinutes : 0;
		if (used === undefined) return [];
		return [{ id: String(x.id ?? x.label ?? ""), label: windowText(minutes), left: Math.round((100 - Math.min(100, Math.max(0, used))) * 10) / 10, resets_at: typeof x.resetsAt === "number" ? x.resetsAt : null }];
	});
}

// Pure: the account groups OmO's store describes, Claude's subscription excluded (accounts-api.ts composes that group from the
// account pool it already reads). `catalog` is the login providers this install offers; an entry there can gain accounts.
export function providerGroups(input: { auth: Json | undefined; pool?: Json; usage?: Json; aliases?: Record<string, string>; catalog: { id: string; name: string }[]; now: number }): { providers: ProviderGroup[]; login_providers: LoginProviderRow[] } {
	const auth = input.auth ?? {};
	const catalog = input.catalog;
	const ids = new Set(catalog.map(p => p.id));
	const configured = new Set(Object.keys(auth).filter(id => !(id === "anthropic" && SUBSCRIPTION in auth)).map(dotzProvider));
	const providers: ProviderGroup[] = [];
	for (const [omoId, raw] of Object.entries(auth)) {
		if (!raw || typeof raw !== "object") continue;
		if (omoId === SUBSCRIPTION) continue; // the Claude group is accounts-api.ts's own pool
		if (omoId === "anthropic" && SUBSCRIPTION in auth) continue; // shadowed by the subscription login
		const c = raw as Json;
		const id = dotzProvider(omoId);
		const accounts: Json[] = Array.isArray(c.accounts) ? c.accounts.filter((a: Json) => a && typeof a === "object") : [];
		// older stores keep one login on the entry itself (`access`), which `omo auth check` reports as an account named default
		const items: Item[] = accounts.length
			? accounts.map(a => a as Item)
			: typeof c.access === "string" && c.access
				? [{ name: "default", access: c.access }]
				: typeof c.key === "string" && c.key
					? [{ name: "default" }]
					: [];
		const oauth = c.type !== "api_key" && (c.type === "oauth" || items.length > 0);
		const slots = input.pool?.providers?.[omoId]?.lanes?.stored?.slots ?? {};
		const pinnedName = typeof c.pinned === "string" ? c.pinned : undefined;
		const state = (it: Item) => {
			const slot = slots[it.name];
			const untils = [slot?.blockedUntil, it.blockedUntil].filter((n): n is number => typeof n === "number" && n > input.now);
			const reason = typeof it.blockReason === "string" ? it.blockReason : typeof slot?.blockReason === "string" ? slot.blockReason : undefined;
			if (!reason) return null;
			if (typeof slot?.blockedUntil === "number" || typeof it.blockedUntil === "number") {
				const until = untils.sort((a, b) => b - a)[0];
				return until ? { blocked: reason, until } : null;
			}
			return { blocked: reason, until: undefined }; // an auth block lasts until the owner logs in again
		};
		const usable = (it: Item) => !state(it);
		const wanted = items.find(it => it.name === pinnedName) ?? items.find(it => usable(it)) ?? items[0];
		providers.push({
			id,
			name: id === "anthropic" && !oauth ? "Claude API 키" : providerLabel(id, catalog),
			auth: oauth ? "oauth" : "api_key",
			multi: oauth,
			can_add: ids.has(id) && oauth,
			can_pin: oauth && items.length > 0,
			can_delete: oauth && items.length > 1,
			accounts: items.map((it, i) => {
				const st = state(it);
				// aliases are kept per provider (`<provider>:<slot>`): two pools can hold an account named "default".
				return {
					name: it.name,
					label: input.aliases?.[`${id}:${it.name}`] ?? (oauth ? it.name : "API 키"),
					order: i + 1,
					current: it === wanted,
					pinned: pinnedName === it.name,
					blocked: st?.blocked ?? null,
					blocked_until: st?.until !== undefined ? new Date(st.until).toISOString() : null,
					blocked_tag: null,
					windows: windowsOf(input.usage, omoId, it.name),
				};
			}),
		});
	}
	providers.sort((a, b) => a.name.localeCompare(b.name));
	const login_providers = catalog.map(p => ({ id: p.id, name: providerLabel(p.id, catalog), configured: configured.has(p.id) }));
	return { providers, login_providers };
}

// The three files OmO's store is made of, read fresh (they are small and change on a login).
export function readProviderStore() {
	return {
		auth: readJson(authFile()),
		pool: readJson(join(dirname(authFile()), "credential-pool-state.json")),
		usage: readJson(join(dirname(authFile()), "subscription-usage.json")),
	};
}

const LOCK_STALE_MS = 30_000;
const LOCK_BUDGET_MS = 1_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// proper-lockfile's scheme as OmO uses it (hub/omo-pin.ts has the same, for the Claude pin): the lock is `<file>.lock`.
function lock(file: string): () => void {
	const dir = `${file}.lock`;
	const started = Date.now();
	for (let attempt = 0; ; attempt++) {
		try {
			mkdirSync(dir);
			return () => {
				try {
					rmdirSync(dir);
				} catch {}
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		try {
			if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
				rmdirSync(dir);
				continue;
			}
		} catch {
			continue;
		}
		const waited = Date.now() - started;
		if (waited >= LOCK_BUDGET_MS) throw new Error(`OmO의 계정 파일이 ${waited}ms 동안 잠겨 있어요 (${dir})`);
		sleep(Math.min(100 * 2 ** attempt, 1000, LOCK_BUDGET_MS - waited));
	}
}

// The entry of the provider the owner named, as auth.json keys it: `anthropic` is the subscription when there is one.
const authKeyOf = (auth: Json, provider: string): string | undefined => (provider === "anthropic" && SUBSCRIPTION in auth ? SUBSCRIPTION : provider in auth ? provider : undefined);

// Writes auth.json the way OmO does (JSON.stringify(..., null, 2), the file's own mode, a copy kept first) for one change.
function rewriteAuth(provider: string, change: (entry: Json, auth: Json) => void, now: number): "written" | "missing" {
	const file = authFile();
	if (!existsSync(file)) return "missing";
	const release = lock(file);
	try {
		const text = readFileSync(file, "utf8");
		const auth = JSON.parse(text) as Json;
		const key = authKeyOf(auth, provider);
		if (!key || !auth[key] || typeof auth[key] !== "object") return "missing";
		const backup = `${file}.dotz-account-backup-${now}`;
		if (!existsSync(backup)) {
			copyFileSync(file, backup);
			chmodSync(backup, 0o600);
		}
		change(auth[key], auth);
		const tmp = `${file}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}${text.endsWith("\n") ? "\n" : ""}`, { mode: 0o600 });
			chmodSync(tmp, statSync(file).mode & 0o777);
			renameSync(tmp, file);
		} catch (e) {
			rmSync(tmp, { force: true });
			throw e;
		}
		return "written";
	} finally {
		release();
	}
}

// OmO's own pin for a provider's account pool (`pinned`), or cleared with undefined. OmO honours it when it picks an account.
export function writeProviderPin(provider: string, account: string | undefined, now = Date.now()): "written" | "unchanged" | "missing" {
	try {
		const file = authFile();
		if (!existsSync(file)) return "missing";
		const before = readJson(file)?.[authKeyOf(readJson(file) ?? {}, provider) ?? ""];
		if (!before) return "missing";
		if ((before.pinned ?? undefined) === account) return "unchanged";
		const r = rewriteAuth(provider, entry => {
			if (account === undefined) delete entry.pinned;
			else entry.pinned = account;
		}, now);
		if (r === "written") log(`OmO pin (${provider}): ${account ?? "(cleared)"}`);
		return r;
	} catch (e) {
		log(`OmO pin (${provider}) failed: ${(e as Error).message}`);
		throw e;
	}
}

// Drops one account from a provider's pool. The last account is a sign-out (공급자 → 로그아웃), not a removal, and an older
// single-login entry holds nothing to drop, so both report without writing.
export function deletePoolAccount(provider: string, name: string, now = Date.now()): "deleted" | "missing" | "last" {
	const file = authFile();
	if (!existsSync(file)) return "missing";
	let outcome: "deleted" | "missing" | "last" = "missing";
	rewriteAuth(provider, entry => {
		const accounts: Json[] = Array.isArray(entry.accounts) ? entry.accounts : [];
		if (!accounts.some(a => a?.name === name)) return;
		if (accounts.length <= 1) {
			outcome = "last";
			return;
		}
		entry.accounts = accounts.filter(a => a?.name !== name);
		if (entry.pinned === name) delete entry.pinned;
		outcome = "deleted";
	}, now);
	if (outcome === "deleted") log(`OmO account deleted (${provider}): ${name}`);
	return outcome;
}
