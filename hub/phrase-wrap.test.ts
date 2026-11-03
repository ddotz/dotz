import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The copy-text chunker (web/js/01-phrase-wrap.js): where a line may break, as sentences > clauses > phrases > units.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "01-phrase-wrap.js"), "utf8");
const { phraseChunks, phraseTree } = new Function(`${src.slice(0, src.indexOf("const WPH_COPY"))}\nreturn { phraseChunks, phraseTree };`)() as {
	phraseChunks: (t: string) => string[][][][];
	phraseTree: (t: string) => unknown[] | null;
};
type Item = [string | Item[] | Item[][], string];
const rejoin = (list: Item[]): string => list.map(([c, g], i) => (typeof c === "string" ? c : rejoin(c as Item[])) + (i < list.length - 1 ? g : "")).join("");

describe("phrase chunks", () => {
	test("sentence ends, then the comma clause, then the connective; the parenthetical stays one unit", () => {
		expect(phraseChunks("규칙과 한도에 따라 계정을 골라요. 쓰던 계정이 막히면 다른 계정으로 넘어가고, 모두 막히면 폴백 순서(API 키 포함)를 따라요.")).toEqual([
			[[["규칙과", "한도에", "따라", "계정을", "골라요."]]],
			[
				[["쓰던", "계정이", "막히면"], ["다른", "계정으로", "넘어가고,"]],
				[["모두", "막히면"], ["폴백", "순서(API 키 포함)를", "따라요."]],
			],
		]);
	});
	test("a middle dot ends an item and stays on its line; 한도에 걸리면 is one phrase", () => {
		expect(phraseChunks("아직 안 정했어요 · 한도에 걸리면 한 번 물어봐요")).toEqual([[[["아직", "안 정했어요 ·"]]], [[["한도에", "걸리면"], ["한 번 물어봐요"]]]]);
	});
	test("a one-syllable word and a short Latin word hold on to the next word", () => {
		expect(phraseChunks("구독 계정이나 API 키를 하나 더 넣어요.")).toEqual([[[["구독", "계정이나", "API 키를", "하나", "더 넣어요."]]]]);
	});
	test("a quoted group never splits", () => {
		expect(phraseChunks('채팅에서 "댓글 답글 써 줘"라고 해 보세요.')).toEqual([[[["채팅에서", '"댓글 답글 써 줘"라고'], ["해 보세요."]]]]);
	});
	test("one phrase of plain words is left alone", () => {
		expect(phraseTree("dotz 데모예요.")).toBeNull();
		expect(phraseTree("한 번 물어봐요")).toBeNull();
	});
	test("joining the chunks with their gaps gives the text back", () => {
		const t = "새 버전을 받아요.\n  테스트가 실패하면,  그대로 두고 (이 컴퓨터에서) 알려요 · 끝";
		expect(rejoin(phraseTree(t) as Item[])).toBe(t);
	});
});
