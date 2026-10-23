// The [ask] message of one comment draft, in the shared send-approval shape (hub/draft-approval.ts). The headline names the source in the
// owner's words, which is how 모니터링 files the ask under its app (hub/integrations.ts match.text).
import { type DraftPart, draftApprovalBlock } from "../draft-approval.ts";
import { type Comment, isUntitled, type SourceConfig } from "./contract.ts";
import type { Draft } from "./store.ts";

const one = (s: string) => s.replace(/\s+/g, " ").trim();
const WORD: Record<SourceConfig["kind"], string> = { youtube: "유튜브", instagram: "인스타", website: "웹사이트" };

const POST: Record<SourceConfig["kind"], string> = { youtube: "영상", instagram: "게시물", website: "글" };

export function commentAsk(src: SourceConfig, c: Comment, d: Draft, headline = `${WORD[src.kind]} 댓글 답글 초안을 만들었어요`, mail?: DraftPart): string {
	const note = d.notes.map(one).join(" / ");
	// With a mail the one card asks about both: 보내기 posts the reply and then sends the mail.
	const block = draftApprovalBlock({ to: `${c.author} 댓글`, toLabel: "대상", body: d.text, ref: d.code, question: mail ? "이 답글을 올리고 메일도 보낼까요?" : "이 답글 올릴까요?", sendResult: mail ? `이 글을 답글로 올리고 ${one(mail.to)}에게 메일을 보내요` : "이 글을 답글로 올려요", ...(mail ? { mail } : {}) });
	const post = isUntitled(c) ? [] : [`> ${POST[src.kind]} ${one(c.postTitle)}`];
	return [`[ask] ${headline}`, ...(note ? [`-# ${note}`] : []), ...post, `> 원댓글 ${one(c.author)}: ${one(c.text)}`, block].join("\n");
}
