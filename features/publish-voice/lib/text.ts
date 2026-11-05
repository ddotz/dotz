// Splitting Korean prose into paragraphs, sentences and eojeol (space separated words). Pure functions.

export const nonSpaceLength = (text: string): number => text.replace(/\s/g, "").length;
export const eojeolsOf = (text: string): string[] => text.split(/\s+/).filter(t => /[가-힣A-Za-z0-9]/.test(t));

const LIST_CAP = 30;

// A list shown to the agent keeps its first 30 entries and says how many were left out.
export const capList = (items: readonly string[]): { shown: string[]; more: number } => ({ shown: items.slice(0, LIST_CAP), more: Math.max(0, items.length - LIST_CAP) });
export const joinCapped = (items: readonly string[]): string => {
	const { shown, more } = capList(items);
	return more ? `${shown.join(", ")} 외 ${more}개` : shown.join(", ");
};

const LIST_MARK = /^\s*(?:#{1,6}\s+|[-*•·]\s+|>\s*|\d{1,3}[.)]\s+)/;
const TERMINAL = /(?<=[.!?…。！？]["'”’」』)\]]*)\s+/;
const UNIT_LIMIT = 3000;
const UNIT_TARGET = 2000;
const UNIT_MIN = 500;

// Paragraphs are separated by blank lines; a text with no blank line at all counts every line as a paragraph.
export function paragraphsOf(text: string): string[] {
	const clean = text.replace(/\r\n?/g, "\n").trim();
	const byBlank = clean.split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
	return byBlank.length > 1 ? byBlank : clean.split("\n").map(p => p.trim()).filter(Boolean);
}

// Every line break ends a sentence (a heading or a list line is one), and so does terminal punctuation followed by a space ("2.6만" stays whole).
export function sentencesOf(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
		for (const piece of raw.replace(LIST_MARK, "").trim().split(TERMINAL)) {
			const s = piece.trim();
			if (/[가-힣A-Za-z0-9]/.test(s)) out.push(s);
		}
	}
	return out;
}

// Measurement units: a text over 3,000 characters is cut at paragraph borders into pieces of about 2,000, so the variation inside one author shows.
export function chunkText(text: string): string[] {
	if (nonSpaceLength(text) <= UNIT_LIMIT) return [text];
	const pieces = paragraphsOf(text).flatMap(p => (nonSpaceLength(p) > UNIT_LIMIT ? sentencesOf(p) : [p]));
	const chunks: string[] = [];
	let current: string[] = [];
	let size = 0;
	for (const piece of pieces) {
		current.push(piece);
		size += nonSpaceLength(piece);
		if (size < UNIT_TARGET) continue;
		chunks.push(current.join("\n\n"));
		current = [];
		size = 0;
	}
	if (current.length === 0) return chunks;
	if (size < UNIT_MIN && chunks.length > 0) chunks[chunks.length - 1] += `\n\n${current.join("\n\n")}`;
	else chunks.push(current.join("\n\n"));
	return chunks;
}
