// The owner's word list (<DATA_DIR>/custom/words.json): words that must not reach the owner, each with the wording to use instead.
// Off by default: no file, an empty list or a file that does not parse changes nothing. Pure: it reads the file when asked and writes nothing.
// It does not import config.ts (that reads and creates things at import); the data dir is a parameter that defaults to the same place.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BannedHit = { word: string; use?: string };
// `at: "start"`: the word counts only where the text opens (after a status tag such as [done]), e.g. an address the owner does not want as the first word.
type Entry = BannedHit & { re: RegExp };

const defaultDir = (): string => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
export const wordsFile = (dataDir: string = defaultDir()): string => join(dataDir, "custom", "words.json");

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A space in the word matches any run of whitespace, including none.
const STATUS = "^\\s*(?:\\[[^\\]\n]{1,12}\\]\\s*)?";
const compile = (word: string, start: boolean): RegExp => new RegExp((start ? STATUS : "") + word.split(/\s+/).map(escape).join("\\s*"), "iu");

const cache = new Map<string, { mtimeMs: number; entries: Entry[] }>();

function load(dataDir: string): Entry[] {
	const file = wordsFile(dataDir);
	let mtimeMs: number;
	try {
		if (!existsSync(file)) {
			cache.delete(file);
			return [];
		}
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		return [];
	}
	const hit = cache.get(file);
	if (hit && hit.mtimeMs === mtimeMs) return hit.entries;
	let entries: Entry[] = [];
	try {
		const words = (JSON.parse(readFileSync(file, "utf8")) as { words?: unknown }).words;
		if (Array.isArray(words)) {
			for (const w of words) {
				const word = typeof w?.word === "string" ? w.word.trim() : "";
				if (!word) continue;
				entries.push({ word, ...(typeof w.use === "string" && w.use.trim() ? { use: w.use.trim() } : {}), re: compile(word, w.at === "start") });
			}
		}
	} catch {
		entries = [];
	}
	cache.set(file, { mtimeMs, entries });
	return entries;
}

// The listed words found in the text (each once), in list order.
export function bannedHits(text: string, dataDir?: string): BannedHit[] {
	const entries = load(dataDir ?? defaultDir());
	const seen = new Set<string>();
	const hits: BannedHit[] = [];
	for (const e of entries) {
		if (seen.has(e.word) || !e.re.test(text)) continue;
		seen.add(e.word);
		hits.push({ word: e.word, ...(e.use ? { use: e.use } : {}) });
	}
	return hits;
}

// One English line for the model.
export function bannedNote(hits: BannedHit[], dataDir?: string): string {
	const list = hits.map(h => (h.use ? `"${h.word}" -> use "${h.use}"` : `"${h.word}" -> reword it`)).join("; ");
	return `Blocked by the owner's word list (${wordsFile(dataDir)}): ${list}. Rewrite those words and send again.`;
}
