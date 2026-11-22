// Real wiring of the comment routes inside the gateway (hub/routes.ts imports this). The watch itself is a dotz_watch script
// (features/comments/bin/watch.ts), so the gateway holds no timer and a quiet install costs nothing.
import { hostname } from "node:os";
import { MAY_HAVE_GONE_OUT, type SendLook } from "../approval-send.ts";
import { cfg, DATA_DIR, log } from "../config.ts";
import { sentReplyRefs } from "../mail.ts";
import { listDrafts, unlessUnreadable } from "../reply-mail.ts";
import { broadcast } from "../events.ts";
import { resolveName } from "../machine-name.ts";
import { triggerFollowup } from "../followup.ts";
import { commentOriginal } from "./original.ts";
import { mailAnsweredLookup, markCommentReplied, matchedMailKey } from "./mail-mark.ts";
import { realEngine } from "./real.ts";
import { POST_UNKNOWN } from "./recover.ts";
import { COMMENT_CODE } from "./engine.ts";
import { commentAdapter } from "./reply-adapter.ts";
import { createCommentsWeb } from "./web.ts";

let owedHook: (mailId: string) => void = () => {};
export const onCommentMailOwed = (hook: (mailId: string) => void): void => void (owedHook = hook);
const mailOwed = (mailId: string): void => owedHook(mailId);
let answeredHook: (mailKey: string) => void = () => {};
/** Called with the key of a mail that was just marked 댓글로 이미 답했어요 (CM-13), so the surfaces that show it are drawn again. */
export const onCommentAnsweredMail = (hook: (mailKey: string) => void): void => void (answeredHook = hook);
const markMail = (thread: string, at: number): boolean => {
	const m = markCommentReplied(thread, new Date(at).toISOString());
	if (m?.fresh) answeredHook(m.key);
	return m !== undefined;
};
const answeredMailThread = (thread: string, at: number): void => {
	if (!markMail(thread, at)) log(`comments: matched mail thread ${thread} is not a recorded mail; no 댓글로 이미 답했어요 mark`);
};
// An approved reply that was posted starts the app's 이어서 할 일 check (hub/followup.ts), once per send record.
const engine = realEngine(DATA_DIR, {
	broadcast,
	collector: resolveName(cfg.web?.machine_name, hostname()),
	sent: (app, r) => triggerFollowup({ app, kind: "comment", key: r.id, ids: { comment: r.commentId, source: r.source, thread: r.thread.replace(/\s+/g, "_"), draft: r.draft } }),
	mailOwed,
	answeredMailThread,
});
const web = createCommentsWeb({ engine, broadcast, mailOwed, posted: codes => commentMarkMails(codes) });
// Once at start (also the migration of an install that has stale open comments / pending drafts): re-read the open comments, close what is answered or deleted.
void engine.reconcile({ recheck: true }).then(
	r => log(`comments reconcile: ${JSON.stringify({ answered: r.answered, gone: r.gone, draftsClosed: r.draftsClosed, ...(r.merged ? { merged: r.merged } : {}) })}${r.errors ? ` errors=${JSON.stringify(r.errors)}` : ""}`),
	e => log(`comments reconcile failed: ${e instanceof Error ? e.message : String(e)}`),
);

export const commentsRoute = web.route;
// The comment adapter of the one reply flow (hub/reply-wire.ts), over this engine.
export const commentReply = commentAdapter(engine, () => mailAnsweredLookup(() => unlessUnreadable(() => sentReplyRefs(listDrafts()), new Set<string>(), line => log(`comments: sent mail replies not read for 메일로 이미 답했어요: ${line}`))));
/** The comment drafts `codes` whose reply was posted by another process (the send CLI, the watch's rule): the mail matched to each one's writer is
 *  marked 댓글로 이미 답했어요 with the time of its send record (CM-13). The gateway owns the mail list, so the mark is written here only. */
export function commentMarkMails(codes: readonly string[]): void {
	for (const code of codes) {
		const thread = engine.store.drafts().find(d => d.code === code)?.mailThread;
		const posted = thread && engine.store.replies().filter(r => r.draft === code && r.state === "sent").at(-1);
		if (thread && posted) markMail(thread.id, posted.at);
	}
}
/** The pending comment drafts whose writer's matched mail is `key`: their cards follow that mail's reply state (메일로 이미 답했어요). */
export const commentDraftsOnMail = (key: string): string[] => engine.store.drafts().flatMap(d => (d.status === "pending" && d.mailThread && matchedMailKey(d.mailThread.id) === key ? [d.code] : []));
// The comment a draft of the comment engine answers (hub/draft-attach.ts: GET /api/drafts/<code>/original).
export const commentOriginalOf = (code: string) => commentOriginal(engine.store, code);
// What waits per integration key ("youtube", "instagram", "site") and whether a website source exists; read by GET /api/integrations.
export const commentNeeds = () => engine.needs();
/** On boot: a reply left `sending` by the run that stopped ends unsure (recover.ts): only proof read back from the platform or the owner's own pick ends it. */
export const commentSettleSending = (): number => engine.leaveUnsure();
/** Every sweep: a reply left `sending` by a sender that is gone (older than the send CLI's limit, no live claim) ends unsure too. */
export const commentSettleStale = (live: (draft: string) => boolean): number => engine.leaveUnsure({ live: r => live(r.draft) });
export const commentProveSends = () => engine.proveSends();
/** How the last send of comment draft `code` ended, when the store knows. */
export function commentSendOutcome(code: string): Exclude<SendLook, { state: "alive" }> | undefined {
	const reply = engine.store.replies().find(r => r.draft === code);
	if (reply?.state === "sent" || engine.store.drafts().find(d => d.code === code)?.status === "sent") return { state: "sent" };
	if (reply?.state === "unsure") return { state: "unsure", text: reply.reason ?? POST_UNKNOWN };
	return reply?.state === "failed" ? { state: "failed", text: reply.reason ?? MAY_HAVE_GONE_OUT } : undefined;
}
export const commentDraftFacts = {
	drafts: () => engine.store.drafts().map(d => ({ code: d.code, commentId: d.commentId, status: d.status, created: d.created })),
	idShape: COMMENT_CODE,
	intact: () => engine.store.draftsIntact(),
	waiting: (commentId: string): boolean | undefined => {
		const c = engine.store.comments().find(x => x.id === commentId);
		return c ? engine.unreplied(c) : undefined;
	},
};
// A pending comment draft (hub/draft-attach.ts: whether the sheet's 원문 보기 has something to show).
export const commentDraftOf = (code: string) => engine.store.drafts().find(d => d.code === code && d.status === "pending");
/** The comment draft `code` whose reply is already posted (a combined card whose mail may still be owed). */
export const commentPostedOf = (code: string) => engine.store.drafts().find(d => d.code === code && d.status === "sent");
export const commentKeptMails = (): { code: string; mail: string }[] => engine.store.drafts().flatMap(d => (d.status === "answered" && d.closedReason === "answered-on-platform" && d.mailKept && !d.mailCarded ? [{ code: d.code, mail: d.mailKept }] : []));
export const commentMailCarded = (code: string): void => {
	const d = engine.store.drafts().find(x => x.code === code);
	if (d) engine.store.putDraft({ ...d, mailCarded: true });
};
export const commentFlags = (): string[] => (Object.values(engine.store.config().sources).some(s => s.kind === "website") && engine.store.config().enabled ? ["comments-site"] : []);
