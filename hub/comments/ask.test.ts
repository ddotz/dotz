import { expect, test } from "bun:test";
import type { Comment, SourceConfig } from "./contract.ts";
import { commentAsk, kstStamp } from "./ask.ts";
import type { Draft } from "./store.ts";

// The send-approval card of a comment draft quotes the comment it answers: post title, author, time (KST) and the text clipped to 200 characters.
const src = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: true } as SourceConfig;
const comment = (text: string) => ({ id: "cm:youtube:c1", source: "youtube", native: "c1", thread: "v1", author: "김민영-x9b", text, postTitle: "첫 번째 영상", at: Date.UTC(2026, 9, 22, 3, 0), mine: false, collector: "t" }) as Comment;
const draft = { code: "Dabc234", text: "고마워요", notes: [] } as unknown as Draft;

test("the card names the post and quotes the comment with author and KST time", () => {
	expect(kstStamp(Date.UTC(2026, 9, 22, 3, 0))).toBe("10/22 12:00");
	const lines = commentAsk(src, comment("악보를 보내 주실 수 있을까요?"), draft).split("\n");
	expect(lines).toContain("> 영상 첫 번째 영상");
	expect(lines).toContain("> 원댓글 김민영-x9b (10/22 12:00 KST): 악보를 보내 주실 수 있을까요?");
});

test("a long comment is clipped to 200 characters", () => {
	const quote = commentAsk(src, comment("가".repeat(500)), draft).split("\n").find(l => l.startsWith("> 원댓글"))!;
	expect(quote.endsWith(`${"가".repeat(200)}…`)).toBe(true);
});
