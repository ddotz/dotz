import { expect, test } from "bun:test";
import { askFault, genericTitle, numberLedQuestion, proseAsk, unreadQuestions } from "./ask-normalize.ts";
import { answersOption } from "./notices-rules.ts";

const CARD = "결정: 백업 위치는 어디로 할까요?\n**1) 외장 디스크**\n**2) 클라우드**";

test("D5: a message that ends asking the owner in words, with no card, is a request in prose; an offer or a card is not", () => {
	for (const ask of ["어느 색이 좋은지 말해 주세요.", "배포 시각을 알려 주세요", "둘 중 하나로 정해 주세요.", "키 이름을 적어 주시면 바로 넣을게요.", "Please choose one of the two."])
		expect(proseAsk(`[done] sample-2 설정 화면을 고쳤어요.\n- web/app.ts\n${ask}\n-# 근거: 테스트 3개 통과`)).toBe(ask);
	for (const offer of ["다른 색을 원하면 말해 주세요.", "궁금한 게 있으면 알려 주세요.", "더 필요하시면 말씀해 주세요.", "If you want another color, let me know."])
		expect(proseAsk(`[done] sample-2 설정 화면을 고쳤어요.\n${offer}`)).toBeUndefined();
	expect(proseAsk(`[ask] 백업을 옮길게요.\n\n${CARD}\n\n번호로 답해 주세요.`)).toBeUndefined();
	expect(proseAsk("[done] 어느 색이 좋은지 알려 주세요.\n\n```\necho done\n```\n대신 확인: 화면 다시 읽기")).toBeUndefined();
	expect(proseAsk("[done] I've checked both options. Let me know which you'd prefer.")).toBe("I've checked both options. Let me know which you'd prefer.");
});

test("a card titled with no subject is generic; a title that names its subject is not", () => {
	for (const title of ["어떻게 할까요?", "이걸 만들까요?", "어떻게 진행할까요?", "그대로 반영할까요?", "How should I proceed?"])
		expect(genericTitle(`[ask] 정리 끝났어요.\n\n결정: ${title}\n**1) 바로 반영**\n**2) 보류**`)).toBe(title);
	for (const title of ["SSH 복구 명령을 만들까요?", "sample-2 알림 문구를 바꿀까요?", "Shall I merge the sample-2 branch?"])
		expect(genericTitle(`[ask] 정리 끝났어요.\n\n결정: ${title}\n**1) 바로 반영**\n**2) 보류**`)).toBeUndefined();
});

test("a question whose list became no card is named, and so is its fault before any other", () => {
	const text = `[ask] 정할 게 두 가지예요.\n\n배포 시각은 어느 쪽으로 할까요?\n- 오늘 밤에 바로 올려요.\n- 내일 아침에 올려요.\n\n${CARD}`;
	expect(unreadQuestions(text)).toEqual(["배포 시각은 어느 쪽으로 할까요?"]);
	expect(askFault(text)).toEqual({ kind: "unread", questions: ["배포 시각은 어느 쪽으로 할까요?"] });
	expect(unreadQuestions(`[ask] 정할 게 하나예요.\n\n${CARD}`)).toEqual([]);
	expect(unreadQuestions("[done] 원인을 찾았어요. 왜 멈췄을까요?\n- 디스크가 찼어요.\n- 로그가 커졌어요.")).toEqual([]);
	expect(askFault(`[ask] 정리 끝났어요.\n\n결정: 어떻게 할까요?\n**1) 바로 반영**\n**2) 보류**`)).toEqual({ kind: "title", title: "어떻게 할까요?" });
	expect(askFault("[run] 고치는 중이에요. 어느 쪽이 나은지 알려 주세요.")).toEqual({ kind: "prose", line: "고치는 중이에요. 어느 쪽이 나은지 알려 주세요." });
	expect(askFault(`[ask] 백업을 옮길게요.\n\n${CARD}`)).toBeUndefined();
});

test("D2: a typed message that starts with a number but asks back is a question, never the pick of that option", () => {
	for (const back of ["1. 근데 이거 왜 이렇게 되냐", "1. 근데 …냐", "2번이 뭐예요?", "1) 이건 언제 끝나나요", "1, 2 둘 다 되는지"]) expect(numberLedQuestion(back)).toBe(true);
	for (const pick of ["1", "1.", "1번", "1번으로 해 주세요", "2) 클라우드", "1. 네", "1번 좋아요", "근데 이거 왜 이래?"]) expect(numberLedQuestion(pick)).toBe(false);
});

test("D2: a typed answer that starts with a number but asks back picks no option of the open card; a plain pick still does", () => {
	const options = [{ n: 1, label: "외장 디스크" }, { n: 2, label: "클라우드" }];
	for (const back of ["1. 근데 이거 왜 이렇게 되냐", "2번이 뭐예요?"]) expect(answersOption(options, back)).toBe(false);
	for (const pick of ["1", "2번으로 해 주세요", "2) 클라우드"]) expect(answersOption(options, pick)).toBe(true);
});

test("a quoted line or a quoted wording at the end of a report asks the owner nothing", () => {
	for (const end of ["> 배포 시각을 알려 주세요", "버튼 문구를 `알려 주세요`로 바꿨어요.", "버튼 문구를 \"선택해 주세요\"로 바꿨어요", "입력창 안내를 결과를 알려 주세요로 바꿨어요"])
		expect(askFault(`[done] sample-2 설정 화면을 고쳤어요.\n${end}`)).toBeUndefined();
});

test("a question an [ask] answers itself with a list, above its card, is no unread question", () => {
	const text = `[ask] 정리했어요.\n\n무엇이 바뀌나요?\n- 화면 제목이 바뀌어요.\n- 푸시 문구가 바뀌어요.\n\n${CARD}`;
	expect(unreadQuestions(text)).toEqual([]);
	expect(askFault(text)).toBeUndefined();
});
