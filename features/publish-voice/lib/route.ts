// `route`: does this request call for publish-voice, and as a new piece or an edit? Deterministic, no model. The scenario table in SKILL.md is the
// reference; the model decides in the end, this is what the table says and what tests can check.
import { type Axes, type CellId, lengthOf, purposeOf, requestAxes, resolveCell } from "./cells.ts";
import { nonSpaceLength } from "./text.ts";

export type Route = {
	fire: boolean;
	mode?: "new" | "edit";
	other: boolean;
	cell?: CellId;
	basis: string;
	ask?: string;
};

const NOT_FOR_US = /답장|답글|회신|카톡|카카오톡|메신저|슬랙|디스코드|README|리드미|API 문서|문서화|주석|커밋|보고서|보고\s?해|보고\s?드려|보고\s?올려|리포트|코드|함수|버그|(?<![가-힣])로그/i;
const GENRE = /블로그|뉴스레터|칼럼|사설|에세이|수필|원고|챕터|(?<![가-힣])책|스레드|SNS|트윗|인스타|공지|안내문|모집|가이드|설명글|포스팅|기고|연재|브런치|출간|글(?!자)/i;
const WRITE = /써|쓰|작성|다듬|고쳐|손봐|윤문|퇴고|초안|이어서|올릴|발행|잡아|만들어|정리해|편\s?부탁/;
const EDIT = /다듬|고쳐|손봐|윤문|퇴고|교정|수정|바꿔|첨삭/;
const OTHER = /(?<!내\s?)(?:사람|작가|님|씨|[A-Za-z]+)\s*(?:처럼|같이|스타일|풍|문체)/;
const KOREAN_NAME = /(?<![가-힣])([가-힣]{2,4})(?:처럼|같이)/g;
// Words that precede 처럼 without naming another writer: a time, the user's own habit, a genre.
const NOT_A_PERSON = new Set([
	"평소", "지난번", "저번", "이번", "예전", "이전", "기존", "원래", "보통", "항상", "언제나", "여느", "지금", "방금", "아까", "어제", "오늘", "그전", "그때", "평상시", "다음", "아래",
	"블로그", "에세이", "칼럼", "소설", "편지", "뉴스레터", "우리", "저희",
]);
const namesAnother = (request: string): boolean => OTHER.test(request) || [...request.matchAll(KOREAN_NAME)].some(m => !NOT_A_PERSON.has(m[1] ?? ""));

// An axis the request leaves open is read from the draft first, then from the cell with the most texts.
export function cellFor(request: string, draft: string | undefined, counts: Partial<Record<CellId, number>>): Pick<Route, "cell" | "basis" | "ask"> {
	const axes: Axes = requestAxes(request);
	const open = !axes.length || !axes.purpose;
	const fromDraft = open && draft !== undefined && draft.trim() !== "";
	if (fromDraft) {
		axes.length ??= lengthOf(nonSpaceLength(draft));
		axes.purpose ??= purposeOf(draft);
	}
	const resolved = resolveCell(axes, counts);
	return fromDraft ? { ...resolved, basis: "요청에 없는 쪽은 초안을 읽어 정했어요" } : resolved;
}

export function routeRequest(request: string, draft: string | undefined, counts: Partial<Record<CellId, number>>): Route {
	const other = namesAnother(request);
	const fire = !NOT_FOR_US.test(request) && WRITE.test(request) && (GENRE.test(request) || other);
	if (!fire) return { fire: false, other: false, basis: "공개할 글을 쓰거나 다듬는 요청이 아니에요" };
	return { fire: true, mode: draft !== undefined || EDIT.test(request) ? "edit" : "new", other, ...cellFor(request, draft, counts) };
}
