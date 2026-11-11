// One install's own rules for the files of automatic mail drafts: <DATA_DIR>/custom/reply-drafts/auto-attach.json, read here and written by hand or by that
// install's bot. No file means no rule. The file stays apart from config.json because saveSettings only keeps the keys it knows.
//   withhold   patterns over a file's path in the 첨부 파일 폴더: a matching file is never picked by keywords when a mail is composed (it can still be attached by hand)
//   fileWords  extra words that name a document in a mail ("... 부탁드립니다", "... 보내드립니다"), next to the built-in ones of hub/attach-check.ts and hub/draft-approval.ts
//   audioWords the same for sound files. A Latin word in either list matches as a whole word
//   noiseWords words in a file name that tie the file to no work, for the 첨부 확인 line
//   genericWords words that never rank a file of the library by themselves
//   narrow     when the request holds one of `when`, only files matching `only` of one work are picked, or none and `note`
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AutoAttach = { withhold: RegExp[]; fileWords: string[]; audioWords: string[]; noiseWords: string[]; genericWords: string[]; narrow?: { when: string[]; only: RegExp; note?: string }; /** Why the file cannot be used: nothing is picked from the library until it is fixed. */ error?: string };

const NONE: AutoAttach = { withhold: [], fileWords: [], audioWords: [], noiseWords: [], genericWords: [] };
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
	const raw = JSON.parse(text) as { withhold?: unknown; fileWords?: unknown; audioWords?: unknown; noiseWords?: unknown; genericWords?: unknown; narrow?: { when?: unknown; only?: unknown; note?: unknown } } | null;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("JSON 객체여야 해요");
	unknown(raw, ["withhold", "fileWords", "audioWords", "noiseWords", "genericWords", "narrow"], "");
	if (raw.narrow !== undefined && (!raw.narrow || typeof raw.narrow !== "object")) throw new Error("narrow는 JSON 객체여야 해요");
	if (raw.narrow) unknown(raw.narrow, ["when", "only", "note"], "narrow.");
	const when = raw.narrow ? words(raw.narrow.when, "narrow.when") : [];
	if (raw.narrow && !when.length) throw new Error("narrow.when이 비어 있어요");
	return {
		withhold: words(raw.withhold, "withhold").map(p => pattern(p, "withhold")),
		fileWords: words(raw.fileWords, "fileWords"),
		audioWords: words(raw.audioWords, "audioWords"),
		noiseWords: words(raw.noiseWords, "noiseWords"),
		genericWords: words(raw.genericWords, "genericWords").map(w => w.normalize("NFC").toLowerCase()),
		...(raw.narrow ? { narrow: { when: when.map(w => w.normalize("NFC").toLowerCase()), only: pattern(raw.narrow.only, "narrow.only"), ...(typeof raw.narrow.note === "string" && raw.narrow.note ? { note: raw.narrow.note } : {}) } } : {}),
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

const LATIN = /^[A-Za-z ]+$/;
const escaped = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternatives = (list: string[]): string => list.map(w => {
	if (!LATIN.test(w)) return `|${escaped(w)}`;
	// Two letters may be an abbreviation: "Mr. Kim" names no file.
	return `|(?<![A-Za-z])${escaped(w)}(?![A-Za-z]${w.length <= 2 ? "|\\.\\s" : ""})`;
}).join("");
export type ExtraWords = { document: string; audio: string; noise: string; /** The Latin words of fileWords as bare alternatives, for an English pattern that takes a plural. */ english: string };
/** `build` over the install's words as regex alternatives ("" or "|word|word"), run again only when the words change. */
export function withFileWords<T>(build: (extra: ExtraWords) => T): () => T {
	let seen: string | undefined;
	let made: T;
	return () => {
		const r = autoAttach();
		const extra = { document: alternatives(r.fileWords), audio: alternatives(r.audioWords), noise: alternatives(r.noiseWords), english: r.fileWords.filter(w => LATIN.test(w)).map(w => `|${escaped(w)}`).join("") };
		const key = JSON.stringify(extra);
		if (key !== seen) {
			seen = key;
			made = build(extra);
		}
		return made;
	};
}
