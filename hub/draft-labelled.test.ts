import { describe, expect, test } from "bun:test";
import { askComponentsFor } from "./askbuttons.ts";
import { parseDraftApproval, parseQuotedDraft, refreshDraft } from "./draft-approval.ts";
import { shownEvent, ownerText } from "./owner-text.ts";
import { SHOT_LABELLED } from "./owner-text.fixture.ts";

// One parser owns the quoted block of a send approval, whatever order a session wrote its fields in: the labels are fields, never words of the body.
const BODY = "PaddleOCR, 사내 AI 이미지 인식, 앱 로그인이 들어간 시험판이에요.";
const block = (...quoted: string[]) => ["[ask] 메일이에요", ...quoted.map(l => (l ? `> ${l}` : ">")), "결정: 보낼까요? (pilot-1)", "1) 보내기", "2) 고치기", "3) 보내지 않기"].join("\n");

describe("the block as a session wrote it", () => {
	test("the message of 2026-11-05: 본문 and 첨부 are fields", () => {
		const d = parseDraftApproval(SHOT_LABELLED)!;
		expect(d).toMatchObject({ toLabel: "받는이", to: "owner@example.com", subject: "Pilot 시험판 (5d3d419)", attachments: [{ name: "Pilot-portable.zip" }], ref: "pilot-5d3d419" });
		expect(d.body.startsWith(BODY)).toBe(true);
		expect(d.body.endsWith("pilot.log를 보내 주세요.")).toBe(true);
		expect(d.noAttachments).toBeUndefined();
		expect(d.warning).toBeUndefined();
	});
	test("a multi-line 본문 keeps its lines, under its label or on the next line", () => {
		const want = "첫 줄이에요.\n\n둘째 문단이에요.";
		for (const q of [["본문: 첫 줄이에요.", "", "둘째 문단이에요."], ["본문:", "첫 줄이에요.", "", "둘째 문단이에요."], ["", "본문: 첫 줄이에요.", "", "둘째 문단이에요."]])
			expect(parseQuotedDraft(block("받는이: a@example.com", "제목: 안녕", ...q, "첨부: a.zip"))).toMatchObject({ body: want, attachments: [{ name: "a.zip" }] });
	});
	test("every field after the body is read by its label, and the > prefix may sit tight or wide", () => {
		const text = ["> 받는이: a@example.com", ">본문: 안녕하세요", ">   제목: 나중 제목", ">  첨부: a.zip (3MB)", "> 첨부: b.pdf", "결정: 보낼까요? (pilot-1)", "1) 보내기", "2) 고치기", "3) 보내지 않기"].join("\n");
		expect(parseDraftApproval(text)).toMatchObject({ body: "안녕하세요", subject: "나중 제목", attachments: [{ name: "a.zip", size: "3MB" }, { name: "b.pdf" }] });
	});
	test("대상 and 대화방 work the same way", () => {
		expect(parseQuotedDraft(block("대상: 팬 댓글", "본문: 고마워요")) ).toMatchObject({ toLabel: "대상", to: "팬 댓글", body: "고마워요" });
		expect(parseQuotedDraft(block("대화방: 가족", "본문: 저녁 먹자"))).toMatchObject({ toLabel: "대화방", to: "가족", body: "저녁 먹자" });
	});
	test("첨부: 없음 after the body is the empty row, not a word of the mail", () => {
		expect(parseQuotedDraft(block("받는이: a@example.com", "본문: 안녕하세요", "첨부: 없음"))).toMatchObject({ body: "안녕하세요", noAttachments: true });
	});
	test("one 첨부 line naming several files with / is one row per file", () => {
		const d = parseQuotedDraft(block("받는이: a@example.com", "첨부: a.pdf / ★ b, c.xlsx / d.zip", "", "안녕하세요"));
		expect(d?.attachments?.map(f => f.name)).toEqual(["a.pdf", "★ b, c.xlsx", "d.zip"]);
	});
	test("a body that goes on to mention 첨부 in a built block stays the body", () => {
		const text = block("받는이: a@example.com", "첨부: real.pdf", "", "안녕하세요", "첨부: 위 파일 참고");
		expect(parseQuotedDraft(text)).toMatchObject({ body: "안녕하세요\n첨부: 위 파일 참고", attachments: [{ name: "real.pdf" }] });
	});
	test("a stored card re-read takes the clean body and the named file", () => {
		const stale = { toLabel: "받는이", to: "owner@example.com", subject: "Pilot 시험판 (5d3d419)", body: "본문: 옛날 본문\n첨부: Pilot-portable.zip", noAttachments: true as const, ref: "pilot-5d3d419" };
		const d = refreshDraft(stale, SHOT_LABELLED);
		expect(d.body.startsWith(BODY)).toBe(true);
		expect(d.attachments).toEqual([{ name: "Pilot-portable.zip" }]);
		expect(d.noAttachments).toBeUndefined();
	});
});

describe("what every surface prints", () => {
	const printed = ownerText(SHOT_LABELLED);
	test("the shown text is the block in its one shape, so chat and Discord show no 본문 label and no file under the body", () => {
		expect(printed).toContain("> 받는이: owner@example.com\n> 제목: Pilot 시험판 (5d3d419)\n> 첨부: Pilot-portable.zip\n>\n> PaddleOCR");
		expect(printed).not.toContain("본문:");
		expect(printed).toContain("(pilot-5d3d419)");
		expect(parseDraftApproval(printed)).toEqual(parseDraftApproval(SHOT_LABELLED)!);
	});
	test("a stored message reaches the page the same way, and a clean block is left as it is", () => {
		expect(shownEvent({ kind: "lane_report", source: "lane:pilot-stage1", text: SHOT_LABELLED }).text).toBe(printed);
		expect(ownerText(printed)).toBe(printed);
	});
	test("Discord keeps its three buttons", () => {
		const rows = askComponentsFor("lane:pilot-stage1", printed) as { components: { label: string }[] }[];
		expect(rows.flatMap(r => r.components.map(b => b.label))).toEqual(["보내기", "고치기", "보내지 않기"]);
	});
});
