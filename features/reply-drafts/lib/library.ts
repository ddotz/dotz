// The 첨부 파일 폴더 of a mail app instance: a folder on this machine that holds the files the owner sends again and again (shared sheet music, forms).
// A reply that asks for or promises a file gets the best filename matches staged (offer.ts); filename matching is plain code, a model sees names only on a tie.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const LIBRARY_PICK_MAX = 3;
const SCAN_FILES = 3000;
const SCAN_DEPTH = 4;
const FILE_MAX_BYTES = 25 * 1024 * 1024;
const MIN_SCORE = 2;
const SUBJECT_WEIGHT = 2;

export type LibraryFile = { rel: string; path: string; size: number };

// Words that say "a file" or are mail politeness: they never match a file by themselves.
const GENERIC = new Set(["악보", "파일", "자료", "문서", "견적서", "사진", "양식", "첨부", "메일", "안녕하세요", "선생님", "감사합니다", "부탁드립니다", "부탁드려요", "부탁", "보내주세요", "보내드립니다", "보내", "주세요", "요청", "re", "fwd", "fw", "the", "and", "please", "send", "file", "pdf"]);

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[\s_\-.()[\]]+/g, "");

export function keywords(text: string): string[] {
	const out = new Set<string>();
	for (const w of text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 2 && !GENERIC.has(w)) out.add(w);
	return [...out];
}

// A Korean word carries particles ("행방불명을", "치히로의"): the word itself or the word without its last one or two letters counts.
function variants(word: string): string[] {
	const v = [word];
	if (/[가-힣]$/.test(word)) for (const cut of [1, 2]) if (word.length - cut >= 2) v.push(word.slice(0, -cut));
	return v;
}

export function listLibrary(folder: string): LibraryFile[] {
	const out: LibraryFile[] = [];
	let root: string;
	try {
		root = realpathSync(folder);
		if (!statSync(root).isDirectory()) return [];
	} catch {
		return [];
	}
	const walk = (dir: string, depth: number) => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (out.length >= SCAN_FILES) return;
			if (name.startsWith(".")) continue;
			const path = join(dir, name);
			try {
				const st = statSync(path);
				if (st.isDirectory()) {
					if (depth < SCAN_DEPTH) walk(path, depth + 1);
				} else if (st.isFile() && st.size > 0 && st.size <= FILE_MAX_BYTES) out.push({ rel: relative(root, path).split(sep).join("/"), path, size: st.size });
			} catch {
				continue;
			}
		}
	};
	walk(root, 0);
	return out;
}

export type Query = { subject: string; text: string };

export function scoreOf(file: LibraryFile, q: Query): number {
	const hay = norm(file.rel);
	const hits = (words: string[]) => words.filter(w => variants(norm(w)).some(x => x.length >= 2 && hay.includes(x))).length;
	return hits(keywords(q.subject)) * SUBJECT_WEIGHT + hits(keywords(q.text.slice(0, 1500)));
}

export function rankLibrary(files: LibraryFile[], q: Query): { file: LibraryFile; score: number }[] {
	return files.map(file => ({ file, score: scoreOf(file, q) })).sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel));
}

// `pick` is asked only when more than LIBRARY_PICK_MAX files tie for the best score; it sees names, never contents.
export async function matchLibrary(folder: string, q: Query, pick?: (names: string[]) => Promise<string[]>): Promise<LibraryFile[]> {
	const ranked = rankLibrary(listLibrary(folder), q);
	const top = ranked[0]?.score ?? 0;
	if (top < MIN_SCORE) return [];
	const best = ranked.filter(r => r.score === top).map(r => r.file);
	if (best.length <= LIBRARY_PICK_MAX) return best;
	const named = await pick?.(best.slice(0, 30).map(f => f.rel)).catch(() => []);
	const chosen = best.filter(f => named?.includes(f.rel)).slice(0, LIBRARY_PICK_MAX);
	return chosen.length ? chosen : best.slice(0, LIBRARY_PICK_MAX);
}

// The file of the library folder at `rel`, or undefined when it is not inside the folder.
export function libraryFile(folder: string, rel: string): LibraryFile | undefined {
	return listLibrary(folder).find(f => f.rel === rel);
}
