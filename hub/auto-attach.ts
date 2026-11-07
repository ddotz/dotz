// One install's own rules for the files of automatic mail drafts: <DATA_DIR>/custom/reply-drafts/auto-attach.json, read here and written by hand or by that
// install's bot. No file means no rule. The file stays apart from config.json because saveSettings only keeps the keys it knows.
//   withhold   patterns over a file's path in the 첨부 파일 폴더: a matching file is never picked by keywords when a mail is composed (it can still be attached by hand)
//   fileWords  extra words that name a document in a mail ("... 부탁드립니다", "... 보내드립니다"), next to the built-in ones of hub/attach-check.ts and hub/draft-approval.ts
//   narrow     when the request holds one of `when`, only files matching `only` of one work are picked, or none and `note`
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AutoAttach = { withhold: RegExp[]; fileWords: string[]; narrow?: { when: string[]; only: RegExp; note?: string }; /** Why the file cannot be used: nothing is picked from the library until it is fixed. */ error?: string };

const NONE: AutoAttach = { withhold: [], fileWords: [] };
const words = (v: unknown, key: string): string[] => {
	if (v === undefined) return [];
	if (!Array.isArray(v) || v.some(x => typeof x !== "string" || !x.trim())) throw new Error(`${key}는 글자 목록이어야 해요`);
	return v;
};
const pattern = (v: unknown, key: string): RegExp => {
	if (typeof v !== "string" || !v) throw new Error(`${key}는 글자여야 해요`);
	return new RegExp(v.normalize("NFC"), "i");
};
const unknown = (raw: object, known: string[], where: string): void => {
	const key = Object.keys(raw).find(k => !known.includes(k));
	if (key) throw new Error(`${where}${key}는 모르는 항목이에요`);
};
function parse(text: string): AutoAttach {
	const raw = JSON.parse(text) as { withhold?: unknown; fileWords?: unknown; narrow?: { when?: unknown; only?: unknown; note?: unknown } } | null;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("JSON 객체여야 해요");
	unknown(raw, ["withhold", "fileWords", "narrow"], "");
	if (raw.narrow !== undefined && (!raw.narrow || typeof raw.narrow !== "object")) throw new Error("narrow는 JSON 객체여야 해요");
	if (raw.narrow) unknown(raw.narrow, ["when", "only", "note"], "narrow.");
	const when = raw.narrow ? words(raw.narrow.when, "narrow.when") : [];
	if (raw.narrow && !when.length) throw new Error("narrow.when이 비어 있어요");
	return {
		withhold: words(raw.withhold, "withhold").map(p => pattern(p, "withhold")),
		fileWords: words(raw.fileWords, "fileWords"),
		...(raw.narrow ? { narrow: { when: when.map(w => w.toLowerCase()), only: pattern(raw.narrow.only, "narrow.only"), ...(typeof raw.narrow.note === "string" && raw.narrow.note ? { note: raw.narrow.note } : {}) } } : {}),
	};
}

let cache: { key: string; rules: AutoAttach } | undefined;
/** Runs on every card read and draft check: one stat, and a parse only after the file changed. */
export function autoAttach(): AutoAttach {
	const file = join(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "custom", "reply-drafts", "auto-attach.json");
	try {
		const stat = statSync(file, { throwIfNoEntry: false });
		if (!stat) return NONE;
		const key = `${file}:${stat.mtimeMs}:${stat.size}`;
		if (cache?.key === key) return cache.rules;
		let rules: AutoAttach;
		try {
			rules = parse(readFileSync(file, "utf8"));
		} catch (e) {
			rules = { ...NONE, error: (e as Error).message };
		}
		cache = { key, rules };
		return rules;
	} catch (e) {
		return { ...NONE, error: (e as Error).message };
	}
}

/** `build` over the install's file words as a regex alternative ("" or "|word|word"), run again only when the words change. */
export function withFileWords<T>(build: (extra: string) => T): () => T {
	let seen: string | undefined;
	let made: T;
	return () => {
		const extra = autoAttach().fileWords.map(w => `|${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).join("");
		if (extra !== seen) {
			seen = extra;
			made = build(extra);
		}
		return made;
	};
}
