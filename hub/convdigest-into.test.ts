import { expect, test } from "bun:test";
import { createConvDigest } from "./convdigest.ts";

test("takeInto(key) lists what another session wrote in that conversation, once, and never the session's own posts", () => {
	const d = createConvDigest();
	d.note("ch:1", "bot", "메인이 올린 글", Date.now(), "main");
	d.note("ch:1", "bot", "자기 답", Date.now(), "ch:1");
	d.note("ch:1", "owner", "주인님 말", Date.now());
	d.note("ch:2", "bot", "다른 대화에 올린 글", Date.now(), "main");
	const text = d.takeInto("ch:1");
	expect(text).toContain("메인이 올린 글");
	expect(text).not.toContain("자기 답");
	expect(text).not.toContain("주인님 말");
	expect(text).not.toContain("다른 대화");
	expect(d.takeInto("ch:1")).toBe("");
	expect(d.takeInto("main")).toBe("");
	d.note("ch:1", "bot", "또 올린 글", Date.now(), "main");
	expect(d.takeInto("ch:1")).toContain("또 올린 글");
});

test("the digest says its lines are reference only, and a choice answer in it is shortened to a neutral marker", () => {
	const d = createConvDigest();
	d.note("ch:1", "owner", "1) 네, 배포해요");
	d.note("ch:1", "bot", "결정: 배포 진행으로 정했어요", Date.now(), "ch:1");
	d.note("ch:2", "owner", "내일 날씨 어때?");
	const text = d.take("main");
	expect(text.startsWith("[다른 대화에서 최근에 오간 것")).toBe(true);
	expect(text.split("\n")[0]).toContain("참고");
	expect(text).toContain("(선택 답함)");
	expect(text).not.toContain("배포해요");
	expect(text).not.toContain("배포 진행");
	expect(text).toContain("내일 날씨 어때?");
});
