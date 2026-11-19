import { recipientCheck } from "../draft-approval.ts";
import { addressKey } from "../mail-state.ts";
import type { Comment } from "./contract.ts";
import type { MailLink } from "./engine.ts";
import { ADDRESS } from "./no-mail.ts";
import type { Store } from "./store.ts";

const EDITED_NOTE = "확인: 원댓글이 수정됐어요";

/** What follows a comment its author edited: each pending draft for it gets the 원댓글이 수정됐어요 note, and its linked mail is re-aimed at the address the new text names (the recipient check is made again against the new text). */
export function editFollower(store: Store, mail: MailLink | undefined, emit: (e: Record<string, unknown>) => void): (c: Comment, before: string) => void {
	return (c, before) => {
		const to = ADDRESS.exec(c.text)?.[0];
		for (const d of store.drafts().filter(x => x.commentId === c.id && x.status === "pending")) {
			const view = d.mail ? mail?.view(d.mail) : undefined;
			const stale = view ? recipientCheck(view.to, before) : undefined;
			if (view && to && addressKey(view.to) !== addressKey(to)) mail?.retarget?.(view.id, to);
			const now = d.mail ? mail?.view(d.mail) : undefined;
			const check = now ? recipientCheck(now.to, c.text) : undefined;
			store.putDraft({ ...d, clean: false, notes: [...d.notes.filter(n => n !== `확인: ${stale}` && n !== EDITED_NOTE), EDITED_NOTE, ...(check ? [`확인: ${check}`] : [])] });
			emit({ kind: "comment_draft", source: d.source, thread: d.thread });
		}
	};
}
