import { expect, test } from "bun:test";
import { leaksHandoff, stripHandoff } from "./tone.ts";

test("stripHandoff drops a leading handoff paragraph, keeps For you when nothing else is left, leaves other text alone", () => {
	expect(stripHandoff("Ask: fix it - wanted: fixed. For you: done. Now: none. Next: none.\n\n[done] 고쳤어요.\n- 근거")).toBe("[done] 고쳤어요.\n- 근거");
	expect(stripHandoff("Ask: a - wanted: b.\nFor you: 3/4 끝났어요. Now: 확인. Next: 커밋.")).toBe("3/4 끝났어요.");
	expect(stripHandoff("Ask: 이건 그냥 질문이에요\n\n다음 줄")).toBe("Ask: 이건 그냥 질문이에요\n\n다음 줄");
	expect(stripHandoff("[done] 끝\n\nAsk: x For you: y")).toBe("[done] 끝\n\nAsk: x For you: y");
});

test("leaksHandoff needs For you, Now and Next together, so ordinary text and the owner's For <bot> line pass", () => {
	expect(leaksHandoff("[done] 끝\n\nFor you: 요약. Now: 없음. Next: 없음.")).toBe(true);
	expect(leaksHandoff("[done] 끝\n- 근거: 테스트\nFor dotz: 재시작이 필요해요")).toBe(false);
	expect(leaksHandoff("Now: 확인. Next: 커밋.")).toBe(false);
});
