// The one measuring function: analysis builds profiles with it. Only grammar is counted (endings, punctuation, a fixed list of connectives,
// pronouns, lengths); no content noun is ever stored.
import { eojeolsOf, nonSpaceLength, paragraphsOf, sentencesOf } from "./text.ts";

export const ENDING_CLASSES = ["hapsyo", "haeyo", "haera", "banmal", "eumseum", "noun"] as const;
export type EndingClass = (typeof ENDING_CLASSES)[number];
export const PUNCT_KEYS = ["comma", "question", "exclaim", "ellipsis", "quote", "paren", "dash", "tilde", "choseong", "emoji", "emphasis"] as const;
type PunctKey = (typeof PUNCT_KEYS)[number];
const OPENINGS = ["question", "number", "short", "scene"] as const;
const CLOSINGS = ["question", "short", "plain", "suggest"] as const;

export type Features = {
	chars: number;
	hangul: number;
	eojeols: number;
	sentences: number;
	paragraphs: number;
	sentLen: { mean: number; p10: number; p50: number; p90: number; cv: number };
	breath: { sentPerPara: number; blankRatio: number; oneLineRatio: number };
	endings: Record<EndingClass, number>;
	endingTop: [string, number][];
	endEntropy: number;
	punct: Record<PunctKey, number>;
	connectives: [string, number][];
	person: { na: number; jeo: number; uri: number };
	opening: Record<(typeof OPENINGS)[number], number>;
	closing: Record<(typeof CLOSINGS)[number], number>;
};
export type Flat = Record<string, number>;

const TAIL = /(?:[\s.!?…~,"'“”‘’「」『』()[\]>*_-]|[ㅋㅎㅠㅜㅡ]|\p{Extended_Pictographic}|\u200d|\ufe0f)+$/u;
export const endBody = (sentence: string): string => sentence.replace(TAIL, "");

const CLASS_RULES: readonly (readonly [EndingClass, RegExp])[] = [
	["hapsyo", /(?:니다|니까|십시오|시오|봅시다|합시다|읍시다)$/],
	["haeyo", /(?:요|죠)$/],
	["eumseum", /(?:았음|었음|였음|했음|겠음|없음|있음|같음|됨|함|슴)$/],
	["haera", /다$/],
	["banmal", /(?:잖아|거든|는데|은데|어|아|야|지|네|냐|니|자|래|걸|해|군|게|까|나|라)$/],
];
export function endingOf(sentence: string): EndingClass {
	const body = endBody(sentence);
	return CLASS_RULES.find(([, re]) => re.test(body))?.[0] ?? "noun";
}

const PUNCT: Record<PunctKey, RegExp> = {
	comma: /[,，]/g,
	question: /[?？]/g,
	exclaim: /[!！]/g,
	ellipsis: /…|\.{3,}/g,
	quote: /["“”‘’「」『』]/g,
	paren: /[()（）[\]]/g,
	dash: /[—–―]|--/g,
	tilde: /[~〜～]/g,
	choseong: /[ㄱ-ㅎㅏ-ㅣ]+/g,
	emoji: /\p{Extended_Pictographic}/gu,
	emphasis: /\*\*|__|^#{1,6}\s/gm,
};

// Grammar words only: a sentence-initial connective counts when it starts the sentence and is followed by a space, comma or the end.
const CONNECTIVES = [
	"그리고", "그래서", "하지만", "그러나", "그런데", "그러면", "그렇지만", "그러니까", "그러므로", "따라서", "또한", "또", "즉", "한편", "물론", "사실",
	"결국", "특히", "반면에", "반면", "예를 들어", "예컨대", "그래도", "어쨌든", "아무튼", "다만", "게다가", "오히려", "근데", "우선", "먼저", "그럼",
	"왜냐하면", "더구나", "나아가", "이처럼", "이렇게", "그렇다면", "아니면", "혹은", "또는", "마지막으로", "끝으로", "첫째", "둘째", "셋째",
].sort((a, b) => b.length - a.length);

const PERSON = {
	na: /^(?:나|내|난)(?:는|가|를|도|의|만|랑|와|에게|한테)?$/,
	jeo: /^(?:저|제)(?:는|가|를|도|의|만|랑|와|에게|한테)?$/,
	uri: /^(?:우리|저희)(?:는|가|를|도|의|만|들|에게)?$/,
};
const EDGE = /^[^가-힣A-Za-z0-9]+|[^가-힣A-Za-z0-9]+$/g;
const SUGGEST = /(?:자|세요|십시오|시오|봅시다|바랍니다|바라요|보시길|주세요)$/;

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const ratio = (n: number, d: number): number => (d > 0 ? r4(n / d) : 0);
const perThousand = (n: number, chars: number): number => (chars > 0 ? r4((n * 1000) / chars) : 0);

export function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0;
	const at = (sorted.length - 1) * q;
	const lo = Math.floor(at);
	const hi = Math.ceil(at);
	return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (at - lo);
}

function normalizedEntropy(counts: ReadonlyMap<string, number>, sentences: number): number {
	const kinds = counts.size;
	const spread = Math.min(sentences, kinds);
	if (spread < 2) return 0;
	let h = 0;
	for (const n of counts.values()) h -= (n / sentences) * Math.log2(n / sentences);
	return r4(h / Math.log2(spread));
}

const top = (counts: ReadonlyMap<string, number>, n: number): [string, number][] =>
	[...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function openingKind(first: string): (typeof OPENINGS)[number] {
	if (/[?？]["'”’」』)]*$/.test(first)) return "question";
	const words = eojeolsOf(first);
	if (/\d/.test(words[0] ?? "")) return "number";
	return words.length <= 6 ? "short" : "scene";
}
function closingKind(last: string): (typeof CLOSINGS)[number] {
	if (/[?？]["'”’」』)]*$/.test(last)) return "question";
	if (SUGGEST.test(endBody(last))) return "suggest";
	return eojeolsOf(last).length <= 6 ? "short" : "plain";
}

function oneHot<K extends string>(keys: readonly K[], on: K | undefined): Record<K, number> {
	return Object.fromEntries(keys.map(k => [k, k === on ? 1 : 0])) as Record<K, number>;
}

export function measure(text: string): Features {
	const sentences = sentencesOf(text);
	const paragraphs = paragraphsOf(text);
	const eojeols = eojeolsOf(text);
	const chars = nonSpaceLength(text);
	const lengths = sentences.map(s => eojeolsOf(s).length).sort((a, b) => a - b);
	const mean = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
	const sd = lengths.length ? Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length) : 0;
	const lines = text.trim().split("\n");

	const classes = new Map<string, number>();
	const endings = new Map<string, number>();
	const connectives = new Map<string, number>();
	for (const s of sentences) {
		const cls = endingOf(s);
		bump(classes, cls);
		const tail = cls === "noun" ? undefined : /[가-힣]{2}$/.exec(endBody(s))?.[0];
		if (tail) bump(endings, tail);
		const head = CONNECTIVES.find(c => s.startsWith(c) && /^(?:[\s,，]|$)/.test(s.slice(c.length)));
		if (head) bump(connectives, head);
	}
	const endingTotal = [...endings.values()].reduce((a, b) => a + b, 0);

	const words = eojeols.map(w => w.replace(EDGE, ""));
	const countWords = (re: RegExp) => perThousand(words.filter(w => re.test(w)).length, eojeols.length);
	const first = sentences[0];
	const last = sentences.at(-1);

	return {
		chars,
		hangul: (text.match(/[가-힣]/g) ?? []).length,
		eojeols: eojeols.length,
		sentences: sentences.length,
		paragraphs: paragraphs.length,
		sentLen: { mean: r4(mean), p10: r4(percentile(lengths, 0.1)), p50: r4(percentile(lengths, 0.5)), p90: r4(percentile(lengths, 0.9)), cv: mean > 0 ? r4(sd / mean) : 0 },
		breath: {
			sentPerPara: ratio(sentences.length, paragraphs.length),
			blankRatio: ratio(lines.filter(l => !l.trim()).length, lines.length),
			oneLineRatio: ratio(paragraphs.filter(p => !p.includes("\n") && sentencesOf(p).length === 1).length, paragraphs.length),
		},
		endings: Object.fromEntries(ENDING_CLASSES.map(c => [c, ratio(classes.get(c) ?? 0, sentences.length)])) as Record<EndingClass, number>,
		endingTop: top(endings, 10),
		endEntropy: normalizedEntropy(endings, endingTotal),
		punct: Object.fromEntries(PUNCT_KEYS.map(k => [k, perThousand((text.match(PUNCT[k]) ?? []).length, chars)])) as Record<PunctKey, number>,
		connectives: top(connectives, 10),
		person: { na: countWords(PERSON.na), jeo: countWords(PERSON.jeo), uri: countWords(PERSON.uri) },
		opening: oneHot(OPENINGS, first ? openingKind(first) : undefined),
		closing: oneHot(CLOSINGS, last ? closingKind(last) : undefined),
	};
}

// The numbers the brief reads, one flat record per measurement unit. Keys starting with o_ / c_ describe a whole document (opening, closing).
export function flat(f: Features): Flat {
	const out: Flat = { s_mean: f.sentLen.mean, s_p10: f.sentLen.p10, s_p90: f.sentLen.p90 };
	out.b_para = f.breath.sentPerPara;
	out.b_blank = f.breath.blankRatio;
	out.b_one = f.breath.oneLineRatio;
	out.e_entropy = f.endEntropy;
	for (const c of ENDING_CLASSES) out[`e_${c}`] = f.endings[c];
	for (const k of PUNCT_KEYS) out[`p_${k}`] = f.punct[k];
	out.n_na = f.person.na;
	out.n_jeo = f.person.jeo;
	out.n_uri = f.person.uri;
	for (const k of OPENINGS) out[`o_${k}`] = f.opening[k];
	for (const k of CLOSINGS) out[`c_${k}`] = f.closing[k];
	return out;
}
export const isDocumentKey = (key: string): boolean => key.startsWith("o_") || key.startsWith("c_");
