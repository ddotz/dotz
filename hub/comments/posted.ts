import type { Reply, Store } from "./store.ts";

type PostedDeps = { now: () => number; sent?: (app: string, reply: Reply) => void; answeredMailThread?: (mailThreadId: string, at: number) => void };

/** What a reply posted on the platform starts beyond its event: the app's 이어서 할 일 (`sent`, given the app instance `owner`) unless a mail
 *  rides on its card, and the 댓글로 이미 답했어요 mark of the mail thread that mail matching found for the comment's writer (CM-13). */
export function replyPosted(deps: PostedDeps, store: Store, r: Reply, owner: string | undefined): void {
	const d = store.drafts().find(x => x.code === r.draft);
	if (owner !== undefined && !d?.mail) deps.sent?.(owner, r);
	if (d?.mailThread) deps.answeredMailThread?.(d.mailThread.id, deps.now());
}
