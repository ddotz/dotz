// Conditional model fallback chains that the hub drives itself (the orchestrator and every lane): an entry can be used only
// after a usage limit or after a provider error, stop at a spend cap, come back when an earlier entry's limit resets, and
// run through its own API key. omp's native chain (retry.fallbackChains) cannot express any of that, so a layer whose chain
// has such an entry is switched by restarting the process on the same session with the next model; a chain of bare
// models stays with omp (hub/runtime/omp.ts). Usage and limit state persists in <data dir>/fallback-usage.json.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cfg, DATA_DIR, entryId, type FallbackEntry, isPlain, OMP, parseSelector, writeAtomic } from "./config.ts";
import { apiKeyBan } from "./apikey-policy.ts";
import { rateLimitDelay } from "./providers.ts";

// A chain the hub switches itself: any entry omp cannot walk.
const hubOwned = (entries: FallbackEntry[]) => entries.some(e => !isPlain(e));

export const clock = { now: () => Date.now() };
const FILE = join(DATA_DIR, "fallback-usage.json");

// ---- periods (KST month / day) --------------------------------------------------------------------------------------
const KST_MS = 9 * 3600e3;
export type Period = "month" | "day";
const periodKey = (period: Period, at: number) => new Date(at + KST_MS).toISOString().slice(0, period === "month" ? 7 : 10);
function periodEnd(period: Period, at: number): number {
	const d = new Date(at + KST_MS);
	const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
	return (period === "month" ? Date.UTC(y, m + 1, 1) : Date.UTC(y, m, day + 1)) - KST_MS;
}

// ---- persisted state ------------------------------------------------------------------------------------------------
type Counter = { key: string; tokens: number; usd: number };
type Blocked = { until: number; why: "quota" | "error"; since?: number };
type State = { pools: Record<string, Partial<Record<Period, Counter>>>; blocked: Record<string, Blocked> };
let state: State | undefined;
function load(): State {
	if (state) return state;
	try {
		const j = JSON.parse(readFileSync(FILE, "utf8")) as Partial<State>;
		state = { pools: j.pools ?? {}, blocked: j.blocked ?? {} };
	} catch {
		state = { pools: {}, blocked: {} };
	}
	return state;
}
const save = () => writeAtomic(FILE, `${JSON.stringify(load(), null, 1)}\n`);
// Tests start from a clean slate.
export function resetFallbackState(): void {
	state = { pools: {}, blocked: {} };
	save();
}

// What an entry spends from: its API key when it has one (every entry using that key shares it), else its model (a thinking
// suffix does not make another pool).
const poolOf = (e: FallbackEntry) => (e.key_file ? `key:${e.key_file}` : parseSelector(e.model).model);
function usageOf(e: FallbackEntry, period: Period, at = clock.now()): { key: string; tokens: number; usd: number } {
	const c = load().pools[poolOf(e)]?.[period];
	const key = periodKey(period, at);
	return c && c.key === key ? c : { key, tokens: 0, usd: 0 };
}
const capReached = (e: FallbackEntry, at: number) => {
	if (!e.cap) return false;
	const u = usageOf(e, e.cap.period, at);
	return Boolean((e.cap.usd && u.usd >= e.cap.usd) || (e.cap.tokens && u.tokens >= e.cap.tokens));
};

// ---- API keys -------------------------------------------------------------------------------------------------------
// The key lives in <data dir>/secrets/<file>; the config holds only the file name. Never logged, never put in a config or event.
// Only files named as API keys ("…api-key…", "…api_key…") qualify, so an entry cannot point at the hub token or a bot token
// in the same folder and send it to a base_url.
const KEY_FILE_NAME = /^(?!\.)[\w.-]*api[-_]?key[\w.-]*$/i;
export const keyPath = (file: string) => join(DATA_DIR, "secrets", basename(file));
export const keyFileOk = (file: string) => KEY_FILE_NAME.test(file) && existsSync(keyPath(file));
const readKey = (file: string) => (keyFileOk(file) ? readFileSync(keyPath(file), "utf8").trim() : "");

// Provider ids omp has no key-only endpoint for need `base_url` and `api` on the entry.
const KEY_APIS: Record<string, { api: string; baseUrl: string }> = {
	anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
	openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
};
// Where an API key may be sent: https only, to a provider's official API host or a host the owner listed in config.json
// `key_hosts`. Checked when a chain is saved and again before a process gets the key.
const keyBaseUrl = (e: FallbackEntry) => e.base_url ?? KEY_APIS[e.model.split("/")[0]]?.baseUrl;
export function keyHostOk(url: string | undefined): boolean {
	let u: URL;
	try {
		u = new URL(url ?? "");
	} catch {
		return false;
	}
	const allowed = new Set([...Object.values(KEY_APIS).map(a => new URL(a.baseUrl).hostname), ...(cfg.key_hosts ?? []).map(h => String(h).toLowerCase())]);
	return u.protocol === "https:" && !u.username && !u.password && allowed.has(u.hostname.toLowerCase());
}
export const keyProviderOk = (e: FallbackEntry) => Boolean(e.key_file) && Boolean((e.base_url && e.api) || KEY_APIS[e.model.split("/")[0]]) && keyHostOk(keyBaseUrl(e));

type ModelDef = { id?: string; name?: string; provider?: string; reasoning?: boolean; input?: string[]; contextWindow?: number; maxTokens?: number; cost?: Record<string, number> };
let defs: Map<string, ModelDef> | undefined;
// The catalog row of a model (omp lists it with its prices), read once with a blocking call: spawning a process is synchronous.
// Bounded to 15 s; a failed read is remembered (the entry then runs with default limits) so it is not retried at every spawn.
function modelDef(selector: string): ModelDef | undefined {
	if (!defs) {
		defs = new Map();
		try {
			const r = Bun.spawnSync([OMP, "models", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
			for (const m of (JSON.parse(r.stdout.toString()).models ?? []) as Array<ModelDef & { selector: string }>) defs.set(m.selector, m);
		} catch {}
	}
	return defs.get(selector);
}

// An entry with a key runs as its own provider ("<provider>-apikey"), because omp prefers a stored login over an API key for
// the provider's own id. The provider is registered inside the process by the dotz extension from DOTZ_KEY_PROVIDER (no
// secret); the key travels in DOTZ_KEY_VALUE, which the extension removes from the environment once it has registered it.
const keyedModel = (e: FallbackEntry) => {
	const [provider, ...rest] = e.model.split("/");
	return `${provider}-apikey/${rest.join("/")}`;
};
function keyEnv(e: FallbackEntry): Record<string, string> {
	if (!keyHostOk(keyBaseUrl(e))) throw new Error(`API-key entry ${e.model}: base URL host is not allowed`);
	const ban = apiKeyBan();
	if (ban) throw new Error(`API-key entry ${e.model}: no API key while ${ban} is pinned`);
	const base = parseSelector(e.model).model;
	const def = modelDef(base);
	const [provider, ...rest] = base.split("/");
	const api = KEY_APIS[provider];
	const spec = {
		id: `${provider}-apikey`,
		baseModel: base,
		baseUrl: e.base_url ?? api?.baseUrl,
		api: e.api ?? api?.api,
		models: [{ id: rest.join("/"), name: `${def?.name ?? rest.join("/")} (API key)`, reasoning: Boolean(def?.reasoning), input: def?.input ?? ["text"], contextWindow: def?.contextWindow ?? 200_000, maxTokens: def?.maxTokens ?? 32_000, ...(def?.cost ? { cost: def.cost } : {}) }],
	};
	return { DOTZ_KEY_PROVIDER: JSON.stringify(spec), DOTZ_KEY_VALUE: readKey(e.key_file!) };
}

// ---- the chain ------------------------------------------------------------------------------------------------------
export const REVERT_PROBE_MS = 10 * 60_000;
// Consecutive failed turns (any cause) after which automatic retries, failovers and keepalives stop until a turn succeeds;
// the owner is told once (2026-10-20: nine "stream start timed out" turns in a row, each retried).
export const ERROR_STREAK_STOP = 5;
export class ErrorStreak {
	private n = 0;
	get stopped(): boolean {
		return this.n >= ERROR_STREAK_STOP;
	}
	// One more failed turn: "stop" exactly when the run reaches the limit (alert then), "stopped" past it.
	fail(): "go" | "stop" | "stopped" {
		this.n++;
		return this.n < ERROR_STREAK_STOP ? "go" : this.n === ERROR_STREAK_STOP ? "stop" : "stopped";
	}
	ok(): void {
		this.n = 0;
	}
}
export type Why = "quota" | "error" | "cap" | "revert";
export type Move = { from: number; to: number; why: Why };
type Down = { why: "quota" | "error" | "cap"; until: number; since?: number };
const ERROR_BLOCK_MS = 10 * 60_000;
const KEY_BLOCK_MS = 60_000;

export class Chain {
	// Entry 0 is the process's own primary model; the others follow in order.
	readonly list: FallbackEntry[];
	active = 0;
	constructor(primary: string, entries: FallbackEntry[], private readonly thinking: string) {
		this.list = [{ model: parseSelector(primary).model }, ...entries];
	}
	// Why entry i cannot be used now (a limit it hit, its spend cap, a missing key), and until when.
	down(i: number, at = clock.now()): Down | undefined {
		const e = this.list[i];
		const b = load().blocked[poolOf(e)];
		if (b && b.until > at) return b;
		if (capReached(e, at)) return { why: "cap", until: periodEnd(e.cap!.period, at) };
		// No API key while a no-API-key account is pinned (hub/apikey-policy.ts); re-checked each minute, like a missing key.
		if (e.key_file && (apiKeyBan() || !readKey(e.key_file) || !keyHostOk(keyBaseUrl(e)))) return { why: "error", until: at + KEY_BLOCK_MS };
		return undefined;
	}
	// A fallback entry takes over after `reason` only when its condition allows it (a cap counts as a quota).
	private fits(i: number, reason: "quota" | "error") {
		const w = this.list[i].when;
		return !w || w === reason;
	}
	next(after: number, reason: "quota" | "error", at = clock.now()): number | undefined {
		for (let i = after + 1; i < this.list.length; i++) if (this.fits(i, reason) && !this.down(i, at)) return i;
		return undefined;
	}
	// The entry a fresh process starts on: the first one not down, walking on from each down entry by its own reason.
	initial(at = clock.now()): number {
		let i = 0;
		for (;;) {
			const d = this.down(i, at);
			if (!d) return i;
			const n = this.next(i, d.why === "error" ? "error" : "quota", at);
			if (n === undefined) return i;
			i = n;
		}
	}
	// Set when no entry can run and at least one is out for its spend cap: nothing may start until the earliest block ends
	// (a cap period, or the usage limit of an entry before it).
	exhaustedUntil(at = clock.now()): number | undefined {
		const downs = this.list.map((_, i) => this.down(i, at));
		if (downs.some(d => !d) || !downs.some(d => d?.why === "cap")) return undefined;
		return Math.min(...downs.map(d => d!.until));
	}
	// The active entry failed (`quota`: usage limit until `until`; `error`: provider error): the entry to switch to, if any.
	fail(reason: "quota" | "error", until?: number, at = clock.now()): Move | undefined {
		load().blocked[poolOf(this.list[this.active])] = { why: reason, until: until ?? at + ERROR_BLOCK_MS, since: at };
		save();
		const to = this.next(this.active, reason, at);
		return to === undefined ? undefined : { from: this.active, to, why: reason };
	}
	// Counts one finished request on the active entry's pool. `capped` is set when that reached the entry's cap; `move` then names
	// the entry to switch to (none left: the chain is exhausted).
	spend(tokens: number, usd: number | undefined, at = clock.now()): { capped: boolean; move?: Move } | undefined {
		const e = this.list[this.active];
		const pool = (load().pools[poolOf(e)] ??= {});
		for (const period of ["month", "day"] as const) {
			const key = periodKey(period, at);
			const c = pool[period]?.key === key ? pool[period]! : (pool[period] = { key, tokens: 0, usd: 0 });
			c.tokens += tokens;
			c.usd += usd ?? 0;
		}
		save();
		if (!capReached(e, at)) return undefined;
		// The next entry that takes over after a quota, else an earlier one that is usable again.
		let to = this.next(this.active, "quota", at);
		for (let j = 0; to === undefined && j < this.active; j++) if (!this.down(j, at)) to = j;
		return { capped: true, ...(to === undefined ? {} : { move: { from: this.active, to, why: "cap" as const } }) };
	}
	// An earlier entry is usable again and the active one is marked `revert`: where to go back to.
	// Every fallback entry goes back (a keyed or conditional one too, 2026-10-20: an API-key fallback stayed ~30 min after the
	// subscription's limit reset because only bare entries were marked); `revert: false` keeps an entry. An earlier entry out
	// on a usage limit is tried again REVERT_PROBE_MS after the limit was written (the reset time is an estimate); a failed try
	// writes the limit again, so tries stay that far apart.
	revertTarget(at = clock.now()): Move | undefined {
		if (this.active === 0 || this.list[this.active].revert === false) return undefined;
		for (let j = 0; j < this.active; j++) {
			const d = this.down(j, at);
			if (!d) return { from: this.active, to: j, why: "revert" };
			if (d.why === "quota" && at - (d.since ?? 0) >= REVERT_PROBE_MS) {
				// The restart picks its entry from the recorded limits (initial()), so the try lifts this one.
				delete load().blocked[poolOf(this.list[j])];
				save();
				return { from: this.active, to: j, why: "revert" };
			}
		}
		return undefined;
	}
	// The model selector a process runs entry i as (thinking as the primary's unless the entry names one).
	selector(i: number): string {
		const e = this.list[i];
		const split = parseSelector(e.model);
		const hasLevel = e.model !== split.model;
		const model = e.key_file ? keyedModel({ ...e, model: split.model }) : split.model;
		return `${model}:${hasLevel ? split.thinking : this.thinking}`;
	}
	// Environment a process of entry i needs (the key provider); nothing for an entry without a key.
	env(i: number): Record<string, string> {
		const e = this.list[i];
		return e.key_file ? keyEnv(e) : {};
	}
	label(i: number): string {
		const e = this.list[i];
		return e.key_file ? `${e.model} (API key)` : e.model;
	}
	// Spend of entry i in its cap period, for the settings view.
	usage(i: number) {
		const e = this.list[i];
		return e.cap ? { period: e.cap.period, ...usageOf(e, e.cap.period) } : undefined;
	}
}

// One entry's cap period figures for the settings tab, computed without a running process.
export function entryView(e: FallbackEntry) {
	const used = e.cap ? usageOf(e, e.cap.period) : undefined;
	const d = new Chain(e.model, [e], "off").down(1);
	return { ...e, ...(used ? { used: { period: e.cap!.period, tokens: used.tokens, usd: used.usd } } : {}), ...(d ? { down: d.why, until: new Date(d.until).toISOString() } : {}), id: entryId(e) };
}

// Failures the chain moves on from: a usage limit, a billing/auth problem only the owner can fix, a provider error. Anything
// else (a bad request, context too long, a tool or schema error) is the turn's own problem and stays with the process.
export const failsOver = (kind?: string) => kind === "rate" || kind === "owner" || kind === "transient";
// A failed turn is a quota problem when the provider says so (usage limit, spent credit or balance), else a plain error.
export const failureReason = (e: { kind?: string; text: string }): "quota" | "error" => (e.kind === "rate" || /quota|credit|balance|billing|insufficient|usage limit|spend limit/i.test(e.text) ? "quota" : "error");
// The entries the hub switches itself for a process of `runtimeId`, or undefined when the runtime gets them as its own list.
// omp walks a chain of bare models natively (retry.fallbackChains in its per-run overlay), so the hub takes an omp chain only
// when an entry needs a condition, cap, revert or key. OmO runs with --no-model-fallback: its own chain would follow the
// owner's global settings, and its per-process override (RPC set_retry_fallback) is refused once a session has turn
// history, i.e. on every resume. So the hub drives every OmO chain (restart on the same session with the next entry; OmO's
// usage frames give the spend and the dotz extension registers key providers there too), and a bare entry goes back to the
// primary once that is usable again, as omp's cooldown-expiry revert does. Claude Code gets a plain --fallback-model list.
export function hubChain(runtimeId: string, entries: FallbackEntry[]): FallbackEntry[] | undefined {
	if (runtimeId === "omo") return entries.length ? entries.map(e => (isPlain(e) ? { ...e, revert: true } : e)) : undefined;
	return runtimeId === "omp" && hubOwned(entries) ? entries : undefined;
}

// Runs `fn` at `until` (at least 1 s from now). setTimeout cannot wait longer than 2^31-1 ms (~24.8 days; a monthly cap
// period is longer), so a longer wait re-arms itself; `keep` receives each timer so the caller can still clear it.
const MAX_TIMER_MS = 2 ** 31 - 1;
export function atTime(until: number, keep: (t: Timer) => void, fn: () => void): void {
	const left = until - Date.now();
	keep(left > MAX_TIMER_MS ? setTimeout(() => atTime(until, keep, fn), MAX_TIMER_MS) : setTimeout(fn, Math.max(1000, left)));
}

// ---- going back after the runtime's own fallback walk --------------------------------------------------------------------
// A runtime that moves a process to the next model by itself (omp's native chain, also on a refusal) never comes back: the
// process then stays on the fallback until it restarts. One Reverter per process remembers the configured model and says when
// to switch back: a refusal or a provider error before the next turn, a usage limit once it has reset. It only switches
// between turns, so it cannot loop inside one; a turn that falls back again is undone again before the next (a refusal is
// about one request, and a limit that had not reset yet just re-arms the wait). A process whose chain the hub drives
// itself does not use one (the hub restarts it on the entry it wants).
const QUOTA_REVERT_MS = 15 * 60_000;
type RevertWhy = "refusal" | "quota" | "error";
export const revertWhy = (reason: string, kind?: string): RevertWhy => (/refusal/i.test(reason) ? "refusal" : failureReason({ kind, text: reason }));
export class Reverter {
	private plan?: { to: string; due: number };
	// A fallback happened while the process ran `original` (its configured selector). A second hop of the same walk keeps
	// the first one's original.
	note(original: string, why: RevertWhy, from: string, reason: string): void {
		const plan = (this.plan ??= { to: original, due: 0 });
		if (why !== "quota") return;
		plan.due = Math.max(plan.due, clock.now() + QUOTA_REVERT_MS);
		// A usage report or the error's retry-after names the reset; the default above holds until it is known.
		const mine = plan;
		void rateLimitDelay(reason, from).then(d => {
			if (this.plan === mine && (d.reset || /retry-after-ms:\s*\d+/.test(reason))) mine.due = clock.now() + d.ms;
		}).catch(() => {});
	}
	pending = (): string | undefined => this.plan?.to;
	// The configured selector when switching back is due, and it is spent: the caller must now switch the process to it.
	// `idle`: the caller has no turn to start, so only a usage limit that has reset counts (a refusal waits for the next turn).
	take(idle = false, at = clock.now()): string | undefined {
		if (!this.plan || at < this.plan.due || (idle && !this.plan.due)) return undefined;
		const { to } = this.plan;
		this.plan = undefined;
		return to;
	}
	reset(): void {
		this.plan = undefined;
	}
}
