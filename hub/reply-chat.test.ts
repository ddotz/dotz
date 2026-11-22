// The readers of the owner's typed chat and of the model's marker lines (the reply intent design, 2026-11-16), as tables of real lines.
import { expect, test } from "bun:test";
import { ownerText } from "./owner-text.ts";
import { applyCardMarkers, cardLine, cardMarkers, ownerIntent, ownerPick } from "./reply-chat.ts";

const one = { cards: [{ ref: "RAAAAAA" }] };
const read = (text: string, o: Parameters<typeof ownerIntent>[1] = one) => ownerIntent({ text }, o);

test("only a card option typed out whole is a pick; number and name must agree and a 고치기 carries its change", () => {
	expect(ownerPick("1) 보내기")).toEqual({ act: "send" });
	expect(ownerPick("4) 이대로 보내기")).toEqual({ act: "send", asIs: true });
	expect(ownerPick("3) 보내지 않기")).toEqual({ act: "drop" });
	expect(ownerPick("2) 고치기 - 더 정중하게")).toEqual({ act: "revise", change: "더 정중하게" });
	for (const t of ["2) 보내기", "1) 이대로 보내기", "2) 고치기", "1) 보내기 그리고 화면도 고쳐", "고치기: 인사 빼고", "1) 보내기\n2) 고치기\n3) 보내지 않기"]) expect([t, ownerPick(t)]).toEqual([t, undefined]);
});

// The owner's real lines (server.md S2, the local and 안내문 inboxes) that keyword rules acted on, or would have: each is the model's to read now.
test("typed chat that is no card option typed out acts on no card, whatever its words", () => {
	for (const t of ["보내", "응", "네", "좋아", "ㅇㅇ", "보내지 마", "취소", "메일 안 보내도 돼", "답장 좀 더 짧게. 화요일 얘기는 빼", "메일 말투는 반말로", "아 빌드 그만해. 좀 한번에.빌드하자", "ㄴㄴ 아 그거 아니야 그건 없애고. 해치 관련된거였음", "회의 취소됐어", "그만 고민하고 그냥 보내", "더 딥하게 한번 더 돌려보고. 결과물 pdf로 만들어서 메일 회신해. 해당 부분만 추출해서 보내면 됨. 기존에 전체 내용은 ㄴㄴ"])
		expect([t, read(t)]).toEqual([t, undefined]);
});

test("which card: the quoted open card, else the only open one; two cards and no quote, a quote of anything else or no card is none", () => {
	expect(read("1) 보내기")).toEqual({ act: "send", ref: "RAAAAAA" });
	expect(read("2) 고치기 - 짧게")).toEqual({ act: "revise", change: "짧게", ref: "RAAAAAA" });
	const two = { cards: [{ ref: "RAAAAAA" }, { ref: "RBBBBBB" }] };
	expect(read("1) 보내기", two)).toBeUndefined();
	expect(read("3) 보내지 않기", { ...two, quoted: "RBBBBBB" })).toEqual({ act: "drop", ref: "RBBBBBB" });
	expect(read("1) 보내기", { ...one, quoted: "RGONE00" })).toBeUndefined();
	expect(read("1) 보내기", { cards: [] })).toBeUndefined();
});

test("the line after a typed 보내 names the recipient, the start of the text and the seconds left to undo", () => {
	const item = { draft: { state: "pending" as const, toLabel: "받는이", to: "kim@example.com", text: `${"가".repeat(50)}` }, send: { state: "undo" as const, at: 0, until: 9_600, actions: [] } };
	const line = cardLine("send", item, 0);
	expect(line).toContain("kim@example.com");
	expect(line).toContain(`${"가".repeat(40)}…`);
	expect(line).not.toContain("가".repeat(41));
	expect(line).toContain("10초");
	expect(cardLine("send", { draft: item.draft }, 0)).not.toContain("초 안에");
});

test("the model's marker lines: one per open card, leading its line; the rest of the post is what the owner reads", () => {
	expect(cardMarkers("답이에요\n[send RSQMWMR]", ["RSQMWMR"])).toEqual({ acts: [{ act: "send", ref: "RSQMWMR" }], rest: "답이에요", unknown: [] });
	expect(cardMarkers("[drop mail:abc]", ["mail:abc"]).acts).toEqual([{ act: "drop", ref: "mail:abc" }]);
	// B3: real refs carry ":" (mail:<id>, indi:57259637).
	expect(cardMarkers("고칠게요\n[revise indi:57259637] 인사 빼고", ["indi:57259637"])).toEqual({ acts: [{ act: "revise", ref: "indi:57259637", change: "인사 빼고" }], rest: "고칠게요", unknown: [] });
	const empty = cardMarkers("[revise RAAAAAA]", ["RAAAAAA"]);
	expect([empty.acts, empty.unknown.map(u => u.ref)]).toEqual([[], ["RAAAAAA"]]);
	const gone = cardMarkers("알겠어요\n[send RZZZZZZ]", ["RAAAAAA"]);
	expect([gone.acts, gone.rest, gone.unknown.map(u => u.verb)]).toEqual([[], "알겠어요", ["send"]]);
	const both = cardMarkers("[send RAAAAAA]\n[drop RAAAAAA]", ["RAAAAAA"]);
	expect([both.acts, both.unknown.length]).toEqual([[], 2]);
	expect(cardMarkers("그래서 [send RAAAAAA] 할게요", ["RAAAAAA"])).toEqual({ acts: [], rest: "그래서 [send RAAAAAA] 할게요", unknown: [] });
});

test("a marker line no open card took never reaches the owner; one inside a sentence stays", () => {
	expect(ownerText("답이에요\n[send X1]")).toBe("답이에요");
	expect(ownerText("[drop mail:abc]\n나머지")).toBe("나머지");
	expect(ownerText("답이에요\n[revise X1] 짧게")).toBe("답이에요");
	expect(ownerText("그래서 [send R1] 할게요")).toBe("그래서 [send R1] 할게요");
});

test("two revise markers for one card are one revision with both changes; a contradicting pair acts on nothing and the owner is told once", async () => {
	const joined = cardMarkers("고칠게요\n[revise RAAAAAA] 인사 빼고\n[revise RAAAAAA] 더 짧게", ["RAAAAAA"]);
	expect(joined.acts).toEqual([{ act: "revise", ref: "RAAAAAA", change: "인사 빼고; 더 짧게" }]);
	expect(joined.unknown).toEqual([]);

	const told: string[] = [], acted: string[] = [];
	const done = { status: 200, body: { ok: true as const } };
	const replies = { act: async (i: { ref: string; action: string; change?: string }) => (acted.push(`${i.action} ${i.change ?? ""}`.trim()), done), confirm: async () => done };
	const deps = { replies, owner: { mid: "m1", text: "고쳐 줘" }, tell: async (line: string) => told.push(line), log: () => {} };
	await applyCardMarkers(joined, deps);
	expect(acted).toEqual(["revise 인사 빼고; 더 짧게"]);
	expect(told).toEqual(["고쳐서 카드에 다시 올릴게요"]);

	told.length = acted.length = 0;
	await applyCardMarkers(cardMarkers("[send RAAAAAA]\n[drop RAAAAAA]\n[revise RAAAAAA] 짧게", ["RAAAAAA"]), deps);
	expect(acted).toEqual([]);
	expect(told).toHaveLength(1);
	expect(told[0]).toContain("RAAAAAA");
	expect(told[0]).not.toContain("보낼 카드를 찾지 못했어요");
});
