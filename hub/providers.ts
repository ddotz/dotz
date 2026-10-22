// Model providers as the gateway sees them, all kept in the runtime's own credential store: OAuth logins (`omp login`,
// started and finished through the gateway), API keys (`omp auth import`), sign-out (`omp auth-broker logout`), plus
// the model catalog and quota. The gateway keeps no credentials of its own; keys are only ever shown masked.
import { readFileSync } from "node:fs";
import { OMP } from "./config.ts";
import { label } from "./account-alias.ts";
import { authFile } from "./apikey-policy.ts";
import { OMO } from "./runtime/omo-hosts.ts";
import { stickyAccount } from "./account-sticky.ts";
import { labeledAccountView } from "./accounts-api.ts";
import { orgLimits } from "./org-limits.ts";
import { type AccountReport, AccountUsage, fromOmp, runtimeIdOf, subscriptionAccount, subscriptionAccounts } from "./usage-account.ts";

// omp provider id -> the env var omp reads its API key from (omp docs: providers.md, "Environment variables").
const PROVIDER_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY", "google-vertex": "GOOGLE_CLOUD_API_KEY",
	groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", mistral: "MISTRAL_API_KEY", xai: "XAI_API_KEY", azure: "AZURE_OPENAI_API_KEY",
	abliteration: "ABLITERATION_API_KEY", aiand: "AIAND_API_KEY", cerebras: "CEREBRAS_API_KEY", "alibaba-token-plan": "ALIBABA_TOKEN_PLAN_API_KEY",
	baseten: "BASETEN_API_KEY", commandcode: "COMMAND_CODE_API_KEY", coralbricks: "CORAL_API_KEY", deepinfra: "DEEPINFRA_API_KEY",
	deepseek: "DEEPSEEK_API_KEY", siliconflow: "SILICONFLOW_API_KEY", "siliconflow-cn": "SILICONFLOW_CN_API_KEY", fireworks: "FIREWORKS_API_KEY",
	together: "TOGETHER_API_KEY", typesafe: "TYPESAFE_API_KEY", coreweave: "COREWEAVE_API_KEY", nvidia: "NVIDIA_API_KEY", devin: "DEVIN_API_KEY",
	"gmi-cloud": "GMI_API_KEY", huggingface: "HUGGINGFACE_HUB_TOKEN", moonshot: "MOONSHOT_API_KEY", stepfun: "STEPFUN_API_KEY",
	helmcode: "HELMCODE_API_KEY", meta: "MODEL_API_KEY", nanogpt: "NANO_GPT_API_KEY", novita: "NOVITA_API_KEY", venice: "VENICE_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY", litellm: "LITELLM_API_KEY", kilo: "KILO_API_KEY", zai: "ZAI_API_KEY", zenmux: "ZENMUX_API_KEY",
	"zhipu-coding-plan": "ZHIPU_API_KEY", umans: "UMANS_AI_CODING_PLAN_API_KEY", qianfan: "QIANFAN_API_KEY", synthetic: "SYNTHETIC_API_KEY",
	"minimax-code": "MINIMAX_CODE_API_KEY", "minimax-code-cn": "MINIMAX_CODE_CN_API_KEY", minimax: "MINIMAX_API_KEY",
	"alibaba-coding-plan": "ALIBABA_CODING_PLAN_API_KEY", sakana: "SAKANA_API_KEY", sambanova: "SAMBANOVA_API_KEY", aimlapi: "AIMLAPI_API_KEY",
	"opencode-zen": "OPENCODE_API_KEY", "opencode-go": "OPENCODE_API_KEY", "cline-pass": "CLINE_API_KEY", firepass: "FIREPASS_API_KEY",
	"wafer-serverless": "WAFER_SERVERLESS_API_KEY", xiaomi: "XIAOMI_API_KEY", "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY", "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ollama-cloud": "OLLAMA_CLOUD_API_KEY", ollama: "OLLAMA_API_KEY", "lm-studio": "LM_STUDIO_API_KEY", "llama.cpp": "LLAMA_CPP_API_KEY",
	vllm: "VLLM_API_KEY", "yolo-auto": "YOLO_AUTO_API_KEY", "charm-hyper": "CHARM_HYPER_API_KEY", "singularityapi-dev": "SINGULARITYAPI_DEV_API_KEY",
	"singularityapi-tech": "SINGULARITYAPI_TECH_API_KEY",
};

export class ControlError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

export const mask = (key: string): string => (key.length < 12 ? `…${key.slice(-2)}` : `${key.startsWith("sk-") ? "sk-" : key.slice(0, 2)}…${key.slice(-4)}`);

export async function saveProviderKey(provider: string, rawKey: string): Promise<string> {
	const key = rawKey.trim();
	if (!PROVIDER_ENV[provider]) throw new ControlError(`"${provider}"은(는) API 키로 추가할 수 없는 공급자예요`);
	if (key.length < 8 || key.length > 512 || /\s/.test(key)) throw new ControlError("키 형식이 올바르지 않아요 (공백 없이 8~512자)");
	const proc = Bun.spawn([OMP, "auth", "import", "-"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
	proc.stdin.write(JSON.stringify({ version: 1, credentials: [{ provider, credential: { type: "api_key", key } }] }));
	await proc.stdin.end();
	if ((await proc.exited) !== 0) throw new ControlError("키를 저장하지 못했어요", 500);
	invalidate();
	return mask(key);
}

// Provider keys set in the gateway's own environment, redacted from anything shown to the owner.
export function secretValues(): string[] {
	return Object.values(PROVIDER_ENV)
		.map(v => process.env[v] ?? "")
		.filter(v => v.length >= 8);
}

type OmpModel = { kind?: string; selector: string; id?: string; name?: string; provider: string; reasoning?: boolean };
type OmpCredential = { provider: string; credential?: Record<string, unknown> };
type OmpLimit = { id: string; label?: string; window?: { id?: string; label?: string; resetsAt?: number }; amount?: { used?: number; limit?: number; remaining?: number; unit?: string }; status?: string };
type OmpUsageReport = { provider: string; limits?: OmpLimit[]; metadata?: { email?: string }; account?: string };

async function ompJson<T>(args: string[], timeoutMs = 30_000): Promise<T | undefined> {
	try {
		const proc = Bun.spawn([OMP, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const text = await new Response(proc.stdout).text();
		clearTimeout(timer);
		return (await proc.exited) === 0 ? (JSON.parse(text) as T) : undefined;
	} catch {
		return undefined;
	}
}

type Cached<T> = { at: number; value: T };
const TTL_MS = 20_000;
let cache: { models?: Cached<ModelInfo[]>; auth?: Cached<AuthInfo[]>; usage?: Cached<OmpUsageReport[]> } = {};
function invalidate(): void {
	cache = {};
}
async function cached<K extends keyof typeof cache>(key: K, load: () => Promise<NonNullable<(typeof cache)[K]>["value"] | undefined>): Promise<NonNullable<(typeof cache)[K]>["value"] | undefined> {
	const hit = cache[key];
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
	const value = await load();
	if (value !== undefined) cache = { ...cache, [key]: { at: Date.now(), value } };
	return value;
}

// Runtimes keep separate credential stores: omp has its own (`omp auth export`), OmO reads <agent dir>/auth.json. A role that
// runs on OmO lists what OmO can run, not what omp happens to hold (a fresh OmO machine has an empty omp store).
const ROLES = ["orchestrator", "lane"] as const;
const usesOmo = (): boolean => ROLES.some(r => runtimeIdOf(r) === "omo");
const usesOmp = (): boolean => ROLES.some(r => runtimeIdOf(r) !== "omo");

async function cliText(bin: string, args: string[], timeoutMs = 30_000): Promise<string | undefined> {
	try {
		const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const text = await new Response(proc.stdout).text();
		clearTimeout(timer);
		return (await proc.exited) === 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

function omoAuth(): Record<string, unknown> | undefined {
	try {
		const j = JSON.parse(readFileSync(authFile(), "utf8"));
		return j && typeof j === "object" ? j : undefined;
	} catch {
		return undefined;
	}
}

// OmO's `anthropic-subscription` is the Claude login, which dotz (like omp) calls `anthropic`; OmO's own `anthropic` is the
// API-key provider and stays out of the way while a subscription login exists (hub/runtime/omo.ts omoSelector maps back).
const SUBSCRIPTION = "anthropic-subscription";
const dotzProvider = (id: string): string => (id === SUBSCRIPTION ? "anthropic" : id);
const shadowed = (id: string, auth: Record<string, unknown>): boolean => id === "anthropic" && SUBSCRIPTION in auth;

// Pure: the credentials in OmO's auth.json (provider ids, types, masked key tails; never the secrets).
export function omoAuthInfos(auth: Record<string, unknown> | undefined): AuthInfo[] {
	if (!auth) return [];
	return Object.entries(auth).flatMap(([id, v]): AuthInfo[] => {
		if (!v || typeof v !== "object" || shadowed(id, auth)) return [];
		const c = v as Record<string, unknown>;
		const accounts = Array.isArray(c.accounts) ? (c.accounts as { name?: unknown }[]) : [];
		const name = typeof c.pinned === "string" ? c.pinned : accounts.find(a => typeof a?.name === "string")?.name;
		const key = ["key", "apiKey", "api_key"].map(k => c[k]).find((x): x is string => typeof x === "string" && x.length > 0);
		return [{ provider: dotzProvider(id), type: String(c.type ?? (key ? "api_key" : "oauth")), label: typeof name === "string" ? name : undefined, masked: key ? mask(key) : undefined }];
	});
}

// Pure: `omo --list-models` (a table: provider, model, context, max-out, thinking, images) cut down to the providers OmO
// holds credentials for (auth.json keys, or the provider's API-key env var), under dotz's provider names.
export function omoModels(table: string, auth: Record<string, unknown> | undefined, env: Record<string, string | undefined>): ModelInfo[] {
	const a = auth ?? {};
	const ready = new Set(Object.keys(a).filter(id => !shadowed(id, a)));
	for (const [id, v] of Object.entries(PROVIDER_ENV)) if (env[v] && !shadowed(id, a)) ready.add(id);
	return table.split("\n").flatMap((line): ModelInfo[] => {
		const [provider, model, , , thinking] = line.trim().split(/\s+/);
		if (!provider || !model || provider === "provider" || !ready.has(provider)) return [];
		const dotz = dotzProvider(provider);
		return [{ selector: `${dotz}/${model}`, name: model, provider: dotz, reasoning: thinking === "yes" }];
	});
}

export type ModelInfo = { selector: string; name: string; provider: string; reasoning: boolean };
const ompModels = async (): Promise<ModelInfo[] | undefined> => {
	const j = await ompJson<{ models?: OmpModel[] }>(["models", "--json"]);
	return Array.isArray(j?.models) ? j.models.filter(m => m.kind === "chat").map(m => ({ selector: m.selector, name: m.name ?? m.id ?? m.selector, provider: m.provider, reasoning: Boolean(m.reasoning) })) : undefined;
};
export const availableModels = async (): Promise<ModelInfo[]> =>
	(await cached("models", async () => {
		const [omo, omp] = await Promise.all([usesOmo() ? cliText(OMO, ["--list-models"]).then(t => (t === undefined ? undefined : omoModels(t, omoAuth(), process.env))) : [], usesOmp() ? ompModels() : []]);
		if (omo === undefined && omp === undefined) return undefined;
		const seen = new Set<string>();
		return [...(omo ?? []), ...(omp ?? [])].filter(m => !seen.has(m.selector) && seen.add(m.selector));
	})) ?? [];

// What omp itself has stored (`omp auth export`): only provider ids, credential types and masked key tails are kept.
type AuthInfo = { provider: string; type: string; label?: string; masked?: string };
const authInfos = async (): Promise<AuthInfo[]> =>
	(await cached("auth", async () => {
		const own = usesOmo() ? omoAuthInfos(omoAuth()) : [];
		if (!usesOmp()) return own;
		const j = await ompJson<{ credentials?: OmpCredential[] }>(["auth", "export"]);
		if (!Array.isArray(j?.credentials)) return own.length ? own : undefined;
		return [...own, ...j.credentials.map((c): AuthInfo => {
			const cred = c.credential ?? {};
			const key = ["key", "apiKey", "api_key", "token"].map(k => cred[k]).find((v): v is string => typeof v === "string" && v.length > 0);
			return { provider: c.provider, type: String(cred.type), label: typeof cred.email === "string" ? cred.email : undefined, masked: key ? mask(key) : undefined };
		})];
	})) ?? [];

const usageReports = async (): Promise<OmpUsageReport[]> =>
	(await cached("usage", async () => (await ompJson<{ reports?: OmpUsageReport[] }>(["usage", "--json"], 45_000))?.reports)) ?? [];

// The Anthropic limits of the account the role really runs on (hub/usage-account.ts): OmO's own subscription account
// under OmO, else omp's login. `force` asks again sooner (a 429 just happened). Undefined: nothing to read.
const accountUsage = new AccountUsage();
export async function anthropicUsage(role: "orchestrator" | "lane" = "orchestrator", force = false): Promise<AccountReport | undefined> {
	const acct = runtimeIdOf(role) === "omo" ? subscriptionAccount(undefined, undefined, stickyAccount()) : undefined;
	if (acct) return accountUsage.report(acct, force);
	if (force) invalidate();
	const r = (await usageReports()).find(x => x.provider === "anthropic");
	return r && fromOmp(r);
}

// The percent left in each OmO subscription account's 5-hour and 7-day windows, from the cached oauth/usage reads (not a model
// call; each account is asked at most every 2 minutes). The owner's account rules (hub/account-rules.ts) read it.
export async function usageSnapshot(): Promise<Record<string, { five_hour_left?: number; seven_day_left?: number }>> {
	if (runtimeIdOf("orchestrator") !== "omo" && runtimeIdOf("lane") !== "omo") return {};
	const out: Record<string, { five_hour_left?: number; seven_day_left?: number }> = {};
	await Promise.all(
		subscriptionAccounts().map(async acct => {
			const r = await accountUsage.report(acct).catch(() => undefined);
			if (!r) return;
			const five = r.limits.find(l => l.id === "anthropic:5h")?.amount.remaining;
			const week = r.limits.find(l => l.id === "anthropic:7d")?.amount.remaining;
			out[acct.name] = { ...(five !== undefined ? { five_hour_left: five } : {}), ...(week !== undefined ? { seven_day_left: week } : {}) };
		}),
	);
	return out;
}

// Every provider the runtime can log into (`auth-broker list`) with its human label; fixed for the runtime's lifetime.
type LoginProvider = { id: string; name: string };
let loginCatalog: LoginProvider[] | undefined;
export async function loginProviders(): Promise<LoginProvider[]> {
	if (loginCatalog) return loginCatalog;
	const j = await ompJson<LoginProvider[]>(["auth-broker", "list", "--json"]);
	if (!Array.isArray(j)) return [];
	loginCatalog = j.filter(p => typeof p?.id === "string").map(p => ({ id: p.id, name: String(p.name ?? p.id) }));
	return loginCatalog;
}

type ProviderRow = { id: string; name: string; auth: "oauth" | "api_key" | "none"; account?: string; masked?: string; models: number; in_use: boolean; can_login: boolean; can_logout: boolean };
type AddableProvider = { id: string; name: string; kind: "oauth" | "api_key" };

// Providers that have an API-key env var but whose primary sign-in is the subscription (OAuth) login.
const OAUTH_FIRST = new Set(["anthropic"]);

// Pure: merges the runtime's stored credentials, env vars, the login catalog and the model catalog into the configured
// rows and the not-yet-configured (addable) providers.
export function buildProviders(input: { auth: AuthInfo[]; env: Record<string, string | undefined>; models: ModelInfo[]; catalog: LoginProvider[]; inUse: Set<string> }): { providers: ProviderRow[]; addable: AddableProvider[] } {
	const names = new Map(input.catalog.map(p => [p.id, p.name]));
	const nameOf = (id: string) => names.get(id) ?? id;
	const ids = new Set<string>([...input.auth.map(a => a.provider), ...input.models.map(m => m.provider)]);
	for (const [id, v] of Object.entries(PROVIDER_ENV)) if (input.env[v]) ids.add(id);
	const providers = [...ids].sort().map((id): ProviderRow => {
		const base = { id, name: nameOf(id), models: input.models.filter(m => m.provider === id).length, in_use: input.inUse.has(id), can_login: names.has(id) };
		const oauth = input.auth.find(a => a.provider === id && a.type === "oauth");
		if (oauth) return { ...base, auth: "oauth", account: oauth.label, can_logout: true };
		const key = input.auth.find(a => a.provider === id);
		if (key) return { ...base, auth: "api_key", masked: key.masked, can_logout: true };
		const v = PROVIDER_ENV[id];
		if (v && input.env[v]) return { ...base, auth: "api_key", can_logout: false };
		return { ...base, auth: "none", can_logout: false };
	});
	const addable: AddableProvider[] = [];
	for (const p of input.catalog) if (!ids.has(p.id)) addable.push({ id: p.id, name: p.name, kind: PROVIDER_ENV[p.id] && !OAUTH_FIRST.has(p.id) ? "api_key" : "oauth" });
	for (const id of Object.keys(PROVIDER_ENV)) if (!ids.has(id) && !names.has(id)) addable.push({ id, name: id, kind: "api_key" });
	return { providers, addable: addable.sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function listProviders(inUse: Set<string>): Promise<{ providers: ProviderRow[]; addable: AddableProvider[] }> {
	return buildProviders({ auth: await authInfos(), env: process.env, models: await availableModels(), catalog: await loginProviders(), inUse });
}

// ---- Sign-in (OAuth and subscription logins) ------------------------------------------------------------------------
// The runtime's login command prints an authorize URL, listens on a localhost callback and, in parallel, reads the
// authorization code (or the whole redirect URL) from stdin, so it can be finished from a browser on another device.
// One login runs at a time; it is cancelled after LOGIN_TTL_MS. Output is parsed in memory only, never logged.
const LOGIN_TTL_MS = 10 * 60_000;
const LOGIN_START_MS = 20_000;
const LOGIN_COMPLETE_MS = 60_000;
const LOGIN_QUIET_MS = 400;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;

type Login = {
	id: string;
	provider: string;
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	out: string;
	lastOutAt: number;
	exited: boolean;
	status: "waiting" | "done" | "failed";
	error?: string;
	cancelled: boolean;
	timer: ReturnType<typeof setTimeout>;
};
let login: Login | undefined;

type LoginView = { url: string; needs_code: boolean; prompt?: string; instructions?: string };

// Pure: what the owner has to do next, read off the login process output (an unterminated last line is a pending prompt).
function parseLoginOutput(out: string): LoginView {
	const lines = out.replace(/\r/g, "").split("\n");
	const prompt = out.length > 0 && !out.endsWith("\n") ? lines[lines.length - 1].trim() || undefined : undefined;
	const finished = prompt === undefined ? lines : lines.slice(0, -1);
	const at = finished.map(l => l.trim()).findLastIndex(l => /^https?:\/\/\S+$/.test(l));
	const url = at >= 0 ? finished[at].trim() : "";
	const instructions = at < 0 ? [] : finished.slice(at + 1).map(l => l.trim()).reduce<{ lines: string[]; open: boolean }>((acc, l) => {
		if (!l) acc.open = false;
		else if (acc.open && !/^(Local shortcut|Waiting for)/.test(l) && !/omp/i.test(l)) acc.lines.push(l);
		return acc;
	}, { lines: [], open: true }).lines;
	return { url, needs_code: prompt !== undefined, ...(prompt ? { prompt } : {}), ...(instructions.length ? { instructions: instructions.join("\n") } : {}) };
}

function finishLogin(l: Login, code: number): void {
	clearTimeout(l.timer);
	l.exited = true;
	if (code === 0 && !l.cancelled) l.status = "done";
	else {
		l.status = "failed";
		l.error = l.cancelled ? "로그인이 취소됐어요" : "로그인에 실패했어요. 코드를 확인하고 다시 시도해 주세요";
	}
	if (l.status === "done") invalidate();
}

async function pump(l: Login, stream: ReadableStream<Uint8Array>): Promise<void> {
	const dec = new TextDecoder();
	for await (const chunk of stream) {
		if (l.out.length < 262_144) l.out += dec.decode(chunk, { stream: true }).replace(ANSI, "");
		l.lastOutAt = Date.now();
	}
}

function killLogin(l: Login, reason: string): void {
	if (l.exited) return;
	l.cancelled = true;
	if (reason) l.error = reason;
	l.proc.kill();
	setTimeout(() => !l.exited && l.proc.kill(9), 2000).unref();
}

// Resolves when the process exited, when it asks for input (or shows its URL) after at least `after` characters of
// output and then falls quiet, or at the deadline.
function settle(l: Login, after: number, maxMs: number, needUrl: boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const started = Date.now();
	const tick = () => {
		if (l.exited || Date.now() - started > maxMs) return resolve();
		if (l.out.length > after && Date.now() - l.lastOutAt >= LOGIN_QUIET_MS) {
			const v = parseLoginOutput(l.out);
			if (v.prompt || (needUrl && v.url)) return resolve();
		}
		setTimeout(tick, 100);
	};
	tick();
	return promise;
}

function loginOf(provider: string, loginId: string): Login {
	if (!login || login.provider !== provider || login.id !== loginId) throw new ControlError("진행 중인 로그인이 없어요", 404);
	return login;
}

export async function startLogin(provider: string): Promise<{ login_id: string } & LoginView> {
	if (!PROVIDER_ID.test(provider) || !(await loginProviders()).some(p => p.id === provider)) throw new ControlError(`"${provider}"은(는) 로그인할 수 없는 공급자예요`, 404);
	if (login && !login.exited) throw new ControlError(`이미 진행 중인 로그인이 있어요 (${login.provider}). 먼저 취소해 주세요`, 409);
	const proc = Bun.spawn([OMP, "login", provider], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, BROWSER: "true" } });
	const l: Login = { id: crypto.randomUUID(), provider, proc, out: "", lastOutAt: Date.now(), exited: false, status: "waiting", cancelled: false, timer: setTimeout(() => killLogin(l, "시간이 지나 로그인이 취소됐어요"), LOGIN_TTL_MS) };
	l.timer.unref();
	login = l;
	void pump(l, proc.stdout);
	void pump(l, proc.stderr);
	void proc.exited.then(code => finishLogin(l, code));
	await settle(l, 0, LOGIN_START_MS, true);
	const view = parseLoginOutput(l.out);
	if (l.exited || (!view.url && !view.prompt)) {
		killLogin(l, "");
		throw new ControlError("로그인을 시작하지 못했어요. 잠시 후 다시 시도해 주세요", 502);
	}
	return { login_id: l.id, ...view };
}

export function loginStatus(provider: string, loginId: string): { status: Login["status"]; error?: string } {
	const l = loginOf(provider, loginId);
	return { status: l.status, ...(l.error ? { error: l.error } : {}) };
}

// Hands the pasted authorization code (or the full redirect URL, or whatever the sign-in asks for) to the login process
// and waits for it to finish. A multi-step sign-in answers with status "waiting" and the next prompt instead.
export async function completeLogin(provider: string, loginId: string, rawCode: string): Promise<{ provider: string; status: "done" | "waiting" } & Partial<LoginView>> {
	const l = loginOf(provider, loginId);
	if (l.status === "done") return { provider, status: "done" };
	if (l.exited) throw new ControlError(l.error ?? "로그인에 실패했어요", 400);
	const code = rawCode.trim();
	const wantsCode = parseLoginOutput(l.out).needs_code;
	if (wantsCode) {
		if (!code || code.length > 4096 || /[\r\n\0]/.test(code)) throw new ControlError("코드 형식이 올바르지 않아요", 400);
		l.out += "\n";
		const mark = l.out.length;
		l.lastOutAt = Date.now();
		l.proc.stdin.write(`${code}\n`);
		await l.proc.stdin.flush();
		await settle(l, mark, LOGIN_COMPLETE_MS, false);
	} else {
		await settle(l, Number.MAX_SAFE_INTEGER, LOGIN_COMPLETE_MS, false);
	}
	if (l.status === "done") return { provider, status: "done" };
	if (l.exited) throw new ControlError(l.error ?? "로그인에 실패했어요", 400);
	const view = parseLoginOutput(l.out);
	if (view.needs_code && wantsCode) return { provider, status: "waiting", ...view };
	throw new ControlError("아직 로그인이 끝나지 않았어요. 잠시 후 다시 확인해 주세요", 408);
}

export async function cancelLogin(provider: string): Promise<void> {
	if (!login || login.provider !== provider || login.exited) return;
	const l = login;
	killLogin(l, "");
	for (let i = 0; i < 40 && !l.exited; i++) await Bun.sleep(100);
}

export const pendingLogin = (): { provider: string; id: string } | undefined => (login && !login.exited ? { provider: login.provider, id: login.id } : undefined);

// Signs the provider out: removes every credential (login or API key) the runtime stored for it.
export async function logoutProvider(provider: string): Promise<void> {
	if (!PROVIDER_ID.test(provider)) throw new ControlError("알 수 없는 공급자예요", 404);
	invalidate();
	if (!(await authInfos()).some(a => a.provider === provider)) {
		const env = PROVIDER_ENV[provider];
		throw new ControlError(env && process.env[env] ? "환경 설정으로 지정된 키라서 여기서 지울 수 없어요" : "로그인된 계정이 없어요", 404);
	}
	const proc = Bun.spawn([OMP, "auth-broker", "logout", provider], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	if ((await proc.exited) !== 0) throw new ControlError("로그아웃하지 못했어요", 500);
	invalidate();
}

type QuotaLimit = { id: string; label: string; window: string; used: number | null; limit: number | null; remaining: number | null; unit: string; resets_at: number | null; status: string };
// Pure: maps the usage reports to the API shape; providers holding credentials but absent from the reports
// (or reporting no limits) are listed as unavailable with a plain reason.
export function buildQuota(reports: OmpUsageReport[], credentialed: string[]): { providers: { provider: string; account?: string; account_label?: string; limits: QuotaLimit[] }[]; unavailable: { provider: string; reason: string }[] } {
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	const providers = reports
		.filter((r): r is OmpUsageReport & { limits: OmpLimit[] } => Array.isArray(r.limits) && r.limits.length > 0)
		.map(r => ({
			provider: r.provider,
			...(r.account ?? r.metadata?.email ? { account: r.account ?? r.metadata?.email, account_label: label((r.account ?? r.metadata?.email)!) } : {}),
			limits: r.limits.map((l): QuotaLimit => ({
				id: String(l.id), label: String(l.label ?? l.id), window: String(l.window?.id ?? l.window?.label ?? ""),
				used: num(l.amount?.used), limit: num(l.amount?.limit), remaining: num(l.amount?.remaining), unit: String(l.amount?.unit ?? ""),
				resets_at: num(l.window?.resetsAt), status: String(l.status ?? "unknown"),
			})),
		}));
	const reported = new Set(providers.map(p => p.provider));
	const unavailable = credentialed.filter(p => !reported.has(p)).map(provider => ({ provider, reason: "사용량 정보를 제공하지 않아요" }));
	return { providers, unavailable };
}

export async function quota() {
	const rows = (await listProviders(new Set())).providers;
	const anthropic = await anthropicUsage();
	const reports = [...(anthropic ? [anthropic] : []), ...(await usageReports()).filter(r => r.provider !== "anthropic")];
	const org = await orgLimits().catch(() => undefined);
	return { fetched_at: Date.now(), ...buildQuota(reports, rows.filter(r => r.auth !== "none").map(r => r.id)), ...(org ? { org } : {}), ...(runtimeIdOf("orchestrator") === "omo" ? { account: labeledAccountView() } : {}) };
}

// How long a 429 pause lasts. The provider's usage report names the window that ran out and when it resets, so the
// pause ends right after that reset (a spent week waits for the week, not a blind 6h retry). Without a spent window in
// the report, the error's retry-after is used, else 10 minutes. One minute of margin so the first retry lands after it.
const RESUME_MARGIN_MS = 60_000;
const RESUME_MAX_MS = 8 * 24 * 3600_000;
// OmO's account pool, when every account is blocked, names the time the first one frees: "Soonest automatic retry: 2026-10-19T16:40:00.000Z."
export function poolRetryAt(err: string): number | undefined {
	const t = Date.parse(err.match(/automatic retry:\s*(\d{4}-\d\d-\d\dT[\d:.]+Z)/i)?.[1] ?? "");
	return Number.isFinite(t) ? t : undefined;
}
export function resumeDelay(err: string, limits: QuotaLimit[], at: number): { ms: number; reset: boolean } {
	// That time is the reset: OmO tracks each account's block itself, a usage report would only add a guess.
	const pool = poolRetryAt(err);
	if (pool !== undefined && pool > at) return { ms: Math.min(pool - at, RESUME_MAX_MS) + RESUME_MARGIN_MS, reset: true };
	const resets = limits
		.filter(l => (l.remaining !== null && l.remaining <= 0) || (l.used !== null && l.limit !== null && l.used >= l.limit) || /exhaust|exceed|blocked/i.test(l.status))
		.flatMap(l => (l.resets_at !== null && l.resets_at > at ? [l.resets_at] : []));
	const hint = Number(err.match(/retry-after-ms:\s*(\d+)/)?.[1] ?? Number.NaN);
	const base = resets.length ? Math.max(...resets) - at : Number.isFinite(hint) ? hint : 10 * 60_000;
	return { ms: Math.min(base, RESUME_MAX_MS) + RESUME_MARGIN_MS, reset: resets.length > 0 };
}
export async function rateLimitDelay(err: string, model: string, role: "orchestrator" | "lane" = "orchestrator"): Promise<{ ms: number; reset: boolean }> {
	if ((poolRetryAt(err) ?? 0) > Date.now()) return resumeDelay(err, [], Date.now());
	const provider = model.split("/")[0];
	invalidate();
	// Anthropic: the account the role runs on, which may not be omp's login
	const reports = provider === "anthropic" ? [await anthropicUsage(role, true).catch(() => undefined)].filter(r => r !== undefined) : await usageReports().catch(() => []);
	const limits = buildQuota(reports, []).providers.find(p => p.provider === provider)?.limits ?? [];
	return resumeDelay(err, limits, Date.now());
}

// What a failed model turn means: "rate" = a usage limit (pause until the
// window resets, rateLimitDelay); "owner" = credit/billing exhausted or auth rejected (only the owner can fix it, so the
// pause is a slow probe and the owner is told once); "transient" = overloaded/5xx/network (retry with backoff). Owner is
// checked first because some billing errors arrive as a 429 (insufficient_quota). Patterns are checked against the
// error rows of real OmO and omp sessions (~/.omo/agent/sessions): a failed OAuth refresh, a disabled provider and a model
// the account cannot use are owner problems; WebSocket/SSE stream breaks are transient.
export type ProviderErrorKind = "rate" | "owner" | "transient";
const OWNER_ERR_RE = /credit balance|provider is (?:not configured|disabled)|insufficient[_ ]?(?:quota|funds|credits?)|out of credits|requires more credits|billing|payment required|\b402\b|exceeded your current quota|\b401\b|\b403\b|unauthorized|forbidden|authentication[_ ]error|invalid[_ ]?api[_ ]?key|invalid x-api-key|no api key|oauth token|oauth refresh failed|token (?:has )?(?:expired|been revoked)|not logged in|\/login|not a valid model id|model is not supported when using/i;
const RATE_ERR_RE = /429|rate_limit|usage limit|session limit/i;
// OmO's account pool when every subscription account is out (the 5h/weekly limit as OmO reports it). Checked before the
// owner patterns: the message also names "/login" as a way to add another account.
const POOL_BLOCKED_RE = /accounts? for [\w-]+ (?:are|is) currently blocked \(rate limit|no credential slots available/i;
const TRANSIENT_ERR_RE = /overloaded|\b5(?:00|02|03|04|29)\b|server error|internal error|bad gateway|service unavailable|gateway time-?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up|other side closed|connection (?:error|reset|closed|lost|ended)|websocket (?:error|closed)|error injected into sse stream|timed? ?out|terminated/i;
export function classifyProviderError(err: string): ProviderErrorKind | undefined {
	if (POOL_BLOCKED_RE.test(err)) return "rate";
	if (OWNER_ERR_RE.test(err)) return "owner";
	if (RATE_ERR_RE.test(err)) return "rate";
	if (TRANSIENT_ERR_RE.test(err)) return "transient";
	return undefined;
}

// Transient errors are retried TRANSIENT_RETRIES times at 5s, 15s, 45s, 135s (DOTZ_RETRY_BASE_MS scales it); an owner
// problem is probed every 30 minutes (DOTZ_OWNER_RETRY_MS) until a turn succeeds.
export const TRANSIENT_RETRIES = 4;
export const transientBackoff = (attempt: number): number => Number(process.env.DOTZ_RETRY_BASE_MS ?? 5000) * 3 ** attempt;
export const OWNER_RETRY_MS = Number(process.env.DOTZ_OWNER_RETRY_MS ?? 30 * 60_000);
