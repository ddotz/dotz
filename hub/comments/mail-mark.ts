import { mailByKey, MailError, mailKey, recordMail, type MailRecord } from "../mail.ts";
import { replyOf } from "../mail-state.ts";
import { MATCH_SOURCE } from "./mail-match.ts";

/** The key of the mail that mail matching found for a comment's writer (Draft.mailThread.id, a zele thread id), or undefined when the id makes no key. */
export function matchedMailKey(thread: string): string | undefined {
	try {
		return mailKey(MATCH_SOURCE, thread);
	} catch (error) {
		if (error instanceof MailError) return undefined;
		throw error;
	}
}

const incoming = (thread: string): MailRecord | undefined => {
	const key = matchedMailKey(thread);
	const r = key === undefined ? undefined : mailByKey(key);
	return r && r.dir !== "out" ? r : undefined;
};

/** 댓글로 이미 답했어요 (CM-13): a comment reply was posted at `at` (ISO) to the sender of the matched mail thread `thread`. Only the mark is written:
 *  the reply state, its chip and the mail's place in the list stay, and the first mark is kept (a later reply, a deleted reply change nothing).
 *  Returns the key and whether this call wrote the mark, or undefined when no incoming mail is recorded for that thread. */
export function markCommentReplied(thread: string, at: string): { key: string; fresh: boolean } | undefined {
	const r = incoming(thread);
	if (!r) return undefined;
	if (r.commentReplyAt) return { key: r.key, fresh: false };
	recordMail({ ...r, commentReplyAt: at });
	return { key: r.key, fresh: true };
}

/** 메일로 이미 답했어요 (CM-13), for one pass over comment drafts: whether the matched mail of thread `thread` was answered by mail, its record
 *  saying 답장함 or a reply draft of it sent (`sentRefs`, the mail keys of sent reply drafts, read once at the first matched mail asked about). */
export function mailAnsweredLookup(sentRefs: () => ReadonlySet<string>): (thread: string) => boolean {
	let sent: ReadonlySet<string> | undefined;
	return thread => {
		const r = incoming(thread);
		if (!r) return false;
		if (replyOf(r) === "replied") return true;
		sent ??= sentRefs();
		return sent.has(r.key);
	};
}
