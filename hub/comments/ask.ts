// The [ask] message of one comment draft, in the shared send-approval shape (hub/draft-approval.ts). The headline names the source in the
// owner's words, which is how 모니터링 files the ask under its app (hub/integrations.ts match.text).
import { type DraftPart, draftApprovalBlock } from "../draft-approval.ts";
import { type Comment, isUntitled, type SourceConfig } from "./contract.ts";
import type { Draft } from "./store.ts";

const one = (s: string) => s.replace(/\s+/g, " ").trim();
const QUOTE_MAX = 200;
/** "10/22 10:00" in KST, the time of the comment the draft answers. */
export const kstStamp = (ms: number): string => new Date(ms + 9 * 3600e3).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");
const quote = (s: string) => (one(s).length > QUOTE_MAX ? `${[...one(s)].slice(0, QUOTE_MAX).join("")}…` : one(s));
// The engine keeps open points as notes "정해 주세요: <q>"; they go into the card's 정할 것 list once (draftApprovalBlock decide).
const OPEN = "정해 주세요: ";
const WORD: Record<SourceConfig["kind"], string> = { youtube: "유튜브", instagram: "인스타", website: "웹사이트" };

const POST: Record<SourceConfig["kind"], string> = { youtube: "영상", instagram: "게시물", website: "글" };

export function commentAsk(src: SourceConfig, c: Comment, d: Draft, headline = `${WORD[src.kind]} 댓글 답글 초안을 만들었어요`, mail?: DraftPart): string {
	const open = d.notes.filter(n => n.startsWith(OPEN)).map(n => n.slice(OPEN.length));
	// A card that carries a mail says so in its note line (the same mark the comment item shows).
	const note = [...(mail ? ["메일 초안 작성됨"] : []), ...d.notes.filter(n => !n.startsWith(OPEN)).map(one)].join(" / ");
	// With a mail the one card asks about both: 보내기 posts the reply and then sends the mail; the send modes (답글만 / 메일만 / 직접 입력) send one part
	// (features/comments/bin/comments.ts send --only).
	const block = draftApprovalBlock({ to: `${c.author} 댓글`, toLabel: "대상", body: d.text, ref: d.code, question: mail ? "이 답글을 올리고 메일도 보낼까요?" : "이 답글 올릴까요?", decide: open, sendResult: mail ? `이 글을 답글로 올리고 ${one(mail.to)}에게 메일을 보내요` : "이 글을 답글로 올려요", ...(mail ? { mail, sendModes: true } : {}) });
	const post = isUntitled(c) ? [] : [`> ${POST[src.kind]} ${one(c.postTitle)}`];
	return [`[ask] ${headline}`, ...(note ? [`-# ${note}`] : []), ...post, `> 원댓글 ${one(c.author)} (${kstStamp(c.at)} KST): ${quote(c.text)}`, block].join("\n");
}
