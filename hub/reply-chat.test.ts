// The readers of typed chat text (design 3.2), as a table of real messages.
import { expect, test } from "bun:test";
import { ownerIntent, reviseMarker } from "./reply-chat.ts";

const one = { cards: [{ ref: "RAAAAAA", newest: true }] };
const read = (text: string, o: Parameters<typeof ownerIntent>[1] = one) => ownerIntent({ text }, o);

test("a change asked in plain words is a revise of the one open card, with the whole message as the change", () => {
	expect(read("좀 더 짧게. 화요일 얘기는 빼")).toEqual({ act: "revise", ref: "RAAAAAA", change: "좀 더 짧게. 화요일 얘기는 빼" });
	expect(read("말투는 반말로")).toEqual({ act: "revise", ref: "RAAAAAA", change: "말투는 반말로" });
	expect(read("2) 고치기 - 더 정중하게")).toEqual({ act: "revise", ref: "RAAAAAA", change: "더 정중하게" });
	expect(read("고치기: 인사 빼고")).toEqual({ act: "revise", ref: "RAAAAAA", change: "인사 빼고" });
});

test("a typed yes sends and a typed no drops", () => {
	expect(read("보내")).toEqual({ act: "send", ref: "RAAAAAA" });
	expect(read("ㅇㅇ")).toEqual({ act: "send", ref: "RAAAAAA" });
	expect(read("보내지 마")).toEqual({ act: "drop", ref: "RAAAAAA" });
});

test("small talk, questions and commands are ordinary chat turns", () => {
	expect(read("그건 그렇고 날씨 어때?")).toBeUndefined();
	expect(read("19번 카드는 위에 있어")).toBeUndefined();
	expect(read("마지막 카드 어디?")).toBeUndefined();
	expect(read("이 메일 원문 보여줘")).toBeUndefined();
	expect(read("짧게".repeat(300))).toBeUndefined();
});

test("which card: a quote wins; two open cards and no quote, or no open card, is about none", () => {
	const two = { cards: [{ ref: "RAAAAAA" }, { ref: "RBBBBBB", newest: true }] };
	expect(read("더 짧게", two)).toBeUndefined();
	expect(read("더 짧게", { ...two, quoted: "RAAAAAA" })).toEqual({ act: "revise", ref: "RAAAAAA", change: "더 짧게" });
	expect(read("더 짧게", { cards: [] })).toBeUndefined();
	expect(read("더 짧게", { cards: [{ ref: "RAAAAAA" }] })).toBeUndefined();
	expect(read("더 짧게", { ...one, quoted: "RGONE00" })).toBeUndefined();
});

test("the model's revise marker is read out of its post only for an open ref", () => {
	expect(reviseMarker("메일 초안을 손볼게요.\n[revise RAAAAAA] 인사를 빼고 더 짧게\n잠시만요", ["RAAAAAA"])).toEqual({ ref: "RAAAAAA", change: "인사를 빼고 더 짧게", rest: "메일 초안을 손볼게요.\n잠시만요" });
	expect(reviseMarker("[revise RZZZZZZ] 더 짧게", ["RAAAAAA"])).toBeUndefined();
	expect(reviseMarker("그냥 답이에요", ["RAAAAAA"])).toBeUndefined();
});
