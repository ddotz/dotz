import { describe, expect, test } from "bun:test";
import { compareFacts, extractFacts } from "../lib/facts.ts";
import { reviewList } from "../lib/review.ts";

const BASE = "홍길동 대표는 서울시청 앞에서 강남구의 주민 30%에게 2.6만 원을 나눠 주었다. 사만 원짜리 상품은 아니다. 행사는 3월 5일에 열렸다. 마지막 문장은 따로 남겼다.";

describe("변조 9종", () => {
	test("손대지 않은 글은 아무것도 걸리지 않아요", () => {
		const c = compareFacts(BASE, BASE);
		const r = reviewList(BASE, BASE);
		expect([c.blocked, r.missingSentences, r.negationChanged, r.approxChanged]).toEqual([false, [], [], []]);
	});

	test.each([
		["숫자 교체", (s: string) => s.replace("30%", "31%")],
		["단위 교체", (s: string) => s.replace("30%", "30명")],
		["큰 단위 교체", (s: string) => s.replace("2.6만", "2.6천")],
		["한글 수사 교체", (s: string) => s.replace("사만", "오만")],
	])("숫자: %s는 막힘", (_, tamper) => {
		const c = compareFacts(BASE, tamper(BASE));
		expect([c.blocked, c.numbers.missing.length > 0, c.numbers.invented.length > 0]).toEqual([true, true, true]);
	});

	test.each([
		["기관명 교체", (s: string) => s.replace("서울시청", "부산시청")],
		["사람 이름 교체", (s: string) => s.replace("홍길동", "김철수")],
		["지명 삭제", (s: string) => s.replace("강남구의 ", "")],
	])("이름: %s는 막힘", (_, tamper) => {
		const c = compareFacts(BASE, tamper(BASE));
		expect(c.blocked).toBe(true);
		expect(c.names.missing.length).toBeGreaterThan(0);
	});

	test("문장 통째 삭제는 막지 않고 빠진 문장 후보로 알려요", () => {
		const gone = BASE.replace(" 마지막 문장은 따로 남겼다.", "");
		expect(compareFacts(BASE, gone).blocked).toBe(false);
		expect(reviewList(BASE, gone).missingSentences).toEqual(["마지막 문장은 따로 남겼다."]);
	});

	test("부정 뒤집기는 막지 않고 검토 목록에 올라요", () => {
		const flipped = BASE.replace("아니다", "맞다");
		expect(compareFacts(BASE, flipped).blocked).toBe(false);
		expect(reviewList(BASE, flipped).negationChanged).toHaveLength(1);
	});

	test("근사 표현이 바뀌면 검토 목록에 올라요", () => {
		const r = reviewList("참가자는 약 30명이었다.", "참가자는 30명이었다.");
		expect(r.approxChanged).toHaveLength(1);
	});
});

describe("숫자 정규화", () => {
	test.each([
		["2.6만 원", "26,000원"],
		["2만 6천 원", "26000원"],
		["세 배", "3배"],
		["두 명", "2명"],
		["삼십 년", "30년"],
		["30퍼센트", "30%"],
		["오후 3시", "15시"],
		["2026년 3월 5일", "2026.03.05"],
	])("같음: %s = %s", (a, b) => expect(compareFacts(a, b).blocked).toBe(false));

	test.each([
		["30%", "30명"],
		["오후 3시", "오전 3시"],
		["2.6만 원", "2.6천 원"],
		["사만 원", "오만 원"],
		["세 배", "네 배"],
		["3월 5일", "3월 6일"],
	])("다름: %s != %s", (a, b) => expect(compareFacts(a, b).blocked).toBe(true));

	test.each(["두 명뿐", "두 명밖에", "두 개마다", "세 번이라도", "세 명조차", "세 명마저", "두 사람께", "두 가지뿐"])("조사가 붙어도 숫자예요: %s", text => {
		expect(extractFacts(text).numbers).toHaveLength(1);
	});

	test("두 가지뿐이 세 가지뿐으로 바뀌면 막혀요", () => {
		expect(compareFacts("선택지는 두 가지뿐이에요.", "선택지는 세 가지뿐이에요.").blocked).toBe(true);
	});

	test("한 번, 한 사람, 한 대, 한 곳은 숫자가 아니고 \"한 명\"이 \"두 명\"이 되면 막혀요", () => {
		expect(extractFacts("한 번 만났고 한 사람이 한 대를 몰고 한 곳에 갔다").numbers).toEqual([]);
		expect(compareFacts("한 명이 왔다.", "두 명이 왔다.")).toMatchObject({ blocked: true, numbers: { missing: [], invented: [{ raw: "두 명" }] } });
	});

	test("열한 명, 아라비아 1, 한 시는 계속 숫자예요", () => {
		expect(extractFacts("열한 명이 왔다").numbers.map(n => n.key)).toEqual(["11명"]);
		expect(extractFacts("1명이 왔다").numbers.map(n => n.key)).toEqual(["1명"]);
		expect(extractFacts("한 시에 만나요").numbers.map(n => n.key)).toEqual(["t:01:00"]);
	});

	test("숫자가 아닌 말을 숫자로 읽지 않아요", () => {
		expect(extractFacts("공원은 이 일을 이어 가고 조명도 구원도 이원화도 아니에요").numbers).toEqual([]);
	});

	test("동사 어미, 부사, 큰따옴표 대화는 이름으로 잡지 않아요", () => {
		const text = '그에게 말하면 되고 물으면 기억하면 정하면 슬며시 그렇구 맞장구를 쳤다. 아저씨와 말솜씨와 하느님도 주섬주섬 나섰다. 그는 "오늘은 정말 괜찮다고 생각해요."라고 했다. &nbsp; 끝.';
		expect(extractFacts(text).names).toEqual([]);
	});

	test("장소, 호칭, 책 이름, 영문 이름은 계속 잡아요", () => {
		const keys = extractFacts("부산역에서 강남구에서 역삼동 한라산 김철수 씨 『토지』 Google").names.map(f => f.key);
		expect(keys).toEqual(expect.arrayContaining(["o:부산역", "o:강남구", "o:역삼동", "o:한라산", "p:김철수씨", "q:토지", "l:google"]));
	});

	test("라틴 낱말, 호칭, 따옴표 안의 말을 이름으로 잡아요", () => {
		const keys = extractFacts('Kim이 "시작이 반이다"라고 말했다. 이영희 팀장도 왔다.').names.map(f => f.key);
		expect(keys).toEqual(expect.arrayContaining(["l:kim", "q:시작이반이다", "p:이영희팀장"]));
	});
});
