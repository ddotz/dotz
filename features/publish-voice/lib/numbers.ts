// Numbers in Korean text, normalised to a key of value + unit so "2.6만 원" and "26,000원", or "세 배" and "3배", compare equal while "30%" and "30명"
// do not. Dates and times come first (kept whole), then Arabic and Sino-Korean numbers, then native numerals. Each match is masked out of the text
// handed back, so name extraction never sees a unit as a Latin word. A native numeral of value one (한 번, 한 사람) usually means "a", so it is no fact.
export type Fact = { key: string; raw: string };

// A Hangul word ends here: the end, a non-Hangul character, or a particle that can follow a counted noun.
export const KO_BOUNDARY = "(?=$|[^가-힣]|(?:에서는|에서의|에서|에게|에는|에도|에|의|를|을|은|는|이|가|와|과|로|으로|도|만|까지|부터|보다|처럼|씩|쯤|정도|간|째|짜리|가량|이상|이하|내외|들|뿐|밖에|마다|라도|조차|마저|께|이다|입니다|이에요|예요|이고|이며|이나|나))";

const SINO_DIGIT: Record<string, number> = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SMALL: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const BIG: Record<string, number> = { 만: 1e4, 억: 1e8, 조: 1e12 };
const NATIVE_TENS: Record<string, number> = { 열: 10, 스무: 20, 스물: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90 };
const NATIVE_ONES: Record<string, number> = { 하나: 1, 한: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 넷: 4, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const HOUR_WORDS: Record<string, number> = { ...NATIVE_ONES, 열: 10, 열한: 11, 열두: 12 };
const UNIT_CANON: Record<string, string> = { 퍼센트: "%", 프로: "%", 달: "개월", 사람: "명", 해: "년" };
const SAFE_SINGLE_DIGIT_UNITS = new Set(["년", "개월", "배", "퍼센트", "시간", "층", "위", "점", "살"]);

const longestFirst = (words: readonly string[]) => [...words].sort((a, b) => b.length - a.length).join("|");
const UNIT = longestFirst([
	"퍼센트", "프로", "%", "위안", "달러", "주년", "학년", "학기", "분기", "단계", "페이지", "개월", "시간", "가지", "마리", "차례", "원", "엔", "명", "개", "배", "번", "살", "세", "시", "분",
	"초", "년", "월", "일", "주", "달", "권", "장", "대", "곳", "층", "위", "점", "회", "건", "편", "평", "채", "호", "박", "km", "kg", "cm", "mm", "ml", "gb", "mb", "tb", "kb", "m", "g", "℃",
]);
const NATIVE_UNIT = longestFirst(["시간", "가지", "마리", "그루", "송이", "켤레", "자루", "명", "개", "배", "번", "살", "권", "장", "대", "곳", "채", "잔", "병", "통", "벌", "달", "주", "해", "사람"]);

const NUM = "\\d[\\d,]*(?:\\.\\d+)?";
const UNIT_CHARS = "(?:[십백천억조]|만(?!큼))+";
const ARABIC = new RegExp(`(?<![\\d.,])${NUM}(?:${UNIT_CHARS})?(?:(?<=[십백천만억조])\\s?${NUM}(?:${UNIT_CHARS})?)*(?:\\s?(${UNIT})(?![A-Za-z]))?`, "gi");
const SINO = new RegExp(`(?<![가-힣])([영공일이삼사오육칠팔구십백천만억조]+)(\\s?)(${UNIT})(?![A-Za-z])${KO_BOUNDARY}`, "g");
const NATIVE = new RegExp(`(?<![가-힣])(스무|스물|서른|마흔|쉰|예순|일흔|여든|아흔|열)?(하나|한|둘|두|셋|세|넷|네|다섯|여섯|일곱|여덟|아홉)?\\s?(${NATIVE_UNIT})${KO_BOUNDARY}`, "g");
const HOUR = `(\\d{1,2}|(?<![가-힣])(?:열두|열한|열|한|두|세|네|다섯|여섯|일곱|여덟|아홉))`;
const TIME = new RegExp(`(오전|오후|새벽|아침|저녁|밤|낮)?\\s?${HOUR}\\s?시(?!간)(?:\\s?(\\d{1,2})\\s?분|\\s?(반))?(?:${KO_BOUNDARY}|(?=경|였))`, "g");
const CLOCK = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)(?:\s?(AM|PM))?/gi;
const DATES: readonly (readonly [RegExp, (m: RegExpExecArray) => string])[] = [
	[/(\d{4})\s?년\s?(\d{1,2})\s?월\s?(\d{1,2})\s?일/g, m => `d:${Number(m[1])}-${Number(m[2])}-${Number(m[3])}`],
	[/(?<!\d)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/g, m => `d:${Number(m[1])}-${Number(m[2])}-${Number(m[3])}`],
	[/(\d{1,2})\s?월\s?(\d{1,2})\s?일/g, m => `d:--${Number(m[1])}-${Number(m[2])}`],
	[/(\d{4})\s?년\s?(\d{1,2})\s?월/g, m => `m:${Number(m[1])}-${Number(m[2])}`],
];

const MASK = "\u0001";
const round = (n: number): string => String(Math.round(n * 1e6) / 1e6);
const hhmm = (h: number, m: number): string => `t:${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

function mask(text: string, re: RegExp, make: (m: RegExpExecArray) => string | undefined, out: Fact[]): string {
	let masked = text;
	for (const m of text.matchAll(re)) {
		const key = make(m);
		if (key === undefined) continue;
		out.push({ key, raw: m[0].trim() });
		masked = masked.slice(0, m.index) + MASK.repeat(m[0].length) + masked.slice(m.index + m[0].length);
	}
	return masked;
}

// Arabic numerals and unit characters add up the usual way: digits fill a small group, 십/백/천 close it, 만/억/조 multiply what came before.
function sumParts(tokens: readonly string[]): number | undefined {
	let total = 0;
	let section = 0;
	let num: number | undefined;
	for (const t of tokens) {
		const digit = SINO_DIGIT[t];
		if (digit !== undefined || /^\d/.test(t)) {
			if (num !== undefined) return undefined;
			num = digit ?? Number(t.replaceAll(",", ""));
		} else if (t in SMALL) {
			section += (num ?? 1) * (SMALL[t] ?? 1);
			num = undefined;
		} else {
			section += num ?? 0;
			total += (section || 1) * (BIG[t] ?? 1);
			section = 0;
			num = undefined;
		}
	}
	return total + section + (num ?? 0);
}

const tokensOf = (expr: string): string[] => expr.match(/\d[\d,]*(?:\.\d+)?|[영공일이삼사오육칠팔구십백천만억조]/g) ?? [];

function hourKey(prefix: string | undefined, hour: number, minute: number): string {
	const afternoon = prefix === "오후" || prefix === "저녁" || (prefix === "밤" && hour >= 6) || (prefix === "낮" && hour <= 5);
	return hhmm(afternoon && hour < 12 ? hour + 12 : hour, minute);
}

export function numberFacts(text: string): { facts: Fact[]; masked: string } {
	const facts: Fact[] = [];
	let masked = text;
	for (const [re, key] of DATES) masked = mask(masked, re, key, facts);
	masked = mask(masked, TIME, m => {
		const hour = /^\d/.test(m[2] ?? "") ? Number(m[2]) : (HOUR_WORDS[m[2] ?? ""] ?? 0);
		return hourKey(m[1], hour, m[3] ? Number(m[3]) : m[4] ? 30 : 0);
	}, facts);
	masked = mask(masked, CLOCK, m => {
		const pm = (m[3] ?? "").toUpperCase() === "PM";
		const hour = Number(m[1]);
		return hhmm(pm && hour < 12 ? hour + 12 : hour, Number(m[2]));
	}, facts);
	masked = mask(masked, ARABIC, m => {
		const value = sumParts(tokensOf(m[0].replace(new RegExp(`\\s?(?:${UNIT})$`, "i"), "")));
		if (value === undefined) return undefined;
		const unit = (m[1] ?? "").toLowerCase();
		return `${round(value)}${UNIT_CANON[unit] ?? unit}`;
	}, facts);
	masked = mask(masked, SINO, m => {
		const word = m[1] ?? "";
		const unit = m[3] ?? "";
		const single = [...word].length === 1;
		if (single && word in SINO_DIGIT && (["이", "일", "공", "영"].includes(word) || !SAFE_SINGLE_DIGIT_UNITS.has(unit))) return undefined;
		if (single && word === "조") return undefined;
		const value = sumParts(tokensOf(word));
		return value === undefined ? undefined : `${round(value)}${UNIT_CANON[unit] ?? unit}`;
	}, facts);
	masked = mask(masked, NATIVE, m => {
		if (!m[1] && !m[2]) return undefined;
		const value = (NATIVE_TENS[m[1] ?? ""] ?? 0) + (NATIVE_ONES[m[2] ?? ""] ?? 0);
		if (value === 1) return undefined;
		return `${value}${UNIT_CANON[m[3] ?? ""] ?? m[3]}`;
	}, facts);
	return { facts, masked };
}
