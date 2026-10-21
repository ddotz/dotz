// Language of the instructions the gateway sends to its agents (orchestrator and lanes). The language is the identity's
// (config.json identity.language, set by setup; detected from the identity text when unset). English and Korean have
// originals below; any other language gets the English text plus one "Reply to the owner in <language>" line per prompt
// that carries instructions. Bracket tags ([dotz gateway], [handover], [dotz lane <name>], [dotz inbox]) stay literal.
//
// Notes the gateway recognises again later (by prefix) have a `lead` in every language; `isNote` matches against all of
// them, so a language change mid-session (or a pending.json written under another language) still matches.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, IDENTITY_FILE } from "./config.ts";
import { baseLanguage, detectLanguage, languageName } from "./language.ts";
import { en, type Catalog, type Leads } from "./i18n-en.ts";
import { ko } from "./i18n-ko.ts";

export type LaneFooterArgs = { lane: string; mode: string; workerModel: string; slots: number; worktree: string };
export type WorktreeArgs = { path: string; repo: string; branch: string; base: string };
export type RecallArgs = { mode: string; identity: string; rules: string; lessons: string; memory: string; setups: string; state: string };
export type SettingText = { label: string; hint?: string; unit?: string; options?: Record<string, string> };
export type FileText = { label: string; note: string };
export type HelpText = { title: string; groups: { label: string; items: [command: string, text: string][] }[]; note: string };

export const CATALOGS: Record<string, Catalog> = { en, ko };

// Everything detection needs is read at call time; the result is cached per identity text + IDENTITY.md mtime.
let detected: { key: string; code: string } | undefined;
function detectedLanguage(): string {
	const id = (cfg.identity ?? {}) as Record<string, unknown>;
	const text = Object.entries(id).filter(([k, v]) => !["name", "avatar", "language"].includes(k) && typeof v === "string").map(([, v]) => v as string).join("\n");
	const stamp = existsSync(IDENTITY_FILE) ? statSync(IDENTITY_FILE).mtimeMs : 0;
	const key = `${text}|${stamp}`;
	if (detected?.key === key) return detected.code;
	// IDENTITY.md has boilerplate in several languages; it only decides when config.json holds no identity text.
	const code = detectLanguage(text.trim() || !stamp ? text : readFileSync(IDENTITY_FILE, "utf8"));
	detected = { key, code };
	return code;
}

// The identity's language code: identity.language when set, else detected (see hub/language.ts).
export const lang = (): string => cfg.identity?.language?.trim() || detectedLanguage();

// Catalog in the identity's language; English for a language without originals.
export const msg = (): Catalog => CATALOGS[baseLanguage(lang())] ?? en;

// The reply-language line for a prompt that carries instructions; empty when the instructions are already in that language.
function replyLine(): string {
	const code = lang();
	return baseLanguage(code) in CATALOGS ? "" : `Reply to the owner in ${languageName(code)} (${code}).`;
}
export const withReplyLine = (text: string): string => {
	const line = replyLine();
	return line ? `${text}\n\n${line}` : text;
};

// Does `text` start with the lead `key` names, in any language?
export const isNote = (text: string, key: keyof Leads): boolean =>
	Object.values(CATALOGS).some(c => text.startsWith(c[key]));

// The MODE contract in the identity's language: $DOTZ_DIR/MODE.<l>.md, repo MODE.<l>.md, then the English chain.
export function modeFile(): string {
	const repo = join(import.meta.dir, "..");
	const base = baseLanguage(lang());
	const chain = [...(base === "en" ? [] : [join(DATA_DIR, `MODE.${base}.md`), join(repo, `MODE.${base}.md`)]), join(DATA_DIR, "MODE.md"), join(repo, "MODE.md")];
	return chain.find(existsSync) ?? chain[chain.length - 1];
}
