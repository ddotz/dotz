import type { Comment, SourceConfig } from "./contract.ts";
import type { Reply } from "./store.ts";

/** What the owner is told besides the draft cards: comments waiting for an answer (`news`, the app's own push switch) or a reply that did not go out (`alert`). */
export type CommentNotice = { kind: "news" | "alert"; source: string; thread: string; text: string };

const WAITING_QUOTE = 80;
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** One notice for the new comments of a source that wait for an answer and have no draft card coming; undefined when there are none. */
export function waitingNotice(src: SourceConfig, waiting: Comment[]): CommentNotice | undefined {
	const first = waiting[0];
	if (!first) return undefined;
	const quote = `${first.author}님: ${clip(first.text, WAITING_QUOTE)}`;
	return { kind: "news", source: src.key, thread: first.thread, text: waiting.length === 1 ? `${src.label}: 새 댓글이 답을 기다려요. ${quote}` : `${src.label}: 새 댓글 ${waiting.length}개가 답을 기다려요. ${quote} 외` };
}

/** The reply an auto-send rule posted that did not end `sent`: its draft keeps its card, and this is the line that says why. */
export function sendFailedNotice(src: SourceConfig, c: Comment, rep: Reply): CommentNotice {
	const why = rep.reason ? ` (${clip(rep.reason, 120)})` : "";
	const text = rep.state === "unsure" ? `${src.label}: ${c.author}님 댓글에 답글이 올라갔는지 확인되지 않았어요${why}. 확인한 뒤 카드에서 골라 주세요` : `${src.label}: ${c.author}님 댓글에 답글을 올리지 못했어요${why}. 카드에서 다시 보내거나 고쳐 주세요`;
	return { kind: "alert", source: src.key, thread: c.thread, text };
}

/** The watch's output block of a notice: an alert is a `[fail]` line, news a plain one. */
export const noticeBlock = (n: CommentNotice): string => (n.kind === "alert" ? `[fail] ${n.text}` : n.text);
