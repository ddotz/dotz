// An install's own rule (config guard.no_api_key_accounts, none by default): while OmO's Claude subscription login is pinned to one of
// these accounts (one whose tokens are not the owner's own), nothing dotz starts may bill an API key. OmO pins the account in
// <agent dir>/auth.json ("anthropic-subscription".pinned); while it names one of these accounts every API-key fallback entry
// is down (hub/fallback.ts), no key reaches a process, and API-key variables are stripped from what dotz spawns, so the
// Claude binary under OmO's subscription provider cannot pick a key up from the environment either.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rolesOn } from "./runtime/runtime-id.ts";

/** omp provider id -> the env var omp reads its API key from (omp docs: providers.md, "Environment variables"). */
export const PROVIDER_ENV: Record<string, string> = {
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

const KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY", "DOTZ_KEY_PROVIDER", "DOTZ_KEY_VALUE", "DOTZ_KEY_FILE", "DOTZ_KEY_WORKERS"];
export const authFile = () => join(process.env.OMO_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".omo", "agent"), "auth.json");

let cache: { file: string; stamp: string; pinned?: string } | undefined;
// The pinned subscription account, re-read when auth.json changes. A missing or unreadable file reads as no pin.
function pinnedAccount(): string | undefined {
	const file = authFile();
	let stamp: string;
	try {
		const st = statSync(file);
		stamp = `${st.mtimeMs}:${st.size}`;
	} catch {
		return undefined;
	}
	if (cache?.file === file && cache.stamp === stamp) return cache.pinned;
	let pinned: string | undefined;
	try {
		const p = JSON.parse(readFileSync(file, "utf8"))?.["anthropic-subscription"]?.pinned;
		pinned = typeof p === "string" ? p : undefined;
	} catch {}
	cache = { file, stamp, pinned };
	return pinned;
}

// A temporary lift: <DOTZ_DIR>/api-allow-while-pinned
// holds an expiry in epoch seconds. Before it a pinned account does not ban API keys; at it the ban applies again by
// itself. Removing the file ends the lift at once.
export const allowFile = () => join(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "api-allow-while-pinned");
function liftedUntil(): number | undefined {
	try {
		const ms = Number(readFileSync(allowFile(), "utf8").trim()) * 1000;
		return ms > Date.now() ? ms : undefined;
	} catch {
		return undefined;
	}
}

// API keys are off unless <DOTZ_DIR>/config.json sets guard.allow_api_key to true (owner 2026-10-22: "api로 넘어가지마라";
// a subscription limit moves to another subscription account, never to a key). 2026-10-28 22:20 KST an API-key fallback entry
// left on moved the orchestrator onto the key. A missing, unreadable or non-true value keeps keys off (fail closed).
export const API_KEY_OFF = "guard.allow_api_key";

// The accounts named in <DOTZ_DIR>/config.json guard.no_api_key_accounts and the guard.allow_api_key switch, re-read when the
// file changes. Read from the file itself (not config.ts) so any process that spawns agents applies the same rule. Missing,
// unreadable or not a list of strings: no account named, keys off.
let banCache: { file: string; stamp: string; names: Set<string>; allow: boolean } | undefined;
function guardRules(): { names: Set<string>; allow: boolean } {
	const file = join(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "config.json");
	let stamp: string;
	try {
		const st = statSync(file);
		stamp = `${st.mtimeMs}:${st.size}`;
	} catch {
		return { names: new Set(), allow: false };
	}
	if (banCache?.file === file && banCache.stamp === stamp) return banCache;
	let names = new Set<string>();
	let allow = false;
	try {
		const guard = JSON.parse(readFileSync(file, "utf8"))?.guard;
		const v = guard?.no_api_key_accounts;
		if (Array.isArray(v)) names = new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0));
		allow = guard?.allow_api_key === true;
	} catch {}
	banCache = { file, stamp, names, allow };
	return banCache;
}

function forbiddingAccount(names: Set<string>): string | undefined {
	// why(vendor): omp@18.22.0 has no flag, env var or RPC command that picks a process's Claude account (providers.md "Credentials and precedence"), so with a role on omp any named account may be the one it runs on
	if (rolesOn("omp")) return [...names][0];
	const a = pinnedAccount();
	return a && names.has(a) ? a : undefined;
}

// What forbids API keys right now: API_KEY_OFF while keys are off, else the pinned account that forbids them, or undefined
// when keys are allowed. The lift file only lifts the account pin, never API_KEY_OFF.
export function apiKeyBan(): string | undefined {
	const rules = guardRules();
	if (!rules.allow) return API_KEY_OFF;
	const a = forbiddingAccount(rules.names);
	return a && !liftedUntil() ? a : undefined;
}

// `env` without API-key variables while the ban holds (unchanged otherwise).
export function withoutApiKeys<T extends Record<string, string | undefined>>(env: T): T {
	if (!apiKeyBan()) return env;
	const out = { ...env };
	for (const k of KEY_VARS) delete out[k];
	return out;
}
