// The owner's hard rule (2026-10-20): while OmO's Claude subscription login is pinned to an account whose tokens are not
// his own (miseol-shared, 미설's), nothing dotz starts may bill an API key. OmO pins the account in
// <agent dir>/auth.json ("anthropic-subscription".pinned); while it names one of these accounts every API-key fallback entry
// is down (hub/fallback.ts), no key reaches a process, and API-key variables are stripped from what dotz spawns, so the
// Claude binary under OmO's subscription provider cannot pick a key up from the environment either.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NO_API_KEY_ACCOUNTS = new Set(["miseol-shared"]);
const KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY", "DOTZ_KEY_PROVIDER", "DOTZ_KEY_VALUE"];
const authFile = () => join(process.env.OMO_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".omo", "agent"), "auth.json");

let cache: { file: string; stamp: string; pinned?: string } | undefined;
// The pinned subscription account, re-read when auth.json changes. A missing or unreadable file reads as no pin.
export function pinnedAccount(): string | undefined {
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

// The owner's temporary lift (2026-10-20, "api폴백은 임시로 바로 사용 가능하게 풀고 진행해"): <DOTZ_DIR>/api-allow-while-pinned
// holds an expiry in epoch seconds. Before it a pinned account does not ban API keys; at it the ban applies again by
// itself. Removing the file ends the lift at once.
export const allowFile = () => join(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "api-allow-while-pinned");
export function liftedUntil(): number | undefined {
	try {
		const ms = Number(readFileSync(allowFile(), "utf8").trim()) * 1000;
		return ms > Date.now() ? ms : undefined;
	} catch {
		return undefined;
	}
}

// The pinned account that forbids API keys right now, or undefined when keys are allowed.
export function apiKeyBan(): string | undefined {
	const a = pinnedAccount();
	return a && NO_API_KEY_ACCOUNTS.has(a) && !liftedUntil() ? a : undefined;
}

// `env` without API-key variables while the ban holds (unchanged otherwise).
export function withoutApiKeys<T extends Record<string, string | undefined>>(env: T): T {
	if (!apiKeyBan()) return env;
	const out = { ...env };
	for (const k of KEY_VARS) delete out[k];
	return out;
}
