// Side-effect-free language helpers shared by the gateway (hub/i18n.ts) and the setup wizard (setup.ts).
// The language of an identity is a BCP-47-ish code ("ko", "en", "ja", "pt-BR", ...).

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/;
const KANA = /[\u3040-\u30FF\u31F0-\u31FF]/;
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/;

// Language implied by the script of a text: Hangul -> ko, kana -> ja, Han only -> zh; undefined for anything else.
export function scriptLanguage(text: string): string | undefined {
	if (HANGUL.test(text)) return "ko";
	if (KANA.test(text)) return "ja";
	if (HAN.test(text)) return "zh";
}

// Primary subtag of the system locale (Intl, else LC_ALL/LC_MESSAGES/LANG), undefined when none is usable.
export function systemLanguage(): string | undefined {
	const candidates = [Intl.DateTimeFormat().resolvedOptions().locale, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG];
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
