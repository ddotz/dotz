import { expect, test } from "bun:test";
import { attachIssues } from "./attach-check.ts";

const kinds = (d: Parameters<typeof attachIssues>[0]) => attachIssues(d).map(i => i.kind);

test("a draft that promises a brief and carries no file is missing it", () => {
	const r = attachIssues({ subject: "Re: alpha-song 문서", body: "alpha-song 문서 보내드립니다.", files: [] });
	expect(r.map(i => i.kind)).toEqual(["missing"]);
	expect(r[0]!.text).toContain("첨부파일이 없어요");
});

test("a brief and an audio promised but only the pdf attached: the audio is partial", () => {
	const r = attachIssues({ subject: "Re: alpha-song", body: "alpha-song 문서와 음원 보내드립니다.", files: ["alpha-song.pdf"] });
	expect(r.map(i => i.kind)).toEqual(["partial"]);
	expect(r[0]!.text).toContain("음원");
});

test("an audio-only reply with a pdf attached carries a kind nobody promised or asked for", () => {
	const r = attachIssues({ subject: "Re: alpha-song 음원", body: "alpha-song 음원 보내드립니다.", files: ["alpha-song 음원.mp3", "alpha-song.pdf"], request: "alpha-song 음원 부탁드립니다." });
	expect(r.map(i => i.kind)).toEqual(["extra"]);
	expect(r[0]!.text).toContain("문서");
});

test("a kind the received mail asked for is not extra", () => {
	expect(kinds({ subject: "Re: alpha-song", body: "alpha-song 음원 보내드립니다.", files: ["alpha-song 음원.mp3", "alpha-song.pdf"], request: "alpha-song 문서도 같이 부탁드립니다." })).toEqual([]);
});

test("three files of which two have nothing to do with the draft", () => {
	const r = attachIssues({ subject: "Re: alpha-song 문서", body: "alpha-song 문서 보내드립니다.", files: ["alpha-song.pdf", "unrelated-one.pdf", "other-thing.pdf"] });
	expect(r.map(i => i.kind)).toEqual(["unrelated"]);
	expect(r[0]!.text).toContain("unrelated-one.pdf, other-thing.pdf");
});

test("two cuts of one audio file are variants", () => {
	const r = attachIssues({ subject: "Re: song 음원", body: "song 음원 보내드립니다.", files: ["song 음원 (1).mp3", "song 음원 (2).mp3"] });
	expect(r.map(i => i.kind)).toEqual(["variants"]);
	expect(r[0]!.text).toContain("song 음원 (1).mp3, song 음원 (2).mp3");
});

test("a conditional promise, a refer-back, a question back and a sale sentence promise nothing", () => {
	for (const body of ["곡 제목을 알려 주시면 문서를 보내드리겠습니다.", "보내드린 문서는 개인 연습용으로만 써 주세요.", "어느 곡 문서가 필요하신가요? 알려 주세요.", "자료는 판매하고 있어요."]) expect(kinds({ subject: "Re: 문의", body, files: [] })).toEqual([]);
});

test("two different songs with their audio are not variants of each other", () => {
	expect(kinds({ subject: "Re: alpha-song, beta-song", body: "alpha-song, beta-song 문서와 음원 보내드립니다.", files: ["alpha-song.pdf", "alpha-song.mp3", "beta-song.pdf", "beta-song.mp3"] })).toEqual([]);
});

test("the mail asked for a brief and the audio, the body and the files carry the audio alone", () => {
	const r = attachIssues({ subject: "Re: 학예회", body: "alpha-song 음원 보내드립니다.", files: ["alpha-song 음원.mp3"], request: "alpha-song 문서 부탁드립니다. 음원도 부탁드려요." });
	expect(r.map(i => i.kind)).toEqual(["partial"]);
	expect(r[0]!.text).toContain("문서");
});

test("what the mail did not ask for itself is not missing: a sentence that does not ask, a quote, or what the body speaks of", () => {
	const audio = { subject: "Re: alpha-song", body: "alpha-song 음원 보내드립니다.", files: ["alpha-song 음원.mp3"] };
	expect(kinds({ ...audio, request: "문서를 구입했습니다. 음원 부탁드립니다." })).toEqual([]);
	expect(kinds({ ...audio, request: "음원 부탁드립니다.\n-----Original Message-----\n문서 부탁드립니다." })).toEqual([]);
	expect(kinds({ ...audio, request: "음원 부탁드립니다.\n> 문서 부탁드립니다." })).toEqual([]);
	expect(kinds({ ...audio, body: "alpha-song 음원 보내드립니다. 문서는 사이트에서 구매해 주세요.", request: "문서와 음원 부탁드립니다." })).toEqual([]);
});

test("more numbered parts promised than files of any kind", () => {
	const body = "메들리곡집 1탄, 2탄, 3탄 문서 보내드립니다.";
	const r = attachIssues({ subject: "Re: 메들리곡집", body, files: ["메들리곡집 3탄.pdf", "메들리곡집 3탄 음원.mp3"], request: "메들리곡집 문서와 음원 부탁드립니다." });
	expect(r.map(i => i.kind)).toEqual(["partial"]);
	expect(r[0]!.text).toContain("1탄, 2탄, 3탄");
	expect(kinds({ subject: "Re: 메들리곡집", body: "메들리곡집 1,2,3탄 문서 보내드립니다.", files: ["메들리곡집 3탄.pdf"] })).toEqual(["partial"]);
	// A name need not carry its number.
	expect(kinds({ subject: "Re: 메들리곡집", body, files: ["메들리곡집 첫곡.pdf", "메들리곡집 2탄.pdf", "메들리곡집 3탄.pdf"] })).toEqual([]);
});

test("a reply to a mail that asks for a file promises it without naming it; a condition still promises nothing", () => {
	const request = "문서 받을 수 있을까요?";
	expect(kinds({ subject: "Re: 문의", body: "메들리곡집 모두 보내드리겠습니다.", files: [], request })).toEqual(["missing"]);
	expect(kinds({ subject: "Re: 문의", body: "곡을 알려 주시면 보내드리겠습니다.", files: [], request })).toEqual([]);
});

test("a title in another script is known from a file of the same work that carries both", () => {
	const on = { subject: "Re: 문서", body: "노을빛바다 문서와 음원 보내드립니다.", request: "문서와 음원 부탁드립니다." };
	expect(kinds({ ...on, files: ["노을빛바다Sunset 음원.mp3", "Sunset 회의.pdf"] })).toEqual([]);
	expect(kinds({ ...on, files: ["노을빛바다 음원.mp3", "노을빛바다.pdf", "Sunset 회의.pdf"] })).toEqual(["unrelated"]);
});

test("parts of one title named after a dash are different files; the same name cut twice still is not", () => {
	const on = { subject: "Re: 노을빛바다의 긴 노래", body: "노을빛바다의 긴 노래 문서 보내드립니다." };
	expect(kinds({ ...on, files: ["노을빛바다의 긴 노래 - Alto.pdf", "노을빛바다의 긴 노래 - Tenor.pdf"] })).toEqual([]);
	expect(kinds({ ...on, files: ["노을빛바다의 긴 노래 - Alto.pdf", "노을빛바다의 긴 노래 - Alto (1).pdf"] })).toEqual(["variants"]);
});

test("a short word the draft says on its own ties the files that share it, a word it only contains does not", () => {
	const files = ["alpha-song.pdf", "리듬 MR 1절.mp3", "멜로디 MR 2절.mp3"];
	expect(kinds({ subject: "Re: alpha-song", body: "alpha-song 문서와 MR 음원 보내드립니다.", files })).toEqual([]);
	expect(kinds({ subject: "Re: alpha-song", body: "alpha-song 문서와 MRI 음원 보내드립니다.", files })).toEqual(["unrelated"]);
	expect(kinds({ subject: "Re: alpha-song", body: "alpha-song 문서와 the 음원 보내드립니다.", files: ["alpha-song.pdf", "the 리듬 1절.mp3", "the 멜로디 2절.mp3"] })).toEqual(["unrelated"]);
});

test("a draft whose words and files agree has no issue", () => {
	expect(kinds({ subject: "Re: alpha-song 문서", body: "alpha-song 문서 보내드립니다.", files: ["alpha-song.pdf"] })).toEqual([]);
	expect(kinds({ subject: "Re: 일정", body: "확인해 보고 말씀드릴게요.", files: [] })).toEqual([]);
});

test("a file named by a short shared title and a variant marker is on topic when the draft says the title; an author's name over two works still flags the other work", () => {
	const on = { subject: "달빛, 정원 자료", body: "안녕하세요. 달빛, 정원 MR과 가사 보내드립니다." };
	expect(kinds({ ...on, files: ["달빛 inst.mp3", "달빛 가사.pdf"] })).toEqual([]);
	expect(kinds({ ...on, files: ["달빛 inst.mp3", "달빛 MR.mp3"] })).toEqual([]);
	expect(kinds({ subject: "봄바람 자료", body: "안녕하세요. 봄바람 MR과 가사 보내드립니다.", files: ["봄바람 inst.mp3", "봄바람 가사.pdf"] })).toEqual([]);
	// A file with nothing but the title (or only noise/variant words besides it) is that work too.
	expect(kinds({ ...on, files: ["달빛.mp3", "달빛 가사.pdf"] })).toEqual([]);
	expect(kinds({ ...on, files: ["달빛 full.mp3", "달빛 가사.pdf"] })).toEqual([]);
	// The author is named by the draft too, but 새벽 is another work, not a variant of the one it sends.
	expect(kinds({ subject: "홍길동 별빛", body: "홍길동 작곡 별빛 문서 보내드립니다.", files: ["홍길동 별빛.pdf", "홍길동 새벽.pdf"] })).toEqual(["unrelated"]);
	expect(kinds({ subject: "별빛", body: "별빛 문서 보내드립니다.", files: ["홍길동 별빛.pdf", "홍길동 새벽.pdf"] })).toEqual(["unrelated"]);
	expect(attachIssues({ subject: "별빛", body: "별빛 문서 보내드립니다.", files: ["홍길동 별빛.pdf", "홍길동.pdf"] })[0]!.text).toContain("홍길동.pdf");
});
