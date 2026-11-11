// A cell is length x purpose. The structure lives here; the values in a cell belong to each person. Classifying a text and reading a request
// are both deterministic surface rules, so the same input always lands in the same cell.
import { eojeolsOf, nonSpaceLength, sentencesOf } from "./text.ts";

export const LENGTHS = ["short", "medium", "long"] as const;
export const PURPOSES = ["story", "opinion", "guide"] as const;
export type Length = (typeof LENGTHS)[number];
export type Purpose = (typeof PURPOSES)[number];
export type CellId = `${Length}-${Purpose}`;
export type Axes = { length?: Length; purpose?: Purpose };

export const ALL_CELLS: readonly CellId[] = LENGTHS.flatMap(l => PURPOSES.map((p): CellId => `${l}-${p}`));
export const cellId = (length: Length, purpose: Purpose): CellId => `${length}-${purpose}`;
export const parseCell = (id: string): { length: Length; purpose: Purpose } | undefined => {
	const [length, purpose] = id.split("-");
	const l = LENGTHS.find(x => x === length);
	const p = PURPOSES.find(x => x === purpose);
	return l && p && id === `${l}-${p}` ? { length: l, purpose: p } : undefined;
};

export const lengthOf = (chars: number): Length => (chars < 500 ? "short" : chars < 3000 ? "medium" : "long");

const HINTS: readonly (readonly [RegExp, Purpose])[] = [
	[/공지|안내|모집|가이드|설명|매뉴얼|사용법|튜토리얼/, "guide"],
	[/칼럼|사설|기고|논평|시론|의견|주장/, "opinion"],
	[/일기|에세이|후기|여행|회고|이야기|수필/, "story"],
];
const PAST = /(?:았다|었다|했다|였다|았어요|었어요|했어요|였어요|았습니다|었습니다|했습니다|였습니다|았다고|던)$/;
const FIRST = /^(?:나|내|난|저|제|우리|저희)(?:는|가|를|도|의)?$/;
const IMPERATIVE = /(?:하세요|하십시오|십시오|바랍니다|주세요|하시기|해야 합니다|해 주시|확인하세요|참고하세요)/;
const DATE_PLACE = /(?:\d{1,2}월\s?\d{1,2}일|\d{1,2}시|일시|장소|문의|접수|신청|마감|대상|준비물|참가비)/;
const LIST_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/;
const OPINION = /(?:생각합니다|생각해요|생각한다|보인다|해야 한다|해야 합니다|필요하다|필요합니다|문제다|문제입니다|라고 본다|라고 봅니다|주장|비판|왜냐하면|하지만|그러나|반면|아닐까|아닙니다|아니다)/;

// Surface score per purpose; a file or title word wins over the score, and with no signal at all the text counts as a story.
export function purposeOf(text: string, hint = ""): Purpose {
	const named = HINTS.find(([re]) => re.test(hint));
	if (named) return named[1];
	const sentences = sentencesOf(text);
	const n = Math.max(1, sentences.length);
	const count = (re: RegExp) => sentences.filter(s => re.test(s)).length / n;
	const past = sentences.filter(s => PAST.test(s.replace(/[\s.!?…~"'”’」』)]+$/, ""))).length / n;
	const first = eojeolsOf(text).filter(w => FIRST.test(w.replace(/^[^가-힣]+|[^가-힣]+$/g, ""))).length / n;
	const lists = text.split("\n").filter(l => LIST_LINE.test(l)).length / n;
	const questions = sentences.filter(s => /[?？]/.test(s)).length / n;
	const story = 2 * past + 0.5 * first;
	const opinion = 1.5 * count(OPINION) + 0.5 * questions;
	const guide = 2 * count(IMPERATIVE) + 1.5 * count(DATE_PLACE) + 1.5 * lists;
	const best = Math.max(story, opinion, guide);
	if (best === story) return "story";
	return best === opinion ? "opinion" : "guide";
}

export const cellOfText = (text: string, hint = ""): CellId => cellId(lengthOf(nonSpaceLength(text)), purposeOf(text, hint));

// Words in a request and the axes they fix; the first word that fixes an axis wins, an explicit length ("3000자", "짧게") overrides all.
const REQUEST_TERMS: readonly (readonly [RegExp, Axes])[] = [
	[/칼럼|사설|기고/, { length: "medium", purpose: "opinion" }],
	[/에세이|수필/, { length: "medium", purpose: "story" }],
	[/공지|안내문|모집/, { length: "short", purpose: "guide" }],
	[/설명글|가이드|매뉴얼|사용법/, { length: "medium", purpose: "guide" }],
	[/스레드|SNS|트윗|인스타|페이스북/i, { length: "short" }],
	[/블로그|뉴스레터|포스팅|브런치/, { length: "medium" }],
	[/원고|챕터|장편|단행본|(?<![가-힣])책(?:을|의|이|은|는|에|도)?(?![가-힣])/, { length: "long" }],
];

export function requestAxes(request: string): Axes & { words: string[] } {
	const axes: Axes = {};
	const words: string[] = [];
	for (const [re, fixed] of REQUEST_TERMS) {
		const hit = re.exec(request);
		if (!hit) continue;
		words.push(hit[0]);
		axes.length ??= fixed.length;
		axes.purpose ??= fixed.purpose;
	}
	const explicit = /(\d[\d,]*)\s*자/.exec(request);
	if (explicit) {
		axes.length = lengthOf(Number((explicit[1] ?? "0").replaceAll(",", "")));
		words.push(explicit[0]);
	} else if (/짧게|짧은|간단히/.test(request)) {
		axes.length = "short";
		words.push("짧게");
	} else if (/길게|긴 글|장문/.test(request)) {
		axes.length = "long";
		words.push("길게");
	}
	return { ...axes, words };
}

export type Resolved = { cell?: CellId; ask?: string; basis: string };

// An axis the request leaves open is filled from the cell with the most texts among those that fit the axis it did fix; with no texts to go on, ask.
export function resolveCell(axes: Axes, counts: Partial<Record<CellId, number>>): Resolved {
	if (axes.length && axes.purpose) return { cell: cellId(axes.length, axes.purpose), basis: "요청에서 길이와 용도를 모두 읽었어요" };
	const fits = ALL_CELLS.filter(id => {
		const c = parseCell(id);
		return (!axes.length || c?.length === axes.length) && (!axes.purpose || c?.purpose === axes.purpose);
	});
	const best = fits.reduce<CellId | undefined>((a, id) => ((counts[id] ?? 0) > (a ? (counts[a] ?? 0) : 0) ? id : a), undefined);
	if (best) return { cell: best, basis: "요청에 없는 쪽은 내 글이 가장 많은 칸으로 채웠어요" };
	const open = [!axes.length && "길이(짧은 글, 블로그 정도, 책 분량)", !axes.purpose && "성격(이야기, 의견, 안내)"].filter(Boolean).join("와 ");
	return { ask: `어떤 글인지 알려 주세요: ${open}.`, basis: "요청에서 칸을 정할 수 없고 채울 글도 없어요" };
}
