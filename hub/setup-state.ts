import { existsSync } from "node:fs";
import { join } from "node:path";
import { harness } from "../onboard/harness.ts";
import { SNOWFLAKE } from "../onboard/answers.ts";
import { peerTokenFile, tokenFile, writeSecret } from "../onboard/apply.ts";
import { en } from "./i18n-en.ts";
import { ko } from "./i18n-ko.ts";
import { baseLanguage, detectLanguage } from "./language.ts";
import type { SetupText } from "./setup-jobs.ts";

// What the owner may put in the draft and which secrets the web may write. Both are fixed lists: the draft takes only the fields below, checked here,
// and a secret is accepted only under one of the two names (the value goes to secrets/ with 0600 and is never echoed back).

export const SECRET_NAMES = ["discord-bot-token", "peer-token"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const STRING_FIELDS = ["lang", "runtime", "name", "character", "tone", "notices", "address", "avatar", "guild", "owner_id", "machine_name", "orchestrator_model", "lane_model"] as const;
const PORT_FIELDS = ["web_port", "tailscale_https_port"] as const;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export const setupText = (lang: string): SetupText => (baseLanguage(lang) === "ko" ? ko : en).setup;
export const draftLang = (draft: Record<string, unknown>): string => (typeof draft.lang === "string" && LANG.test(draft.lang) ? draft.lang : detectLanguage(""));

/** The values of one PUT /api/setup/draft: only the fixed fields, each checked; undefined when one is wrong. */
export function parseDraft(values: unknown): Record<string, unknown> | undefined {
	if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
	const v = values as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of STRING_FIELDS) {
		if (v[k] === undefined) continue;
		if (typeof v[k] !== "string" || (v[k] as string).length > 1000) return undefined;
		out[k] = (v[k] as string).trim();
	}
	for (const k of PORT_FIELDS) {
		if (v[k] === undefined) continue;
		if (!Number.isInteger(v[k]) || (v[k] as number) < 1 || (v[k] as number) > 65535) return undefined;
		out[k] = v[k];
	}
	if (v.allow_logins !== undefined) {
		if (!Array.isArray(v.allow_logins) || v.allow_logins.length > 20 || v.allow_logins.some(x => typeof x !== "string" || x.length > 200)) return undefined;
		out.allow_logins = v.allow_logins.map(x => (x as string).trim()).filter(Boolean);
	}
	const bad = (out.name !== undefined && out.name !== "" && ((out.name as string).length < 2 || (out.name as string).length > 32)) || (typeof out.lang === "string" && out.lang !== "" && !LANG.test(out.lang)) || (typeof out.guild === "string" && out.guild !== "" && !SNOWFLAKE.test(out.guild)) || (typeof out.owner_id === "string" && out.owner_id !== "" && !SNOWFLAKE.test(out.owner_id)) || (typeof out.runtime === "string" && out.runtime !== "" && !harness(out.runtime)?.adapter);
	return bad ? undefined : out;
}

const BOT_TOKEN = /^[A-Za-z0-9._-]{20,200}$/;

/** Writes one secret under its fixed name; false when the name or the value is not acceptable. */
export function saveSecret(dir: string, name: unknown, value: unknown): SecretName | undefined {
	if (typeof name !== "string" || !SECRET_NAMES.includes(name as SecretName) || typeof value !== "string") return undefined;
	const v = value.trim();
	if (name === "discord-bot-token" ? !BOT_TOKEN.test(v) : v.length < 16 || v.length > 500 || /\s/.test(v)) return undefined;
	writeSecret(name === "discord-bot-token" ? tokenFile(dir) : peerTokenFile(dir), v);
	return name as SecretName;
}

export const savedSecrets = (dir: string): Record<SecretName, boolean> => ({ "discord-bot-token": existsSync(tokenFile(dir)), "peer-token": existsSync(join(dir, "secrets", "peer-token")) });
