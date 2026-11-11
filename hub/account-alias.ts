// Owner-given names for the Claude subscription accounts (owner 2026-10-21: "계정명도 지금은 영어로 나오는데 사용자가 alias
// 처리 가능하게"). <DATA_DIR>/accounts/aliases.json maps an OmO slot id (auth.json "anthropic-subscription".accounts[].name)
// or an email to a display name: {"default": "개인 계정", "work@example.com": "회사 계정"}. Every place that shows an account
// shows label(); the raw id goes on a detail line only. Read on each call (a small file the owner edits by hand or from 설정).
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";

export const accountsDir = () => join(DATA_DIR, "accounts");
export const aliasesFile = () => join(accountsDir(), "aliases.json");

export function readAliases(file = aliasesFile()): Record<string, string> {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "").map(([k, v]) => [k, v.trim()]));
	} catch {
		return {};
	}
}

// One alias set or cleared (empty text clears it).
export function setAlias(key: string, alias: string, file = aliasesFile()): Record<string, string> {
	const next = readAliases(file);
	if (alias.trim()) next[key] = alias.trim();
	else delete next[key];
	mkdirSync(dirname(file), { recursive: true });
	writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

// The display name: the alias of the slot id, else of the email, else the raw id.
export function aliasOf(name: string, email?: string, aliases = readAliases()): string | undefined {
	return aliases[name] ?? (email ? aliases[email] : undefined);
}
export const label = (name: string, email?: string, aliases = readAliases()): string => aliasOf(name, email, aliases) ?? name;

// An account named by the owner or a script: a slot id, an alias (exact, case- and space-insensitive), or an email alias key.
export function resolveAccount(text: string, names: string[], aliases = readAliases()): string | undefined {
	const t = text.trim();
	if (!t) return undefined;
	if (names.includes(t)) return t;
	const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
	const hit = Object.entries(aliases).find(([, a]) => norm(a) === norm(t));
	return hit && names.includes(hit[0]) ? hit[0] : undefined;
}
