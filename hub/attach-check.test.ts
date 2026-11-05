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

test("the mail asked for a score and the audio, the body and the files carry the audio alone", () => {
	const r = attachIssues({ subject: "Re: 학예회", body: "alpha-song MR 보내드립니다.", files: ["alpha-song MR.mp3"], request: "alpha-song 악보 부탁드립니다. MR도 부탁드려요." });
	expect(r.map(i => i.kind)).toEqual(["partial"]);
	expect(r[0]!.text).toContain("악보·문서");
});

test("what the mail did not ask for itself is not missing: a sentence that does not ask, a quote, or what the body speaks of", () => {
	const audio = { subject: "Re: alpha-song", body: "alpha-song MR 보내드립니다.", files: ["alpha-song MR.mp3"] };
	expect(kinds({ ...audio, request: "악보를 구입했습니다. MR 부탁드립니다." })).toEqual([]);
	expect(kinds({ ...audio, request: "MR 부탁드립니다.\n-----Original Message-----\n악보 부탁드립니다." })).toEqual([]);
	expect(kinds({ ...audio, request: "MR 부탁드립니다.\n> 악보 부탁드립니다." })).toEqual([]);
	expect(kinds({ ...audio, body: "alpha-song MR 보내드립니다. 악보는 사이트에서 구매해 주세요.", request: "악보와 MR 부탁드립니다." })).toEqual([]);
});

test("more numbered parts promised than files of any kind", () => {
	const body = "메들리곡집 1탄, 2탄, 3탄 악보 보내드립니다.";
	const r = attachIssues({ subject: "Re: 메들리곡집", body, files: ["메들리곡집 3탄.pdf", "메들리곡집 3탄 MR.mp3"], request: "메들리곡집 악보와 MR 부탁드립니다." });
	expect(r.map(i => i.kind)).toEqual(["partial"]);
	expect(r[0]!.text).toContain("1탄, 2탄, 3탄");
	expect(kinds({ subject: "Re: 메들리곡집", body: "메들리곡집 1,2,3탄 악보 보내드립니다.", files: ["메들리곡집 3탄.pdf"] })).toEqual(["partial"]);
	// A name need not carry its number.
	expect(kinds({ subject: "Re: 메들리곡집", body, files: ["메들리곡집 첫곡.pdf", "메들리곡집 2탄.pdf", "메들리곡집 3탄.pdf"] })).toEqual([]);
});

test("a reply to a mail that asks for a file promises it without naming it; a condition still promises nothing", () => {
	const request = "악보 받을 수 있을까요?";
	expect(kinds({ subject: "Re: 문의", body: "메들리곡집 모두 보내드리겠습니다.", files: [], request })).toEqual(["missing"]);
	expect(kinds({ subject: "Re: 문의", body: "곡을 알려 주시면 보내드리겠습니다.", files: [], request })).toEqual([]);
});

test("a title in another script is known from a file of the same work that carries both", () => {
	const on = { subject: "Re: 악보", body: "노을빛바다 악보와 MR 보내드립니다.", request: "악보와 MR 부탁드립니다." };
	expect(kinds({ ...on, files: ["노을빛바다Sunset MR.mp3", "Sunset 합주.pdf"] })).toEqual([]);
	expect(kinds({ ...on, files: ["노을빛바다 MR.mp3", "노을빛바다.pdf", "Sunset 합주.pdf"] })).toEqual(["unrelated"]);
});

test("a draft whose words and files agree has no issue", () => {
	expect(kinds({ subject: "Re: alpha-song 악보", body: "alpha-song 악보 보내드립니다.", files: ["alpha-song.pdf"] })).toEqual([]);
	expect(kinds({ subject: "Re: 일정", body: "확인해 보고 말씀드릴게요.", files: [] })).toEqual([]);
});
