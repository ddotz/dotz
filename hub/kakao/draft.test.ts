import { describe, expect, test } from "bun:test";
import { basisOf, buildDraftPrompt, chatLines, DRAFT_MODEL, MAX_PAIRS, MAX_PROMPT_CHARS, ownPairs, pickDraftModel, registerOf } from "./draft.ts";
import type { Msg } from "./types.ts";

let n = 0;
const m = (fromMe: boolean, text: string, type = 1): Msg => ({ logId: String(++n), chatId: "1", authorId: fromMe ? "9" : "2", sender: fromMe ? "" : "Alex", text, type, sentAt: n, fromMe });

describe("registerOf", () => {
	test("casual lines are 반말 even with ㅋㅋ, ~ and emoji at the end; polite lines are 존댓말; a mix is 혼용", () => {
		expect(registerOf(["ㅇㅇ 가능", "아직 못봄ㅋㅋ", "그래 ㄱㄱ~", "좋아 😀"])?.label).toBe("반말");
		expect(registerOf(["네 알겠습니다", "확인했어요ㅎㅎ", "감사합니다!", "그건 좀 곤란한데요"])?.label).toBe("존댓말");
		expect(registerOf(["네 알겠습니다", "ㅇㅇ", "그래", "좋아요"])?.label).toBe("혼용");
	});
	test("too few judgeable lines give no register (ㅋㅋ alone and English do not count)", () => {
		expect(registerOf(["ㅋㅋㅋ", "ok", "응"])).toBeUndefined();
	});
});

describe("ownPairs", () => {
	test("each owner turn is paired with what the other side said just before it; a photo counts as the other side's line", () => {
		const list = [m(false, "밥 먹었어요?"), m(false, "오늘 시간 돼요?"), m(true, "ㅇㅇ"), m(true, "됨"), m(false, "pic", 2), m(true, "오 ㅋㅋ")];
		expect(ownPairs(list)).toEqual([
			{ other: ["밥 먹었어요?", "오늘 시간 돼요?"], own: ["ㅇㅇ", "됨"] },
			{ other: ["(사진·파일)"], own: ["오 ㅋㅋ"] },
		]);
	});
	test("a room with no other side has no pairs, and only the newest pairs are kept", () => {
		expect(ownPairs([m(true, "memo 1"), m(true, "memo 2")])).toEqual([]);
		const long = Array.from({ length: 30 }, (_, i) => [m(false, `q${i}`), m(true, `a${i}`)]).flat();
		const pairs = ownPairs(long);
		expect(pairs).toHaveLength(MAX_PAIRS);
		expect(pairs.at(-1)).toEqual({ other: ["q29"], own: ["a29"] });
	});
});

describe("emoticon with text", () => {
	test("the chat lines and pairs keep the text written with a sticker; a bare sticker or a photo stays a placeholder", () => {
		const list = [m(false, "고마워", 12), m(false, "", 20), m(false, "pic", 2), m(true, "나도", 25), m(false, "ㅋㅋ", 20), m(true, "", 20), m(true, "응")];
		expect(chatLines(list)).toEqual(["Alex: (이모티콘) 고마워", "Alex: (이모티콘)", "Alex: (사진·파일)", "나: (이모티콘) 나도", "Alex: (이모티콘) ㅋㅋ", "나: (이모티콘)", "나: 응"]);
		expect(ownPairs(list)).toEqual([
			{ other: ["(이모티콘)", "(사진·파일)"], own: ["(이모티콘) 나도"] },
			{ other: ["(이모티콘) ㅋㅋ"], own: ["응"] },
		]);
	});
	test("the basis is the newest incoming message that has words: a sticker with text counts, a bare one does not", () => {
		const withText = [m(false, "안녕"), m(false, "고마워", 12)], bare = [m(false, "안녕"), m(false, "", 12)];
		expect(basisOf(withText, false)).toBe(withText[1]!.logId);
		expect(basisOf(bare, false)).toBe(bare[0]!.logId);
	});
});

describe("buildDraftPrompt", () => {
	test("the register, pairs, voice notes and chat are all in; the chat block holds only the new lines", () => {
		const { user } = buildDraftPrompt({
			lines: ["Alex: 내일 가능하신가요?"],
			pairs: [{ other: ["오늘 되세요?"], own: ["ㅇㅇ 됨"] }],
			register: registerOf(["ㅇㅇ", "그래", "응 좋아"]),
			style: { rules: ["길이: 중앙값 5자"], corrections: [], forbidden: [], samples: [] },
		});
		expect(user).toContain("Register in THIS room: 반말");
		expect(user).toContain("상대: 오늘 되세요?\n나: ㅇㅇ 됨");
		expect(user).toContain("- 길이: 중앙값 5자");
		expect(/<<<CHAT\n([\s\S]*)\nCHAT>>>/.exec(user)![1]).toBe("Alex: 내일 가능하신가요?");
	});

	test("never over the budget: oversized pairs, notes, corrections, context and chat are cut, oldest pairs first, the newest chat line stays", () => {
		const big = (c: string) => c.repeat(300);
		const pairs = Array.from({ length: MAX_PAIRS }, (_, i) => ({ other: [big("가"), big("나")], own: [`own-${i}-${big("다")}`] }));
		const { system, user } = buildDraftPrompt({
			lines: Array.from({ length: 30 }, (_, i) => `Alex: line-${i}-${big("라")}`),
			context: Array.from({ length: 4 }, () => big("마")),
			summary: big("바"),
			pairs,
			style: { rules: Array.from({ length: 30 }, () => big("사")), corrections: Array.from({ length: 30 }, () => big("아")), forbidden: Array.from({ length: 30 }, () => big("자")), samples: [] },
		});
		expect(system.length + user.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
		expect(user).toContain("line-29-");
		expect(user).not.toContain("own-0-");
	});

	test("a normal room (a full set of pairs of short lines) is not cut at all", () => {
		const pairs = Array.from({ length: MAX_PAIRS }, (_, i) => ({ other: [`질문 ${i} 알려 주시겠어요?`], own: [`답 ${i} ㅇㅇ`] }));
		const { user } = buildDraftPrompt({ lines: ["Alex: 내일 되나요?"], pairs });
		expect(user.match(/(^|\n)나: 답 /g)).toHaveLength(MAX_PAIRS);
	});

	test("without pairs the owner's own lines (or the profile examples) are the voice samples", () => {
		expect(buildDraftPrompt({ lines: ["나: memo"], samples: ["메모 하나"] }).user).toContain("- 메모 하나");
		expect(buildDraftPrompt({ lines: ["나: memo"], samples: [], style: { rules: [], corrections: [], forbidden: [], samples: ["예시 줄"] } }).user).toContain("- 예시 줄");
	});
});

describe("pickDraftModel", () => {
	test("a real configured model (Haiku included) is kept; unset, a role, or a mini model becomes sonnet-class", () => {
		expect(pickDraftModel("anthropic/claude-opus-4-1")).toBe("anthropic/claude-opus-4-1");
		for (const bad of [undefined, "", "@tiny", "openai/gpt-5-mini"]) expect(pickDraftModel(bad)).toBe(DRAFT_MODEL);
	});
});
