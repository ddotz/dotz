// API keys entered in the settings (owner 2026-10-20: "키를 바로 입력하는게 아니라 무슨 파일명 입력하라는데 키 입력으로 바꿔"):
// the owner pastes the key itself. It is format-checked, tried once against the provider's model list (a wrong key is told
// at once, not at the next failover), and stored as <data dir>/secrets/<provider>-api-key, the file a fallback entry's
// key_file names (hub/fallback.ts), mode 600 with the previous file kept as .bak. The key is never returned, logged or
// written anywhere else; views show only its prefix and last 4 characters.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomic } from "./config.ts";
import { authFile } from "./apikey-policy.ts";
import { keyPath } from "./fallback.ts";
import { ControlError } from "./providers.ts";

type Check = { url: string; headers: (key: string) => Record<string, string> };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const KEY_PROVIDERS: Record<string, { format: RegExp; check: Check }> = {
	anthropic: { format: /^sk-ant-[\w-]{20,}$/, check: { url: "https://api.anthropic.com/v1/models?limit=1", headers: key => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }) } },
	openai: { format: /^sk-[\w-]{20,}$/, check: { url: "https://api.openai.com/v1/models", headers: bearer } },
	openrouter: { format: /^sk-or-[\w-]{20,}$/, check: { url: "https://openrouter.ai/api/v1/key", headers: bearer } },
};
const keyFileFor = (provider: string) => `${provider}-api-key`;
const maskKey = (key: string) => `${key.match(/^sk-(?:ant-|or-)?/)?.[0] ?? ""}…${key.slice(-4)}`;

function providerOf(provider: string) {
	const p = KEY_PROVIDERS[provider];
	if (!p) throw new ControlError(`API 키는 ${Object.keys(KEY_PROVIDERS).join(", ")} 모델에만 쓸 수 있어요`);
	return p;
}
const stored = (provider: string) => {
	const file = keyPath(keyFileFor(provider));
	return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
};
const omoKey = (): string => {
	try {
		const k = JSON.parse(readFileSync(authFile(), "utf8"))?.anthropic?.key;
		return typeof k === "string" ? k.trim() : "";
	} catch {
		return "";
	}
};

// One cheap request with the key: 200 = good; 401/403 = a wrong key; anything else = could not tell (nothing is stored).
async function check(provider: string, key: string, fetchImpl: typeof fetch): Promise<void> {
	const { url, headers } = providerOf(provider).check;
	let r: Response;
	try {
		r = await fetchImpl(url, { headers: headers(key), signal: AbortSignal.timeout(15_000) });
	} catch (e) {
		throw new ControlError(`키를 확인하지 못했어요 (${(e as Error).name}). 잠시 뒤 다시 해 주세요.`, 502);
	}
	if (r.status === 401 || r.status === 403) throw new ControlError(`키가 맞지 않아요 (${r.status}). 키를 다시 복사해 붙여 넣어 주세요.`);
	if (!r.ok) throw new ControlError(`키를 확인하지 못했어요 (HTTP ${r.status}). 잠시 뒤 다시 해 주세요.`, 502);
}

export async function saveKey(provider: string, raw: string, fetchImpl: typeof fetch = fetch): Promise<{ provider: string; file: string; masked: string }> {
	const p = providerOf(provider);
	const key = raw.replace(/\s+/g, "");
	if (!p.format.test(key)) throw new ControlError(`${provider} API 키 형식이 아니에요 (${provider === "anthropic" ? "sk-ant-" : provider === "openrouter" ? "sk-or-" : "sk-"}로 시작해요)`);
	await check(provider, key, fetchImpl);
	const file = keyPath(keyFileFor(provider));
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	if (existsSync(file)) {
		copyFileSync(file, `${file}.bak`);
		chmodSync(`${file}.bak`, 0o600);
	}
	writeAtomic(file, `${key}\n`, 0o600);
	chmodSync(file, 0o600);
	return { provider, file: keyFileFor(provider), masked: maskKey(key) };
}

// The Anthropic key OmO already has (<agent dir>/auth.json "anthropic"), stored for dotz after the same check.
export async function importOmoKey(fetchImpl: typeof fetch = fetch) {
	const key = omoKey();
	if (!key) throw new ControlError("OmO에 저장된 Anthropic API 키가 없어요");
	return saveKey("anthropic", key, fetchImpl);
}

// Removes the stored key; the file is kept as .bak (the previous .bak is replaced).
export function deleteKey(provider: string): { provider: string; deleted: boolean } {
	providerOf(provider);
	const file = keyPath(keyFileFor(provider));
	if (!existsSync(file)) return { provider, deleted: false };
	renameSync(file, `${file}.bak`);
	return { provider, deleted: true };
}

export function keysView() {
	return {
		providers: Object.keys(KEY_PROVIDERS).map(provider => {
			const key = stored(provider);
			return { provider, file: keyFileFor(provider), present: Boolean(key), ...(key ? { masked: maskKey(key) } : {}) };
		}),
		omo_anthropic: KEY_PROVIDERS.anthropic.format.test(omoKey()),
	};
}
