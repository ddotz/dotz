// Copy check by hashed 12-grams of the letters and digits (spaces and punctuation dropped). Only a sorted, de-duplicated set of salted 32-bit hashes is
// kept per voice, so the order of a text and the text itself cannot be rebuilt from the file. Runs of matching grams give the length of an overlap.
import { loadJson, saveJson } from "./store.ts";

const GRAM = 12;
export const BLOCK_CHARS = 30;
export const WARN_CHARS = 60;

export type Overlap = { voice: string; chars: number; sample: string };
export type CopySource = { voice: string; kind: "self" | "other"; hashes: ReadonlySet<number> };
export type CopyReport = { blocks: Overlap[]; warns: Overlap[] };

const normalized = (text: string): string => text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function loadSalt(file: string): number {
	const saved = loadJson<{ salt?: number }>(file, {});
	if (typeof saved.salt === "number") return saved.salt;
	const salt = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
	saveJson(file, { salt });
	return salt;
}

export function gramHashes(text: string, salt: number): number[] {
	const t = normalized(text);
	const out: number[] = [];
	for (let i = 0; i + GRAM <= t.length; i++) {
		let h = (0x811c9dc5 ^ salt) >>> 0;
		for (let j = i; j < i + GRAM; j++) h = Math.imul(h ^ t.charCodeAt(j), 0x01000193) >>> 0;
		out.push(h);
	}
	return out;
}

export const encodeHashes = (hashes: readonly number[]): string =>
	Buffer.from(new Uint32Array([...new Set(hashes)].sort((a, b) => a - b)).buffer).toString("base64");

export function decodeHashes(encoded: string): Set<number> {
	const bytes = Buffer.from(encoded, "base64");
	return new Set(new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
}

function runsOf(result: string, source: ReadonlySet<number>, skip: ReadonlySet<number>, salt: number, minChars: number, voice: string): Overlap[] {
	const grams = gramHashes(result, salt);
	const text = normalized(result);
	const out: Overlap[] = [];
	let start = -1;
	const close = (end: number) => {
		const chars = end - start + GRAM - 1;
		if (start >= 0 && chars >= minChars) out.push({ voice, chars, sample: text.slice(start, start + Math.min(chars, 40)) });
		start = -1;
	};
	grams.forEach((h, i) => {
		const hit = source.has(h) && !skip.has(h);
		if (hit && start < 0) start = i;
		if (!hit) close(i);
	});
	close(grams.length);
	return out;
}

// Another person's text blocks at 30 characters, the owner's own at 60 only warns; anything that was in the draft or the material is not counted.
export function copyCheck(input: { result: string; known: readonly string[]; sources: readonly CopySource[]; salt: number }): CopyReport {
	const skip = new Set(input.known.flatMap(t => gramHashes(t, input.salt)));
	const report: CopyReport = { blocks: [], warns: [] };
	for (const s of input.sources) {
		const kind = s.kind === "other" ? BLOCK_CHARS : WARN_CHARS;
		const found = runsOf(input.result, s.hashes, skip, input.salt, kind, s.voice);
		(s.kind === "other" ? report.blocks : report.warns).push(...found);
	}
	return report;
}
