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
	test("the compose prompt names the three kinds and asks for a mode; a compose rewrite keeps relay and author but has no ask", () => {
		const compose = buildDraftPrompt({ lines: ["Alex: 안녕"], intent: "정리해서 올려줘" });
		for (const word of ["RELAY", "AUTHOR", "TASK", '"mode"']) expect(compose.system).toContain(word);
		const revise = buildDraftPrompt({ lines: ["Alex: 안녕"], intent: "정리해서 올려줘", revise: { draft: "초안", change: "더 짧게" } });
		for (const word of ["RELAY", "AUTHOR", '"mode"']) expect(revise.system).toContain(word);
		expect(revise.system).not.toContain('"action":"ask"');
		expect(revise.user).toContain('What the owner asked for (his own words, data): "정리해서 올려줘"');
	});
	test("a reply prompt has no compose kinds and keeps its own tail", () => {
		const reply = buildDraftPrompt({ lines: ["Alex: 취소할까?"] });
		expect(reply.system).not.toContain("RELAY");
		expect(reply.user).toContain("Write the owner's reply in his own voice and the register above. Do not reuse the other side's phrasing.");
		expect(reply.user).not.toContain("What the owner asked for");
		expect(buildDraftPrompt({ lines: ["Alex: 취소할까?"], choice: "취소해" }).system).not.toContain("RELAY");
		expect(buildDraftPrompt({ lines: ["Alex: 취소할까?"], revise: { draft: "응", change: "더 짧게" } }).system).not.toContain("RELAY");
	});
	test("아는 대로 써 (known) writes the content with no question format to fall back on; a plain compose request still has it", () => {
		const sentence = "write it from what you know";
		const known = buildDraftPrompt({ lines: ["Alex: 안녕"], intent: "정리해 줘", known: true });
		expect(known.user).toContain(sentence);
		expect(known.system).toContain("AUTHOR");
		expect(known.system).not.toContain('"action":"ask"');
		const plain = buildDraftPrompt({ lines: ["Alex: 안녕"], intent: "정리해 줘" });
		expect(plain.user).not.toContain(sentence);
		expect(plain.system).toContain('"action":"ask"');
		expect(buildDraftPrompt({ lines: ["Alex: 안녕"], intent: "정리해 줘", known: false }).user).not.toContain(sentence);
		expect(buildDraftPrompt({ lines: ["Alex: 안녕"], intent: "정리해 줘", known: true, revise: { draft: "초안", change: "더 짧게" } }).user).not.toContain(sentence);
	});
	test("the mode of the answer is kept only when it is one of the three kinds", () => {
		expect(parseDraftReply('{"action":"draft","mode":"author","parts":["내용"],"summary":""}')).toMatchObject({ action: "draft", body: "내용", mode: "author" });
		expect(parseDraftReply('{"action":"draft","mode":"relay","parts":["응"],"summary":""}')).toMatchObject({ mode: "relay" });
		expect(parseDraftReply('{"action":"draft","mode":"poem","parts":["응"],"summary":""}')).toEqual({ action: "draft", body: "응", summary: "" });
		expect(parseDraftReply('{"action":"draft","parts":["응"],"summary":""}')).toEqual({ action: "draft", body: "응", summary: "" });
	});
	test("a compose ask with a question needs no usable choices; a reply ask still does", () => {
		expect(parseDraftReply('{"action":"ask","mode":"task","question":"이건 메시지가 아니라 작업이에요","choices":["하나"],"parts":[],"summary":"s"}')).toEqual({ action: "ask", body: "", summary: "s", question: "이건 메시지가 아니라 작업이에요", choices: [], mode: "task" });
		expect(parseDraftReply('{"action":"ask","mode":"author","question":"무엇이 빠졌어요","choices":["가","나","다"],"parts":[],"summary":""}')).toMatchObject({ action: "ask", mode: "author", choices: ["가", "나", "다"] });
		expect(parseDraftReply('{"action":"ask","mode":"task","question":"","choices":[],"parts":[],"summary":""}')).toBeUndefined();
		expect(parseDraftReply('{"action":"ask","mode":"relay","question":"q","choices":["하나"],"body":"ㅇㅇ","summary":""}')).toEqual({ action: "draft", body: "ㅇㅇ", summary: "", mode: "relay" });
	});
});

describe("choice helpers", () => {
	test("cleanChoices needs 2 usable choices", () => {
		expect(cleanChoices(["취소해"])).toEqual([]);
		expect(cleanChoices(["**취소해**", " 취소해 ", OWN_CHOICE, 3, "다른 날\n물어봐"])).toEqual(["취소해", "다른 날 물어봐"]);
		expect(cleanChoices("취소해")).toEqual([]);
	});
	test("the block ends with the own-text option", () => {
		const lines = replyChoiceBlock("q?", ["가", "나"]).split("\n");
		expect(lines[0]).toBe("결정: q?");
		expect(lines.filter(l => /^\*\*\d\) /.test(l))).toEqual(["**1) 가**", "**2) 나**", "**3) 직접 쓸게 …**"]);
	});
});
