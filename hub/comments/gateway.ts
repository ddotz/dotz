// Real wiring of the comment routes inside the gateway (hub/routes.ts imports this). The watch itself is a dotz_watch script
// (features/comments/bin/watch.ts), so the gateway holds no timer and a quiet install costs nothing.
import { hostname } from "node:os";
import { MAY_HAVE_GONE_OUT } from "../approval-send.ts";
import { cfg, DATA_DIR, log } from "../config.ts";
import { broadcast } from "../events.ts";
import { resolveName } from "../machine-name.ts";
import { triggerFollowup } from "../followup.ts";
import { commentOriginal } from "./original.ts";
import { realEngine } from "./real.ts";
import { createCommentsWeb } from "./web.ts";

// An approved reply that was posted starts the app's 이어서 할 일 check (hub/followup.ts), once per send record.
const engine = realEngine(DATA_DIR, {
	broadcast,
	collector: resolveName(cfg.web?.machine_name, hostname()),
	sent: (app, r) => triggerFollowup({ app, kind: "comment", key: r.id, ids: { comment: r.commentId, source: r.source, thread: r.thread.replace(/\s+/g, "_"), draft: r.draft } }),
});
const web = createCommentsWeb({ engine, broadcast });
// Once at start (also the migration of an install that has stale open comments / pending drafts): re-read the open comments, close what is answered or deleted.
void engine.reconcile({ recheck: true }).then(
	r => log(`comments reconcile: ${JSON.stringify({ answered: r.answered, gone: r.gone, draftsClosed: r.draftsClosed, ...(r.merged ? { merged: r.merged } : {}) })}${r.errors ? ` errors=${JSON.stringify(r.errors)}` : ""}`),
	e => log(`comments reconcile failed: ${e instanceof Error ? e.message : String(e)}`),
);

export const commentsRoute = web.route;
// The comment a draft of the comment engine answers (hub/draft-attach.ts: GET /api/drafts/<code>/original).
export const commentOriginalOf = (code: string) => commentOriginal(engine.store, code);
// What waits per integration key ("youtube", "instagram", "site") and whether a website source exists; read by GET /api/integrations.
export const commentNeeds = () => engine.needs();
// The pending reply drafts of every source (the 답장 확인 queue, GET /api/replies).
export const commentPending = () => engine.pendingDrafts();
/**
 * What the 답장 확인 screen's 실패 / 보낸 것 / 멈춘 이유 read (hub/reply-outcomes.ts): the sources and their app, the pending drafts, the send records and the comments they
 * answer. Store reads only, nothing is written.
 */
export const commentOutcomeFacts = () => {
	const cfg = engine.store.config();
	if (!cfg.enabled) return { sources: {}, drafts: [], replies: [], comments: [] };
	return { sources: Object.fromEntries(Object.values(cfg.sources).map(s => [s.key, { src: s, app: engine.ownerOf(s) }])), drafts: engine.store.drafts().filter(d => d.status === "pending" && cfg.sources[d.source]), replies: engine.store.replies(), comments: engine.store.comments() };
};
/** Whether a send of comment draft `code` failed and is on record (its 다시 보내기 / 지우기 are the comment routes'). */
/**
 * On boot: a reply left `sending` by the run that stopped has no sender in this process. It ends failed, visible in the failed list, with a text that says it may have
 * gone out; the owner's 다시 보내기 is the only thing that sends it again (the gate allows a second try of a failed reply, never of a sending one).
 */
export function commentSettleSending(): number {
	const stuck = engine.store.replies().filter(r => r.state === "sending");
	for (const r of stuck) engine.store.putReply({ ...r, state: "failed", reason: MAY_HAVE_GONE_OUT });
	return stuck.length;
}
/** How the last send of comment draft `code` ended, when the store knows. */
export function commentSendOutcome(code: string): { state: "sent" } | { state: "failed"; text: string } | undefined {
	const reply = engine.store.replies().find(r => r.draft === code);
	if (reply?.state === "sent" || engine.store.drafts().find(d => d.code === code)?.status === "sent") return { state: "sent" };
	return reply?.state === "failed" ? { state: "failed", text: reply.reason ?? MAY_HAVE_GONE_OUT } : undefined;
}
export const commentSendFailed = (code: string): boolean => engine.store.replies().some(r => r.draft === code && r.state === "failed");
export const commentDraftFacts = {
	drafts: () => engine.store.drafts().map(d => ({ code: d.code, commentId: d.commentId, status: d.status, created: d.created })),
	waiting: (commentId: string): boolean | undefined => {
		const c = engine.store.comments().find(x => x.id === commentId);
		return c ? engine.unreplied(c) : undefined;
	},
};
// The send approval's gateway path (hub/approval-wire.ts): which source a pending draft goes to, and the owner's own edit of its text.
export const commentDraftOf = (code: string) => engine.store.drafts().find(d => d.code === code && d.status === "pending");
/** Every pending comment draft by code, read once: a request over many cards asks this map instead of the store for each card. */
export const commentDraftsByCode = () => new Map(engine.store.drafts().filter(d => d.status === "pending").map(d => [d.code, d]));
/** The app a comment source belongs to in the app list ("youtube", "instagram"; a website source is "site"). */
export const commentSourceApp = (source: string): string | undefined => {
	const k = engine.store.config().sources[source]?.kind;
	return k === "website" ? "site" : k;
};
/** The comment a pending draft answers, for the send-approval cards and the review queue (GET /api/approvals): the post, the quoted comment (clipped), its time and the mail mark. */
export const commentContextOf = (code: string, pending: ReturnType<typeof engine.pendingDrafts> = engine.pendingDrafts()) => {
	const d = pending.find(x => x.code === code);
	return d ? { source: d.sourceLabel, post: d.title, link: d.link, who: d.to, ...(d.original ? { text: d.original.text, at: d.original.at } : {}), ...(d.mailMark ? { mailMark: d.mailMark } : {}) } : undefined;
};
/** 보내지 않기 on a comment draft (the same step as the comment card's). */
export const dropCommentDraft = (code: string) => engine.drop(code);
export const setCommentDraftText = (code: string, text: string): void => engine.store.patchDraft(code, { text, clean: false });
export const commentFlags = (): string[] => (Object.values(engine.store.config().sources).some(s => s.kind === "website") && engine.store.config().enabled ? ["comments-site"] : []);
