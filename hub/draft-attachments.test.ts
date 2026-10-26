import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askText } from "../features/reply-drafts/lib/flow.ts";
import type { DraftRec } from "../features/reply-drafts/lib/store.ts";
import { claimsAttachment, draftApprovalBlock, fileSizeText, NO_ATTACHMENT_WARNING, parseDraftApproval, parseQuotedDraft, quotedDraft } from "./draft-approval.ts";
import { draftFileRoute, stageDraftFiles } from "./draft-files.ts";
import { PEER_GET } from "./peer-auth.ts";

const base = { to: "kim@example.com", subject: "견적서 회신", body: "안녕하세요.\n\n견적서 보내 드립니다.", ref: "RABC123" };
const calm = { ...base, body: "안녕하세요.\n\n확인했어요." };
const two = [
	{ name: "견적서 (최종).pdf", size: 348_160 },
	{ name: "현장사진.jpg", size: 2_516_582 },
];

describe("attachment lines of the approval block", () => {
	test("each attachment is a quoted 첨부 line with its size, and the parser reads them back apart from the body", () => {
		const text = `[ask] 답장 초안\n${draftApprovalBlock({ ...base, attachments: two })}`;
		expect(text).toContain("> 첨부: 견적서 (최종).pdf (340KB)\n> 첨부: 현장사진.jpg (2.4MB)\n>\n> 안녕하세요.");
		const d = parseDraftApproval(text)!;
		expect(d.attachments).toEqual([{ name: "견적서 (최종).pdf", size: "340KB" }, { name: "현장사진.jpg", size: "2.4MB" }]);
		expect(d.noAttachments).toBeUndefined();
		expect(d.warning).toBeUndefined();
		expect(d.ref).toBe("RABC123");
		expect(d.subject).toBe("견적서 회신");
		expect(d.body).toBe("안녕하세요.\n\n견적서 보내 드립니다.");
		expect(parseQuotedDraft(text)!.attachments).toHaveLength(2);
		expect(quotedDraft(text)).toContain("> 첨부: 현장사진.jpg (2.4MB)");
	});

	test("a file without a size keeps its name; a mail without files always says 첨부: 없음, other drafts carry no 첨부 line", () => {
		const d = parseDraftApproval(draftApprovalBlock({ ...base, attachments: [{ name: "메모.txt" }] }))!;
		expect(d.attachments).toEqual([{ name: "메모.txt" }]);
		const plain = draftApprovalBlock(calm);
		expect(plain).toContain("> 첨부: 없음\n");
		const p = parseDraftApproval(plain)!;
		expect(p.attachments).toBeUndefined();
		expect(p.noAttachments).toBe(true);
		// a hand-written mail block with no 첨부 line still reads as 없음, so the card shows the row
		expect(parseDraftApproval("> 받는이: a@b.c\n>\n> 본문\n결정: 보낼까요? (D9)\n**1) 보내기**\n**2) 고치기 …**\n**3) 보내지 않기**")!.noAttachments).toBe(true);
		const comment = draftApprovalBlock({ to: "영상 댓글", toLabel: "대상", body: "고마워요!", ref: "j1" });
		expect(comment).not.toContain("첨부");
		expect(parseDraftApproval(comment)!.noAttachments).toBeUndefined();
	});

	test("none carried: the original had files and the reply has none, so the block says 첨부: 없음", () => {
		const block = draftApprovalBlock({ ...calm, attachmentsNone: true });
		expect(block).toContain("> 제목: 견적서 회신\n> 첨부: 없음\n>\n");
		const d = parseDraftApproval(block)!;
		expect(d.noAttachments).toBe(true);
		expect(d.attachments).toBeUndefined();
		expect(d.body).toBe("안녕하세요.\n\n확인했어요.");
		expect(draftApprovalBlock({ ...base, attachments: two, attachmentsNone: true })).not.toContain("첨부: 없음");
	});

	test("a body line that merely starts with 첨부 stays in the body", () => {
		const d = parseDraftApproval(draftApprovalBlock({ ...base, body: "첨부: 아래 표를 봐 주세요" }))!;
		expect(d.body).toBe("첨부: 아래 표를 봐 주세요");
		expect(d.attachments).toBeUndefined();
	});

	test("sizes read like the web shows them", () => {
		expect([0, 900, 1024, 348_160, 1_048_576, 2_516_582, 3_221_225_472].map(fileSizeText)).toEqual(["0B", "900B", "1KB", "340KB", "1.0MB", "2.4MB", "3.0GB"]);
	});
});

describe("the draft says it attaches something", () => {
	test.each(["첨부합니다.", "견적서를 첨부드립니다", "자료 첨부했어요", "파일을 첨부해 드립니다", "Please find the quote attached.", "I've attached the file", "I have attached it"])("%s is a claim", t => {
		expect(claimsAttachment(t)).toBe(true);
	});
	test.each(["첨부파일은 없어요", "첨부하지 못했어요", "회의 자료는 내일 드릴게요", "I will attach nothing", "no attachment this time", "첨부 불가합니다", ""])("%s is not a claim", t => {
		expect(claimsAttachment(t)).toBe(false);
	});

	test("the parser warns on a mail draft that claims a file with none set, never when a file is set or for a non-mail target", () => {
		const claim = { ...base, body: "견적서 첨부합니다. 확인 부탁드립니다." };
		expect(parseDraftApproval(draftApprovalBlock(claim))!.warning).toBe(NO_ATTACHMENT_WARNING);
		expect(parseDraftApproval(draftApprovalBlock({ ...claim, attachmentsNone: true }))!.warning).toBe(NO_ATTACHMENT_WARNING);
		expect(parseDraftApproval(draftApprovalBlock({ ...claim, attachments: two }))!.warning).toBeUndefined();
		expect(parseDraftApproval(draftApprovalBlock(calm))!.warning).toBeUndefined();
		expect(parseDraftApproval(draftApprovalBlock({ ...claim, toLabel: "대화방" }))!.warning).toBeUndefined();
	});
});

describe("reply drafts say what the reply carries", () => {
	const rec = (extra: Partial<DraftRec>): DraftRec =>
		({ id: "RZZZ999", kind: "mail", app: "mail", source: "zele", mailId: "m1", ref: "k1", to: "kim@example.com", subject: "RE: 견적", body: "확인했어요.", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: "kim@example.com", text: "x" }, ...extra }) as DraftRec;

	test("a reply without files always says 첨부: 없음, whether or not the mail it answers had files", () => {
		expect(askText(rec({ origAttachments: 2 }), [])).toContain("> 첨부: 없음");
		expect(askText(rec({}), [])).toContain("> 첨부: 없음");
		expect(parseDraftApproval(askText(rec({ origAttachments: 1 }), []))!.noAttachments).toBe(true);
	});
});

describe("draft files route", () => {
	const root = mkdtempSync(join(tmpdir(), "dotz-draft-files-"));
	const src = mkdtempSync(join(tmpdir(), "dotz-draft-src-"));
	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(src, { recursive: true, force: true });
	});
	writeFileSync(join(src, "견적서.pdf"), "%PDF-1.4 fixture");
	writeFileSync(join(src, "photo.jpg"), "jpg-bytes");
	const staged = stageDraftFiles("RABC123", [join(src, "견적서.pdf"), join(src, "photo.jpg")], root);
	const get = (ref: string, n: string, q = "", method = "GET") => {
		const url = new URL(`http://x/api/drafts/${ref}/files/${n}${q}`);
		return draftFileRoute(new Request(url, { method }), url, ref, n, root);
	};

	test("staging returns the name and size the block takes, and the route serves exactly those bytes read-only", async () => {
		expect(staged).toEqual([{ name: "견적서.pdf", size: 16 }, { name: "photo.jpg", size: 9 }]);
		const block = draftApprovalBlock({ ...base, attachments: staged });
		expect(parseDraftApproval(block)!.attachments).toEqual([{ name: "견적서.pdf", size: "16B" }, { name: "photo.jpg", size: "9B" }]);
		const r = get("RABC123", "0");
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("%PDF-1.4 fixture");
		expect(r.headers.get("content-disposition")).toContain("filename*=UTF-8''%EA%B2%AC%EC%A0%81%EC%84%9C.pdf");
		expect(get("RABC123", "1", "?dl=1").headers.get("content-disposition")).toStartWith("attachment");
		expect(get("RABC123", "0", "", "HEAD").status).toBe(200);
	});

	test("an unknown draft, an index past the list and a traversing ref are refused", () => {
		expect(get("RNOPE99", "0").status).toBe(404);
		expect(get("RABC123", "5").status).toBe(404);
		expect(get("..", "0").status).toBe(404);
		expect(() => stageDraftFiles("../x", [join(src, "photo.jpg")], root)).toThrow();
	});

	test("a peer gateway may read the route", () => {
		expect(PEER_GET.some(r => r.test("/api/drafts/RABC123/files/0"))).toBe(true);
		expect(PEER_GET.some(r => r.test("/api/drafts/RABC123/files/0/../../x"))).toBe(false);
	});
});

test("a hand-written 첨부 line naming several files is one file per name; a name with a comma but no file ending stays whole", () => {
	const d = parseDraftApproval("> 받는이: a@b.c\n> 제목: 신청\n> 첨부: 2026년_9월_신청.xlsx, 2026년_9월_증빙.pdf (1.2MB)\n> 본문\n결정: 보낼까요? (k1)\n**1) 보내기**\n**2) 고치기 …**\n**3) 보내지 않기**")!;
	expect(d.attachments).toEqual([{ name: "2026년_9월_신청.xlsx" }, { name: "2026년_9월_증빙.pdf", size: "1.2MB" }]);
	const one = parseDraftApproval("> 받는이: a@b.c\n> 첨부: 회의록, 최종본\n> 본문\n결정: 보낼까요? (k2)\n**1) 보내기**\n**2) 고치기 …**\n**3) 보내지 않기**")!;
	expect(one.attachments).toEqual([{ name: "회의록, 최종본" }]);
});

