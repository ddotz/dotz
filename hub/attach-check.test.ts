import { expect, test } from "bun:test";
import { attachIssues, promisesAttachment } from "./attach-check.ts";

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

test("one wrong file, or every file wrong, is unrelated to a draft that names its own topic", () => {
	const draft = { subject: "Re: alpha-song 문서", body: "alpha-song 문서 보내드립니다." };
	for (const files of [["other-thing.pdf"], ["unrelated-one.pdf", "other-thing.pdf"]]) {
		const r = attachIssues({ ...draft, files });
		expect([files, r.map(i => i.kind)]).toEqual([files, ["unrelated"]]);
		for (const f of files) expect(r[0]!.text).toContain(f);
	}
});

test("a topic only the received mail names is enough: its right file is fine, a wrong one is unrelated, a quoted earlier mail names nothing", () => {
	const draft = { subject: "Re: 문의", body: "자료 보내드립니다." };
	expect(kinds({ ...draft, files: ["alpha-song.pdf"], request: "alpha-song 문서 부탁드립니다." })).toEqual([]);
	expect(kinds({ ...draft, files: ["other-thing.pdf"], request: "alpha-song 문서 부탁드립니다." })).toEqual(["unrelated"]);
	expect(kinds({ ...draft, files: ["other-thing.pdf"], request: "자료 부탁드립니다.\n> alpha-song 문서 부탁드립니다." })).toEqual([]);
});

test("the fixed comment-mail template with library files, and generic file names, name no topic to be wrong against", () => {
	const template = "안녕하세요, 홍길동님.\n\n댓글로 요청하신 자료를 보내드립니다. 확인 후 부족한 점이 있으면 편하게 말씀해 주세요.\n\n감사합니다.";
	expect(kinds({ subject: "요청하신 자료 보내드립니다", body: template, files: ["alpha-song.pdf", "beta-song 음원.mp3"] })).toEqual([]);
	expect(kinds({ subject: "요청하신 자료 보내드립니다", body: template, files: ["달빛정원 안내.pdf"] })).toEqual([]);
	expect(kinds({ subject: "Re: alpha-song 문서", body: "alpha-song 문서 보내드립니다.", files: ["scan.pdf"] })).toEqual([]);
	expect(kinds({ subject: "Re: alpha-song 사진", body: "alpha-song 사진 보내드립니다.", files: ["IMG_1234.jpg"] })).toEqual([]);
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

test("a body that sends a file by any word the gate knows, in the verbs a mail uses, is missing it; the other side's attachment is no promise", () => {
	const none = (body: string) => attachIssues({ body, files: [], request: "안부 인사드립니다" }).map(i => i.kind);
	for (const body of ["계약 서류 보내드립니다.", "요청하신 wav 보내드립니다.", "견적서 송부드립니다.", "견적서를 송부했습니다.", "견적서 첨부드렸습니다.", "견적서를 첨부해 드렸습니다.", "견적서를 발송합니다.", "자료 공유드립니다.", "I have enclosed the quote.", "Enclosed are the files.", "Please see the attachment."]) expect([body, none(body)]).toEqual([body, ["missing"]]);
	for (const body of ["Thanks for the attached file.", "I received the attached quote.", "In the attached file you sent, row 3 is wrong.", "Regarding the file you attached, thanks.", "I will not be attaching anything.", "첨부된 견적서 확인 부탁드립니다."]) expect([body, none(body)]).toEqual([body, []]);
});

test("a file the mail asked for and the draft leaves off is skipped, a kind of its own that draft generation does not retry on", () => {
	expect(attachIssues({ body: "확인했습니다.", files: [], request: "계약서 보내 주세요." }).map(i => i.kind)).toEqual(["skipped"]);
});

test("a numbers, key, pages, rtf, odt, rar or 7z file counts as the document the draft promises", () => {
	for (const ext of ["numbers", "key", "pages", "rtf", "odt", "rar", "7z"]) expect([ext, kinds({ subject: "Re: 견적", body: "견적 문서 보내드립니다.", files: [`견적서.${ext}`] })]).toEqual([ext, []]);
});

test("a closer after the send does not put it off, an if-clause before it does; a request to the reader is no send", () => {
	for (const body of ["견적서 첨부드립니다, 확인해 주시면 감사하겠습니다.", "I'm sending you the quote; let me know if you have questions.", "검토해 보시면 좋을 자료 첨부합니다."]) expect([body, kinds({ body, files: [] })]).toEqual([body, ["missing"]]);
	for (const body of ["필요하시면 자료 공유드리겠습니다.", "관련 자료를 보내주시면 검토 후 견적서 보내드리겠습니다.", "If you like, I'll send the quote."]) expect([body, kinds({ body, files: [] })]).toEqual([body, []]);
});

test("a sale notice holds nothing, unless the sentence attaches in so many words", () => {
	expect(kinds({ body: "음원은 온라인 상점에서 판매 중이며 구매 후 안내 이메일을 보내드립니다.", files: [] })).toEqual([]);
	for (const body of ["판매 중인 음원 파일 첨부드립니다.", "판매 보고서 PDF 첨부드립니다."]) expect([body, kinds({ body, files: [] })]).toEqual([body, ["missing"]]);
});

test("a linked ending of an attach is an attach; a request to attach is not", () => {
	for (const body of ["견적서 첨부드리오니 확인 부탁드립니다.", "견적서 첨부드리며 자세한 내용은 본문을 참고해 주세요.", "파일 첨부하오니 참고 바랍니다.", "첨부파일 확인 부탁드립니다.", "견적서를 첨부하여 보내드립니다."]) expect([body, kinds({ body, files: [] })]).toEqual([body, ["missing"]]);
	for (const body of ["서류를 첨부하여 보내주세요.", "사진을 첨부해서 회신 바랍니다.", "보내주신 첨부파일 확인 부탁드립니다.", "받은 첨부 문서 검토 부탁드립니다."]) expect([body, kinds({ body, files: [] })]).toEqual([body, []]);
});

test("a link, a date, an amount or an account is no file, unless it is joined to one", () => {
	for (const body of ["요청하신 영상 링크 공유드립니다: https://youtu.be/example", "음원 구매 링크 보내드립니다.", "사진 촬영 일정 공유드립니다.", "견적서 금액 보내드립니다.", "Here is the document link: https://docs.example.com/view"]) expect([body, kinds({ body, files: [] })]).toEqual([body, []]);
	for (const body of ["견적서와 일정 공유드립니다.", "견적서 및 링크 보내드립니다.", "견적서 내용을 메일로 보내드립니다."]) expect([body, kinds({ body, files: [] })]).toEqual([body, ["missing"]]);
});

test("a reply that declines or points to a store or a link leaves the asked file unflagged; a price note does not", () => {
	const ask = { request: "음원 파일 공유 부탁드립니다." };
	for (const body of ["안녕하세요. 죄송하지만 해당 음원 파일 제공은 어렵습니다.", "보안 규정상 외부 공유 불가합니다.", "해당 음원은 온라인 상점에서 판매하고 있습니다.", "아래 링크에서 바로 내려받으실 수 있습니다: https://example.com/dl"]) expect([body, kinds({ body, files: [], ...ask })]).toEqual([body, []]);
	expect(kinds({ body: "판매 가격은 별도입니다. 확인했습니다.", files: [], ...ask })).toEqual(["skipped"]);
});

test("a file the sender attached is no file asked for, unless the sentence asks for one back; a reply, a link or an account sent is no file", () => {
	expect(kinds({ body: "확인했습니다. 수정 의견 정리해서 회신 보내드립니다.", files: [], request: "첨부한 계약서 검토 부탁드립니다." })).toEqual([]);
	expect(kinds({ body: "작성해서 보내드립니다.", files: [], request: "첨부한 양식 작성해서 보내주세요." })).toEqual(["missing"]);
	expect(kinds({ body: "총액은 50만원이고 입금 계좌번호 보내드립니다.", files: [], request: "견적서 금액만 부탁드립니다." })).toEqual([]);
	expect(kinds({ body: "네, 바로 보내드립니다.", files: [], request: "견적서 부탁드립니다." })).toEqual(["missing"]);
});

test("a sentence that says it is not sending, or sends without a file, claims nothing", () => {
	for (const body of ["죄송하지만 견적서는 안 보내드립니다.", "견적서는 파일 없이 본문에 적어 보내드립니다.", "I am not sending the file this time."]) expect([body, kinds({ body, files: [] })]).toEqual([body, []]);
	expect(kinds({ body: "서류 없이도 신청하실 수 있도록 양식 첨부드립니다.", files: [] })).toEqual(["missing"]);
});

test("promisesAttachment is the gate's own reading: what the gate lets through the card does not warn about", () => {
	expect(promisesAttachment(undefined, "확인 후 내일 따로 견적서 보내드릴게요.")).toBe(false);
	expect(promisesAttachment("Re: 견적서 첨부합니다", "확인했습니다.")).toBe(false);
	expect(promisesAttachment("견적서 첨부합니다", "확인했습니다.")).toBe(true);
	expect(promisesAttachment(undefined, "견적서 첨부드립니다, 확인해 주시면 감사하겠습니다.")).toBe(true);
});
