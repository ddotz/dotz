import { expect, test } from "bun:test";
import { parseDecisions } from "./choices.ts";
import { decideOf, draftApprovalBlock, NO_ATTACHMENT_WARNING, parseDraftApproval, withAttachIssues, withStagedFiles } from "./draft-approval.ts";
import { type Notice, refreshDraftFiles } from "./notices.ts";

const mail = { to: "kim@example.com", subject: "악보 요청", body: "안녕하세요.\n\n악보 첨부해 드립니다.", ref: "RABC123", question: "이 답장 보낼까요?" };

// 정할 것 reads as a list (owner 2026-11-02): one point per line under the draft, the 결정 line stays the question and its id.
test("several points to decide are one '- ' line each above a short 결정 line; the card still answers to its draft id", () => {
	const text = draftApprovalBlock({ ...mail, decide: ["곡명이 맞는지 확인이 필요합니다.", "합창인지 (합주인지) 정해 주세요."] });
	expect(text).toContain("정할 것:\n- 곡명이 맞는지 확인이 필요합니다.\n- 합창인지 합주인지 정해 주세요.\n결정: 이 답장 보낼까요? (RABC123)");
	expect(text).not.toContain(".,");
	expect(parseDecisions(text).blocks[0]!.title).toBe("이 답장 보낼까요? (RABC123)");
	const d = parseDraftApproval(text)!;
	expect([d.ref, d.body, d.decide]).toEqual(["RABC123", mail.body, ["곡명이 맞는지 확인이 필요합니다.", "합창인지 합주인지 정해 주세요."]]);
	// A card posted before the list kept the points in its question, joined by ", ".
	expect(decideOf("결정: 이 답장 보낼까요? 정할 것: 곡명이 맞나요?, 파일을 확인해 주세요., 합주인가요 (RABC123)")).toEqual(["곡명이 맞나요?", "파일을 확인해 주세요.", "합주인가요"]);
});

test("a file staged after the card was posted replaces its 첨부 row and clears the warning; the other lines stay", () => {
	const posted = `[ask] 답장 초안을 만들었어요\n-# 확인: 길이\n${draftApprovalBlock({ ...mail, decide: ["곡명 확인"] })}`;
	expect(parseDraftApproval(posted)!.warning).toBe(NO_ATTACHMENT_WARNING);
	const now = withStagedFiles(posted, [{ name: "악보.pdf", size: 2048 }]);
	expect(now.split("\n").filter(l => l.startsWith("> 첨부:"))).toEqual(["> 첨부: 악보.pdf (2KB)"]);
	expect(now.replace("> 첨부: 악보.pdf (2KB)", "")).toBe(posted.replace(/> 첨부: 없음 \([^\n]*\)/, ""));
	const d = parseDraftApproval(now)!;
	expect([d.warning, d.attachments, d.decide, d.body]).toEqual([undefined, [{ name: "악보.pdf", size: "2KB" }], ["곡명 확인"], mail.body]);
	expect(withStagedFiles(now, [{ name: "악보.pdf", size: 2048 }])).toBe(now);
	// The file taken off again: 없음 with the reason, as a fresh card would say it.
	expect(parseDraftApproval(withStagedFiles(now, []))!.warning).toBe(NO_ATTACHMENT_WARNING);
});

test("an open card follows the finding on its files: the line and the 4th option come and go, in the text, the parsed draft and the options", () => {
	const why = "본문에 악보·문서 파일을 보낸다고 썼지만 첨부파일이 없어요";
	const text = `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ ...mail, sendResult: "kim@example.com에 보내요" })}`;
	const labels = (n: Notice) => (n as any).decision.options.map((o: { label: string }) => o.label);
	const open = { id: "a", text, decision: { options: parseDecisions(text).blocks[0]!.options, to: "mail:x", group: 1, state: "open", draft: parseDraftApproval(text)! } } as unknown as Notice;
	const answered = { ...open, id: "b", decision: { ...(open as any).decision, state: "answered" } } as Notice;
	const files = (id: string) => (id === "RABC123" ? [] : undefined);
	expect(refreshDraftFiles([open], files, () => undefined)).toEqual([]);
	expect(refreshDraftFiles([open], files, () => [why]).map(n => n.id)).toEqual(["a"]);
	const d = (open as any).decision.draft;
	expect(open.text).toContain(`-# ⚠️ 첨부 확인: ${why}\n> 받는이:`);
	expect(open.text).toContain("**1) 보내기**\nkim@example.com에 보내요. 첨부가 맞을 때까지는 보내지 않아요");
	expect(d.attachIssues).toEqual([why]);
	expect(labels(open)).toEqual(["보내기", "고치기", "보내지 않기", "이대로 보내기"]);
	expect((open as any).decision.options.map((o: { n: number }) => o.n)).toEqual([1, 2, 3, 4]);
	expect(refreshDraftFiles([open], files, () => [why])).toEqual([]);
	// The file arrives: the line and the option go, and the card is the one it was.
	expect(refreshDraftFiles([open], files, () => []).map(n => n.id)).toEqual(["a"]);
	expect(open.text).toBe(text);
	expect((open as any).decision.draft.attachIssues).toBeUndefined();
	expect(labels(open)).toEqual(["보내기", "고치기", "보내지 않기"]);
	// An answered card is left as it was.
	expect(refreshDraftFiles([answered], files, () => [why])).toEqual([]);
});

test("the finding set on a card already saying it leaves the card as draftApprovalBlock wrote it, source quote and reply + mail part included", () => {
	const why = "본문에 악보·문서 파일을 보낸다고 썼지만 첨부파일이 없어요";
	const text = draftApprovalBlock({ ...mail, origin: { text: "원문 한 줄" }, attachIssues: [why], mail: { to: "b@example.com", subject: "Re: 악보", body: "악보 보내드립니다", attachIssues: [] } });
	expect(withAttachIssues(text, [why])).toBe(text);
});

test("an open card already waiting is re-checked against its staged files; an answered card or an untracked draft is left as posted", () => {
	const text = draftApprovalBlock(mail);
	const card = (id: string, ref: string, state: string) => ({ id, text, decision: { options: [], to: "mail:x", group: 1, state, draft: { ...parseDraftApproval(text)!, ref, body: "안녕하세요. (원문 전체)" } } });
	const list = [card("a", "RABC123", "open"), card("b", "RABC123", "answered"), card("c", "ROTHER1", "open")] as unknown as Notice[];
	const filesOf = (id: string) => (id === "RABC123" ? [{ name: "악보.pdf", size: 2048 }] : undefined);
	expect(refreshDraftFiles(list, filesOf).map(n => n.id)).toEqual(["a"]);
	const a = (list[0] as any).decision.draft;
	expect([a.attachments, a.warning, a.noAttachments, a.body, a.ref]).toEqual([[{ name: "악보.pdf", size: "2KB" }], undefined, undefined, "안녕하세요. (원문 전체)", "RABC123"]);
	expect(list[0]!.text).toContain("> 첨부: 악보.pdf (2KB)");
	expect([list[1]!.text, list[2]!.text]).toEqual([text, text]);
	expect(refreshDraftFiles(list, filesOf)).toEqual([]);
});
