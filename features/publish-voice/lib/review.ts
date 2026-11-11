// The review list of a polish: things worth a human look that do not block. Sentences are paired by character-bigram overlap, no model involved.
import { eojeolsOf, sentencesOf } from "./text.ts";

export type Review = {
	missingSentences: string[];
	negationChanged: { from: string; to: string }[];
	approxChanged: { from: string; to: string; words: string }[];
	newWords: string[];
};

const NEGATION = /않|못|(?:^|\s)안\s|아니|없|말(?:자|고)|금지|불가|미만/g;
const APPROX = /약|거의|대략|이상|이하|넘|미만|초과|쯤|정도|가량|최소|최대|적어도/g;
const JOSA = /(?:에서는|에서의|으로는|에게는|에서|에게|으로|부터|까지|처럼|보다|이라는|라는|이다|입니다|에는|에도|은|는|이|가|을|를|의|에|와|과|로|도|만)$/;
const MISSING_BELOW = 0.35;
const PAIRED_ABOVE = 0.4;

// Sentences of a draft times sentences of a result: past this many pairs the pairing is not attempted (the same bound for the review list and the change list).
const MAX_PAIRS = 4_000_000;
export const pairable = (before: readonly string[], after: readonly string[]): boolean => before.length * after.length <= MAX_PAIRS;
export function assertPairable(before: readonly string[], after: readonly string[]): void {
	if (!pairable(before, after)) throw new Error("글이 너무 길어요. 고친 곳이 있는 장이나 글 단위로 나눠서 넣어 주세요");
}

const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
export type Grams = { counts: Map<string, number>; total: number };

// The bigram map of a sentence is built once and reused for every pair it is compared in.
export const gramsOf = (s: string): Grams => {
	const counts = new Map<string, number>();
	const t = letters(s);
	for (let i = 0; i + 2 <= t.length; i++) counts.set(t.slice(i, i + 2), (counts.get(t.slice(i, i + 2)) ?? 0) + 1);
	return { counts, total: Math.max(0, t.length - 1) };
};

export function diceOf(x: Grams, y: Grams): number {
	const [small, large] = x.counts.size <= y.counts.size ? [x.counts, y.counts] : [y.counts, x.counts];
	let shared = 0;
	for (const [k, n] of small) shared += Math.min(n, large.get(k) ?? 0);
	const total = x.total + y.total;
	return total === 0 ? 0 : (2 * shared) / total;
}

export const dice = (a: string, b: string): number => diceOf(gramsOf(a), gramsOf(b));

const hits = (s: string, re: RegExp): string[] => s.match(re) ?? [];
const stems = (text: string): string[] => eojeolsOf(text).map(w => w.replace(/^[^가-힣A-Za-z0-9]+|[^가-힣A-Za-z0-9]+$/g, "").replace(JOSA, "")).filter(w => /[가-힣]{2,}/.test(w));

export function reviewList(draft: string, result: string): Review {
	const [before, after] = [sentencesOf(draft), sentencesOf(result)];
	assertPairable(before, after);
	const afterGrams = after.map(gramsOf);
	const review: Review = { missingSentences: [], negationChanged: [], approxChanged: [], newWords: [] };
	for (const from of before) {
		let best = "";
		let score = 0;
		const fromGrams = gramsOf(from);
		afterGrams.forEach((grams, i) => {
			const d = diceOf(fromGrams, grams);
			if (d > score) [best, score] = [after[i] ?? "", d];
		});
		if (score < MISSING_BELOW) review.missingSentences.push(from);
		if (score < PAIRED_ABOVE) continue;
		if (hits(from, NEGATION).length % 2 !== hits(best, NEGATION).length % 2) review.negationChanged.push({ from, to: best });
		const [was, now] = [hits(from, APPROX).sort().join(","), hits(best, APPROX).sort().join(",")];
		if (was !== now) review.approxChanged.push({ from, to: best, words: `${was || "없음"} → ${now || "없음"}` });
	}
	const known = new Set(stems(draft).map(w => w.slice(0, 2)));
	review.newWords = [...new Set(stems(result).filter(w => !known.has(w.slice(0, 2))))];
	return review;
}
