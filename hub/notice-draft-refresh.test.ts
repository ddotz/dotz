import { expect, test } from "bun:test";
import { refreshNoticeDrafts, type Notice } from "./notices.ts";

// A card stored before the always-shown 첨부 row is re-read on start: a mail draft gains 첨부 없음, its body and ref stay, other cards stay.
test("stored mail cards are re-read with the current rules; body and ref are kept; a card already current or not a draft is untouched", () => {
	const mailText = "> 받는이: buyer@example.com\n> 제목: 자료\n>\n> 안녕하세요.\n보내도 될까요?";
	const list = [
		{ id: "a", text: mailText, decision: { options: [], to: "mail:x", group: 1, state: "open", draft: { toLabel: "받는이", to: "buyer@example.com", subject: "자료", body: "안녕하세요. (원문 전체)", ref: "R1" } } },
		{ id: "b", text: "> 대상: 영상 댓글\n>\n> 고마워요!", decision: { options: [], to: "main", group: 1, state: "open", draft: { toLabel: "대상", to: "영상 댓글", body: "고마워요!" } } },
		{ id: "c", text: "그냥 알림", decision: { options: [], to: "main", group: 1, state: "open" } },
	] as unknown as Notice[];
	expect(refreshNoticeDrafts(list)).toBe(1);
	expect((list[0] as any).decision.draft).toEqual({ toLabel: "받는이", to: "buyer@example.com", subject: "자료", body: "안녕하세요. (원문 전체)", ref: "R1", noAttachments: true });
	expect((list[1] as any).decision.draft).toEqual({ toLabel: "대상", to: "영상 댓글", body: "고마워요!" });
	expect(refreshNoticeDrafts(list)).toBe(0);
});
