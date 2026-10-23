import { describe, expect, test } from "bun:test";
import { cleanChoices, OWN_CHOICE, replyChoiceBlock } from "../choices.ts";
import { buildDraftPrompt, parseDraftReply } from "./draft.ts";

describe("decision detection: the draft model's answer", () => {
	test("an ask keeps the question and 2-4 cleaned choices; the own-text option is the UI's, not the model's", () => {
		const r = parseDraftReply('{"action":"ask","question":" 티켓 취소할까? ","choices":["취소해","다른 날 물어봐","취소해","직접 쓸게","그냥 가자","하나 더","또 하나"],"body":"","summary":"s"}');
		expect(r).toEqual({ action: "ask", body: "", summary: "s", question: "티켓 취소할까?", choices: ["취소해", "다른 날 물어봐", "그냥 가자", "하나 더"] });
	});
	test("an ask without a question or with fewer than 2 usable choices is not a question: its draft is used, else it is unusable", () => {
		expect(parseDraftReply('{"action":"ask","question":"?","choices":["하나"],"body":"ㅇㅇ","summary":""}')).toEqual({ action: "draft", body: "ㅇㅇ", summary: "" });
		expect(parseDraftReply('{"action":"ask","question":"","choices":["a","b"],"body":"","summary":""}')).toBeUndefined();
		expect(parseDraftReply('{"action":"ask","question":"q","choices":["가".repeat(30),"b"],"body":"","summary":""}')).toBeUndefined();
	});
	test("a draft and a skip parse as before", () => {
		expect(parseDraftReply('{"action":"draft","body":"응","summary":""}')).toEqual({ action: "draft", body: "응", summary: "" });
		expect(parseDraftReply('{"action":"skip","body":"","summary":""}')?.action).toBe("skip");
	});
	test("the normal prompt has the decision step; a pick prompt has none and carries the pick as data", () => {
		const plain = buildDraftPrompt({ lines: ["Alex: 취소할까?"] });
		expect(plain.system).toContain('"action":"ask"');
		expect(plain.user).not.toContain("취소\"해");
		const pick = buildDraftPrompt({ lines: ["Alex: 취소할까?"], choice: '취소"해' });
		expect(pick.system).not.toContain('"action":"ask"');
		expect(pick.user).toContain("\"취소'해\"");
	});
});

describe("choice helpers", () => {
	test("cleanChoices needs 2 usable choices", () => {
		expect(cleanChoices(["취소해"])).toEqual([]);
		expect(cleanChoices(["**취소해**", " 취소해 ", OWN_CHOICE, 3, "다른 날\n물어봐"])).toEqual(["취소해", "다른 날 물어봐"]);
		expect(cleanChoices("취소해")).toEqual([]);
	});
	test("the block ends with the own-text option", () => {
		expect(replyChoiceBlock("q?", ["가", "나"])).toBe("결정: q?\n**1) 가**\n고른 대로 답장을 써요\n**2) 나**\n고른 대로 답장을 써요\n**3) 직접 쓸게 …**\n적은 글을 답장으로 써요");
	});
});
