import { expect, test } from "bun:test";
import { attachIssues } from "./attach-check.ts";

const kinds = (d: Parameters<typeof attachIssues>[0]) => attachIssues(d).map(i => i.kind);

test("a draft that promises a score and carries no file is missing it", () => {
	const r = attachIssues({ subject: "Re: alpha-song 악보", body: "alpha-song 악보 보내드립니다.", files: [] });
	expect(r.map(i => i.kind)).toEqual(["missing"]);
	expect(r[0]!.text).toContain("첨부파일이 없어요");
});

test("a score and an audio promised but only the pdf attached: the audio is partial", () => {
	const r = attachIssues({ subject: "Re: alpha-song", body: "alpha-song 악보와 MR 음원 보내드립니다.", files: ["alpha-song.pdf"] });
	expect(r.map(i => i.kind)).toEqual(["partial"]);
	expect(r[0]!.text).toContain("음원");
});

test("an audio-only reply with a pdf attached carries a kind nobody promised or asked for", () => {
	const r = attachIssues({ subject: "Re: alpha-song MR", body: "alpha-song MR 음원 보내드립니다.", files: ["alpha-song MR.mp3", "alpha-song.pdf"], request: "alpha-song MR 부탁드립니다." });
	expect(r.map(i => i.kind)).toEqual(["extra"]);
	expect(r[0]!.text).toContain("악보·문서");
});

test("a kind the received mail asked for is not extra", () => {
	expect(kinds({ subject: "Re: alpha-song", body: "alpha-song MR 음원 보내드립니다.", files: ["alpha-song MR.mp3", "alpha-song.pdf"], request: "alpha-song 악보도 같이 부탁드립니다." })).toEqual([]);
});

test("three files of which two have nothing to do with the draft", () => {
	const r = attachIssues({ subject: "Re: alpha-song 악보", body: "alpha-song 악보 보내드립니다.", files: ["alpha-song.pdf", "unrelated-one.pdf", "other-thing.pdf"] });
	expect(r.map(i => i.kind)).toEqual(["unrelated"]);
	expect(r[0]!.text).toContain("unrelated-one.pdf, other-thing.pdf");
});

test("two cuts of one audio file are variants", () => {
	const r = attachIssues({ subject: "Re: song MR", body: "song MR 음원 보내드립니다.", files: ["song MR (1).mp3", "song MR (2).mp3"] });
	expect(r.map(i => i.kind)).toEqual(["variants"]);
	expect(r[0]!.text).toContain("song MR (1).mp3, song MR (2).mp3");
});

test("a conditional promise, a refer-back, a question back and a sale sentence promise nothing", () => {
	for (const body of ["곡 제목을 알려 주시면 악보를 보내드리겠습니다.", "보내드린 악보는 개인 연습용으로만 써 주세요.", "어느 곡 악보가 필요하신가요? 알려 주세요.", "총보는 판매하고 있어요."]) expect(kinds({ subject: "Re: 문의", body, files: [] })).toEqual([]);
});

test("two different songs with their audio are not variants of each other", () => {
	expect(kinds({ subject: "Re: alpha-song, beta-song", body: "alpha-song, beta-song 악보와 MR 음원 보내드립니다.", files: ["alpha-song.pdf", "alpha-song MR.mp3", "beta-song.pdf", "beta-song MR.mp3"] })).toEqual([]);
});

test("a draft whose words and files agree has no issue", () => {
	expect(kinds({ subject: "Re: alpha-song 악보", body: "alpha-song 악보 보내드립니다.", files: ["alpha-song.pdf"] })).toEqual([]);
	expect(kinds({ subject: "Re: 일정", body: "확인해 보고 말씀드릴게요.", files: [] })).toEqual([]);
});
