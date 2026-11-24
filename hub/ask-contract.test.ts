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

const titleOf = (n: number): string => {
	const subject = "sample-2 알림 문구", question = " · 문구를 바꿀까요?";
	return subject + "긴".repeat(n - [...subject].length - [...question].length) + question;
};
const cardOf = (title: string, own = ""): string => `결정: ${title}\n${own ? `${own}\n` : ""}**1) 바꿔요**\n버튼 문구가 바뀌어요\n**2) 그대로 둬요**\n아무것도 안 바뀌어요`;

test("a card title over 60 characters is too long to read at a glance; 60 or fewer is not", () => {
	expect([...titleOf(61)].length).toBe(61);
	expect(askFault(`[ask] 정리했어요.\n\n${cardOf(titleOf(61))}`)).toEqual({ kind: "long", title: titleOf(61) });
	for (const n of [40, 60]) expect(askFault(`[ask] 정리했어요.\n\n${cardOf(titleOf(n))}`)).toBeUndefined();
});

test("several cards that all show only the shared lead are a fault; one line of a card's own under its head or after its options is enough", () => {
	const three = (own: string[]) => `[ask] 정할 게 세 가지예요.\n\n${["백업 위치 · 옮길까요?", "알림 시각 · 바꿀까요?", "로그 보관 · 줄일까요?"].map((t, i) => cardOf(t, own[i])).join("\n\n")}\n\n번호로 답해 주세요.`;
	expect(askFault(three([]))).toEqual({ kind: "lead", cards: 3 });
	expect(askFault(`${three([])}\n-# 근거: 테스트 3개 통과`)).toEqual({ kind: "lead", cards: 3 });
	expect(askFault(three(["디스크 92% 찼어요(어제부터)", "지금 08:00, 11-20부터", "`~/.dotz/logs` 4.1GB"]))).toBeUndefined();
	expect(askFault(three(["", "", "지금 08:00, 11-20부터"]))).toBeUndefined();
	expect(askFault(three([]).replace("아무것도 안 바뀌어요\n\n결정: 알림", "아무것도 안 바뀌어요\n지금은 08:00에 와요\n\n결정: 알림"))).toBeUndefined();
	expect(askFault(`[ask] 정할 게 하나예요.\n\n${cardOf("백업 위치 · 옮길까요?")}`)).toBeUndefined();
});

test("the shared-lead rule reads any closing line as one, including the English closing MODE asks for", () => {
	const ko = `[ask] 정할 게 세 가지예요.\n\n${["백업 위치 · 옮길까요?", "알림 시각 · 바꿀까요?", "로그 보관 · 줄일까요?"].map(t => cardOf(t)).join("\n\n")}`;
	for (const close of ["각각 번호로 골라 주세요.", "추천: 둘 다 1번이에요."]) expect(askFault(`${ko}\n\n${close}`)).toEqual({ kind: "lead", cards: 3 });
	const enCard = (t: string) => `결정: ${t}\n**1) Change it**\nThe button text changes\n**2) Leave it**\nNothing changes`;
	const en = `[ask] Three things to settle.\n\n${["Backup location · move it?", "Alert time · change it?", "Log retention · shorten it?"].map(enCard).join("\n\n")}\n\nReply with the numbers.`;
	expect(askFault(en)).toEqual({ kind: "lead", cards: 3 });
	expect(askFault(en.replace("**1) Change it**\nThe button text changes\n**2) Leave it**\nNothing changes\n\n결정: Alert", "**1) Change it**\nThe button text changes\n**2) Leave it**\nNothing changes\nThe disk is 92% full since yesterday\n\n결정: Alert"))).toBeUndefined();
});

test("a card title is counted as the owner reads it: a markdown link counts as its text, not its URL", () => {
	const shown = "PR #1234 백업 경로 정리 · 머지할까요?";
	const linked = `[PR #1234 백업 경로 정리](https://github.com/example-owner/example-repo/pull/1234) · 머지할까요?`;
	expect([...linked].length).toBeGreaterThan(60);
	expect(askFault(`[ask] 정리했어요.\n\n${cardOf(linked)}`)).toBeUndefined();
	const longLinked = `[${titleOf(61).split(" · ")[0]}](https://example.com/x) · ${titleOf(61).split(" · ")[1]}`;
	expect(askFault(`[ask] 정리했어요.\n\n${cardOf(longLinked)}`)).toEqual({ kind: "long", title: titleOf(61) });
	expect([...shown].length).toBeLessThan(60);
});

test("a label line under one card's options is that card's own line; only after the last card is it message-wide", () => {
	const labelled = (labels: string[]) => `[ask] 정할 게 두 가지예요.\n\n${["백업 위치 · 옮길까요?", "로그 보관 · 줄일까요?"].map((t, i) => `${cardOf(t)}${labels[i] ? `\n${labels[i]}` : ""}`).join("\n\n")}\n\n번호로 답해 주세요.`;
	expect(askFault(labelled(["영향: 외장 디스크가 꽂혀 있어야 해요", ""]))).toBeUndefined();
	expect(askFault(labelled(["", "주의: 지운 로그는 되돌릴 수 없어요"]))).toEqual({ kind: "lead", cards: 2 });
	expect(askFault(labelled(["", ""]))).toEqual({ kind: "lead", cards: 2 });
});

test("an English sentence that only mentions replying and numbers is not a closing line", () => {
	const enCard = (t: string, own = "") => `결정: ${t}\n**1) Change it**\nThe button text changes\n**2) Leave it**\nNothing changes${own ? `\n${own}` : ""}`;
	const two = (own: string) => `[ask] Two things to settle.\n\n${enCard("Backup location · move it?", own)}\n\n${enCard("Log retention · shorten it?")}`;
	expect(askFault(two("Pick 1 if the numbers on the disk report worry you: 92% full since Monday"))).toBeUndefined();
	expect(askFault(two(""))).toEqual({ kind: "lead", cards: 2 });
	const list = "[done] Compared both exports.\n\nWhich format should the export use?\n1. JSON with numbers as strings\n2. CSV with one row per day";
	expect(askFault(`${list}\n\nI'll reply with the numbers after the rerun.`)?.kind).toBe("unread");
	expect(askFault(`${list}\n\nI'll rerun them after lunch.`)?.kind).toBe("unread");
});

test("a title link with a quoted link title counts as its text, as the push shows it", () => {
	const linked = `[PR #1234 백업 경로 정리](https://github.com/example-owner/example-repo/pull/1234 "백업 경로를 한곳으로") · 머지할까요?`;
	expect([...linked].length).toBeGreaterThan(60);
	expect(askFault(`[ask] 정리했어요.\n\n${cardOf(linked)}`)).toBeUndefined();
});
