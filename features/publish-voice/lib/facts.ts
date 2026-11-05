// Fact comparison between a draft (or material) and a result. Numbers are compared by value and unit (numbers.ts); names are Latin tokens, a name with a
// title, a word with an institution or place suffix, and anything inside quotation marks. No morphological analyser is used, so recall is bounded;
// the tamper tests in test/facts.test.ts measure what is caught.
import { type Fact, KO_BOUNDARY, numberFacts } from "./numbers.ts";

export type Facts = { numbers: Fact[]; names: Fact[] };
export type FactDiff = { missing: Fact[]; invented: Fact[] };
export type FactComparison = { numbers: FactDiff; names: FactDiff; blocked: boolean };

const TITLES = [
	"선생님", "대통령", "본부장", "변호사", "교수", "박사", "대표", "이사", "부장", "과장", "차장", "팀장", "사장", "작가", "기자", "의원", "장관", "감독", "코치", "의사", "사원", "대리",
	"실장", "원장", "회장", "씨", "님",
];
const NOT_A_NAME = new Set([
	"우리", "저희", "회사", "고객", "손님", "독자", "사용자", "회원", "다음", "이번", "지난", "새로운", "해당", "담당", "전임", "신임", "현직", "각종", "모든", "여러", "그분", "이분", "저분",
	"본인", "당사", "귀사", "본사", "당신", "여러분", "선배", "후배", "동료", "아저", "아가", "말솜", "글솜", "하느", "아드",
]);
const ORG_MULTI = [
	"주식회사", "대학교", "대학원", "대학", "고등학교", "중학교", "초등학교", "학교", "병원", "은행", "회사", "협회", "재단", "센터", "연구소", "연구원", "위원회", "공사", "공단", "시청", "구청",
	"도청", "공원", "박물관", "도서관", "미술관", "극장", "카페", "식당", "호텔", "서점", "출판사", "신문", "방송", "학회", "조합", "공항", "터미널", "시장", "광장",
].sort((a, b) => b.length - a.length);
const TITLE_RE = new RegExp(`(?<![가-힣])([가-힣]{2,4}?)\\s?(${TITLES.join("|")})`, "g");
const ORG_MULTI_RE = new RegExp(`(?<![가-힣])([가-힣]{1,8}?)(${ORG_MULTI.join("|")})${KO_BOUNDARY}`, "g");
const PLACE_RE = new RegExp(`(?<![가-힣])([가-힣]{2,5}?)(동|읍|역|산|강|섬)${KO_BOUNDARY}`, "g");
// 시, 군, 구 end many verbs and adverbs (슬며시, 그렇구), so they count only as a place with a particle or 청 right after.
const ADMIN_RE = /(?<![가-힣])([가-힣]{2,5}?)(시|군|구)(?=에|의|청)/g;
const LATIN_RE = /[A-Za-z][A-Za-z0-9._+-]+/g;
const ENTITY_RE = /&#?[A-Za-z0-9]+;/g;
const MAX_QUOTE_CHARS = 24;
const MAX_QUOTE_EOJEOL = 5;
const QUOTED: readonly RegExp[] = [/"([^"\n]{2,80})"/g, /“([^”\n]{2,80})”/g, /‘([^’\n]{2,80})’/g, /「([^」\n]{2,80})」/g, /『([^』\n]{2,80})』/g];

const squash = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

// A short quoted phrase is a title or a name; a quoted sentence is speech and not a name.
const isQuotedName = (inner: string): boolean => {
	const text = inner.trim();
	return squash(text) !== "" && text.length <= MAX_QUOTE_CHARS && text.split(/\s+/).length <= MAX_QUOTE_EOJEOL && !/[.?!…]$/.test(text);
};

// A word made of one syllable group said twice (주섬주섬) is an adverb, not a place.
const isReduplicated = (word: string): boolean => word.length % 2 === 0 && word.slice(0, word.length / 2) === word.slice(word.length / 2);

function nameFacts(masked: string): Fact[] {
	const out: Fact[] = [];
	for (const m of masked.matchAll(TITLE_RE)) {
		const name = m[1] ?? "";
		if (!NOT_A_NAME.has(name)) out.push({ key: `p:${name}${m[2]}`, raw: m[0] });
	}
	const rest = masked.replace(TITLE_RE, m => " ".repeat(m.length));
	for (const re of [ORG_MULTI_RE, ADMIN_RE, PLACE_RE]) {
		for (const m of rest.matchAll(re)) if (!isReduplicated(`${m[1]}${m[2]}`)) out.push({ key: `o:${m[1]}${m[2]}`, raw: m[0] });
	}
	for (const m of masked.replace(ENTITY_RE, " ").matchAll(LATIN_RE)) out.push({ key: `l:${m[0].replace(/[._+-]+$/, "").toLowerCase()}`, raw: m[0] });
	for (const re of QUOTED) for (const m of masked.matchAll(re)) if (isQuotedName(m[1] ?? "")) out.push({ key: `q:${squash(m[1] ?? "")}`, raw: m[0] });
	return out;
}

const unique = (facts: Fact[]): Fact[] => [...new Map(facts.map(f => [f.key, f])).values()];

export function extractFacts(text: string): Facts {
	const { facts, masked } = numberFacts(text);
	return { numbers: unique(facts), names: unique(nameFacts(masked)) };
}

const diff = (from: Fact[], to: Fact[]): FactDiff => ({
	missing: from.filter(f => !to.some(g => g.key === f.key)),
	invented: to.filter(f => !from.some(g => g.key === f.key)),
});

export function compareFacts(draft: string, result: string): FactComparison {
	const a = extractFacts(draft);
	const b = extractFacts(result);
	const numbers = diff(a.numbers, b.numbers);
	const names = diff(a.names, b.names);
	const blocked = [numbers, names].some(d => d.missing.length > 0 || d.invented.length > 0);
	return { numbers, names, blocked };
}
