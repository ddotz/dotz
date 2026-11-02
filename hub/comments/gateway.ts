// Real wiring of the comment routes inside the gateway (hub/routes.ts imports this). The watch itself is a dotz_watch script
// (features/comments/bin/watch.ts), so the gateway holds no timer and a quiet install costs nothing.
import { hostname } from "node:os";
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
export const commentDraftFacts = {
	drafts: () => engine.store.drafts().map(d => ({ code: d.code, commentId: d.commentId, status: d.status, created: d.created })),
	waiting: (commentId: string): boolean | undefined => {
		const c = engine.store.comments().find(x => x.id === commentId);
		return c ? engine.unreplied(c) : undefined;
	},
};
// The send approval's gateway path (hub/approval-wire.ts): which source a pending draft goes to, and the owner's own edit of its text.
export const commentDraftOf = (code: string) => engine.store.drafts().find(d => d.code === code && d.status === "pending");
/** The app a comment source belongs to in the app list ("youtube", "instagram"; a website source is "site"). */
export const commentSourceApp = (source: string): string | undefined => {
	const k = engine.store.config().sources[source]?.kind;
	return k === "website" ? "site" : k;
};
/** The comment a pending draft answers, for the send-approval cards and the review queue (GET /api/approvals): the post, the quoted comment (clipped), its time and the mail mark. */
export const commentContextOf = (code: string) => {
	const d = engine.pendingDrafts().find(x => x.code === code);
	return d ? { source: d.sourceLabel, post: d.title, link: d.link, who: d.to, ...(d.original ? { text: d.original.text, at: d.original.at } : {}), ...(d.mailMark ? { mailMark: d.mailMark } : {}) } : undefined;
};
/** 보내지 않기 on a comment draft (the same step as the comment card's). */
export const dropCommentDraft = (code: string) => engine.drop(code);
export const setCommentDraftText = (code: string, text: string): void => engine.store.patchDraft(code, { text, clean: false });
export const commentFlags = (): string[] => (Object.values(engine.store.config().sources).some(s => s.kind === "website") && engine.store.config().enabled ? ["comments-site"] : []);
