// Side-effect-free language helpers shared by the gateway (hub/i18n.ts) and the setup wizard (setup.ts).
// The language of an identity is a BCP-47-ish code ("ko", "en", "ja", "pt-BR", ...).

import { spawnSync } from "node:child_process";

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/;
const KANA = /[\u3040-\u30FF\u31F0-\u31FF]/;
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/;

// Language implied by the script of a text: Hangul -> ko, kana -> ja, Han only -> zh; undefined for anything else.
function scriptLanguage(text: string): string | undefined {
	if (HANGUL.test(text)) return "ko";
	if (KANA.test(text)) return "ja";
	if (HAN.test(text)) return "zh";
}

// The macOS language list (`defaults read -g AppleLanguages`), read once: bun reports en-US on a Korean Mac whatever that list says.
let appleList: string | undefined | null = null;
function readAppleLanguages(): string | undefined {
	if (appleList !== null || process.platform !== "darwin") return appleList ?? undefined;
	const r = spawnSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
	appleList = r.status === 0 ? r.stdout : undefined;
	return appleList;
}

// Primary subtag of the system language (macOS language list, else Intl, else LC_ALL/LC_MESSAGES/LANG), undefined when none is usable.
export function systemLanguage(appleLanguages: () => string | undefined = readAppleLanguages): string | undefined {
	const candidates = [appleLanguages()?.match(/^\s*"?([A-Za-z]{2,3})\b/m)?.[1], Intl.DateTimeFormat().resolvedOptions().locale, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG];
	for (const c of candidates) {
		const primary = c?.split(/[.@]/)[0].split(/[-_]/)[0].toLowerCase();
		if (primary && /^[a-z]{2,3}$/.test(primary) && primary !== "c") return primary;
	}
}

// Script of the text, else the system locale, else English.
export const detectLanguage = (text: string): string => scriptLanguage(text) ?? systemLanguage() ?? "en";

// Primary subtag, lower-cased ("pt-BR" -> "pt").
export const baseLanguage = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0] || "en";

// English name of a language code ("ja" -> "Japanese"); the code itself when Intl does not know it.
export function languageName(code: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}
