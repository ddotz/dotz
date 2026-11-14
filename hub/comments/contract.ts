// Comment-source contract (design of record: docs/comments-api.md). One shape for the comments of every platform (YouTube, Instagram, a
// website): list the new ones since a cursor, post a reply. A platform is an adapter; nothing else in the engine knows a platform.
// Identity: commentId() is built from the platform's own comment id, so it is the same on every machine that collects it (`collector`
// only says who saw it first). One door out: dispatchReply() is the only function a reply is posted through (owner's 보내기 or an
// owner-enabled rule), a reply is posted at most once per comment, and the record goes sending -> sent | failed | unsure (+reason, code); one cut off by a restart goes to unsure (recover.ts).
// `failed` means surely not posted, `unsure` means it may have gone up: only the owner sends an unsure reply again.
import { type Draft, type Reply, type Store } from "./store.ts";

export type SourceKind = "youtube" | "instagram" | "website";
export type AutoSend = { on: boolean; match: string[]; max_per_day: number };
export type SiteConfig = {
	read: { kind: "rss" | "json" | "script"; url?: string; command?: string[] };
	post: { kind: "webhook" | "script"; url?: string; command?: string[]; secret?: string };
	owner?: string; // the owner's display name on the site: comments by it are his own
	// The site's private messages (DM inbox), optional: read like comments (thread `dm:<room>`), answered through the same draft and send gate.
	dm?: { read: { kind: "json" | "script"; url?: string; command?: string[] }; post: { kind: "webhook" | "script"; url?: string; command?: string[]; secret?: string } };
};
// One chosen source = one account/channel/site. `watch` lists the post ids to follow ("*" = all); empty = nothing is read (costs nothing).
export type SourceConfig = { key: string; kind: SourceKind; label: string; watch: string[]; autoDraft: boolean; everyMin?: number; autoSince?: number; autoSend?: AutoSend; site?: SiteConfig; mailMatch?: boolean; pastSeed?: boolean;
	/** A reply draft for a comment that asks for a file and names an e-mail address also gets a linked mail draft (engine.ts linkMail), written by `mailApp` (a mail app instance id, e.g. `mail` or `mail-teaching`). Off by default; without `mailApp` the card says no mail was made. */
	autoMail?: boolean; mailApp?: string };
export type CommentsConfig = { enabled: boolean; sources: Record<string, SourceConfig> };

export type RawComment = { native: string; thread: string; parent?: string; author: string; text: string; postTitle: string; postLink?: string; thumb?: string; at: number; mine?: boolean };
// `gone`: when a re-check (adapter.recheck) found the comment deleted on the platform; never cleared once set.
export type Comment = Omit<RawComment, "native" | "mine"> & { id: string; source: string; native: string; mine: boolean; collector: string; gone?: number };
export type Post = { id: string; title: string; link?: string; thumb?: string };
// What an adapter shows for a post whose title it could not read yet. A stored comment with one of these gets its real title on a later poll (adapter.retitle).
export const FALLBACK_TITLE = { youtube: "유튜브 영상", instagram: "인스타 게시물" } as const;
export const isUntitled = (c: { postTitle: string }): boolean => !c.postTitle || c.postTitle === FALLBACK_TITLE.youtube || c.postTitle === FALLBACK_TITLE.instagram;
export type PostInfo = { title: string; link?: string; thumb?: string };

// A failed post: `code` is a reason code of hub/reply-reasons.ts, `sent` says whether it may still have gone up. An adapter that does not say
// `sent: "no"` is treated as "maybe" (a double post is worse than a question). `reason` is plain Korean; `detail` is raw tool text, for the log only.
export type ReplyOutcome = { ok: true; ref?: string } | { ok: false; reason: string; code?: string; sent?: "no" | "maybe"; detail?: string };
export type CommentAdapter = {
	kind: SourceKind;
	// Comments newer than `cursor` (the adapter's own opaque string) and the next cursor. Throws on an API failure.
	// `error`: a part that could not be read (e.g. the DM inbox) while the rest was; kept as the source's error, the comments still count.
	list(src: SourceConfig, cursor: string | undefined): Promise<{ comments: RawComment[]; cursor?: string; error?: string }>;
	reply(src: SourceConfig, c: Comment, text: string, sendId: string): Promise<ReplyOutcome>;
	// The posts the owner can choose to follow, and his own past replies (tone examples).
	posts?(src: SourceConfig): Promise<Post[]>;
	// The title, link and thumbnail of these posts (ids = Comment.thread), for stored comments that were collected without a title. Posts it cannot name are left out.
	retitle?(src: SourceConfig, threads: string[]): Promise<Record<string, PostInfo>>;
	ownReplies?(src: SourceConfig, limit: number): Promise<string[]>;
	// The owner's past replies with the comments they answer, newest first, for the engine's pair file (engine.ts refreshPast). Rows only, same shape as `list` (a reply is `mine` with its `parent`):
	// nothing is stored, posted or marked read. Stops at `target` owner replies, at the end of what the platform has, at its own caps or at `deadline` (epoch ms), and
	// keeps the rows read so far when a later read fails; throws only when nothing was read.
	history?(src: SourceConfig, opts: { target: number; deadline: number }): Promise<RawComment[]>;
	// Re-reads still-open comments (the engine hands over top-level comments that wait for a reply or hold a pending draft, plus stored rows an adapter
	// may need to resolve) and answers with the owner's replies under them (mine: true, parent = the open comment's native) and the natives that no longer
	// exist on the platform. A native is "gone" only when the platform was read completely. Throws on an API failure; nothing is posted.
	recheck?(src: SourceConfig, open: Comment[]): Promise<{ comments: RawComment[]; gone: string[] }>;
	// An answer of the owner that is no comment of his in the same stream (Instagram: he @mentioned the author under the post). `mine` = his stored comments of that thread.
	answered?(c: Comment, mine: Comment[]): boolean;
};

// Sites rewrite line breaks (one forum stores \n as \r\n), so a read-back compares only the words: a false "not sent" invites a duplicate.
export const sameWords = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
export const commentId = (source: string, native: string): string => `cm:${source}:${native}`;
export const threadKey = (source: string, thread: string): string => `${source}/${thread}`;
export const DM_THREAD = "dm:";
export const watches = (src: SourceConfig, thread: string): boolean => src.watch.includes("*") || src.watch.includes(thread) || (thread.startsWith(DM_THREAD) && !!src.site?.dm && src.watch.length > 0);

// Union by id, idempotent: the same id twice is one comment (the first collector is kept). Oldest first.
export function mergeComments(...lists: Comment[][]): Comment[] {
	const seen = new Map<string, Comment>();
	for (const list of lists) for (const c of list) if (!seen.has(c.id)) seen.set(c.id, c);
	return [...seen.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

export function toComment(src: SourceConfig, r: RawComment, collector: string): Comment {
	const { native, mine, ...rest } = r;
	return { ...rest, id: commentId(src.key, native), source: src.key, native, mine: mine === true, collector };
}

export type Approval = { by: "owner" } | { by: "rule" };
/** `resend`: the owner's 다시 보내기 of a reply nobody can say went up, the only send that passes an unsure record. */
export type ReplyRequest = { code: string; approval: Approval; text?: string; resend?: true };
export type GateDeps = { store: Store; adapters: Partial<Record<SourceKind, CommentAdapter>>; now: () => number; collector: string; inflight: Set<string>; onState?: (r: Reply) => void; log?: (line: string) => void };
/** A refusal carries the reason code of hub/reply-reasons.ts when the gate gave it. */
export type GateResult = { ok: true; reply: Reply; done: Promise<Reply> } | { ok: false; reason: string; code?: string };
const UNKNOWN_REASON = "보내다가 문제가 생겼어요";

const DAY = 24 * 3600 * 1000;
export const ruleAllows = (src: SourceConfig, text: string): boolean => {
	const r = src.autoSend;
	if (!r?.on || !r.match.length) return false;
	return r.match.some(p => {
		try {
			return new RegExp(p, "i").test(text);
		} catch {
			return false;
		}
	});
};

// Why an enabled auto-send rule does not send this draft (the reasons dispatchReply gives for by: "rule"), or undefined when the rule would send it.
// One source of truth: the gate refuses with it.
export function ruleRefusal(src: SourceConfig, commentText: string, draft: Pick<Draft, "clean">, replies: Reply[], at: number): string | undefined {
	if (!ruleAllows(src, commentText)) return "자동 보내기 규칙에 맞지 않아요";
	if (!draft.clean) return "확인할 점이 있는 초안은 자동으로 보내지 않아요";
	const today = replies.filter(r => r.source === src.key && r.via === "rule" && r.state !== "failed" && r.at > at - DAY).length;
	if (today >= (src.autoSend?.max_per_day ?? 0)) return "오늘 자동으로 보낼 수 있는 횟수를 다 썼어요";
	return undefined;
}

// The one send gate. Refuses without the owner's explicit pick (approval "owner", set only by the owner's 보내기 route or an
// approved ask) or an enabled per-source rule that matches; refuses a second send of the same comment unless the first one failed.
export function dispatchReply(req: ReplyRequest, deps: GateDeps): GateResult {
	const { store, now } = deps;
	const refuse = (reason: string, code: string): GateResult => ({ ok: false, reason, code });
	const draft: Draft | undefined = store.drafts().find(d => d.code === req.code);
	if (!draft) return refuse("그 초안을 찾지 못했어요", "gone");
	if (draft.status !== "pending") return refuse("이 초안은 더 이상 보낼 수 없어요", "gone");
	const cfg = store.config();
	const src = cfg.sources[draft.source];
	if (!cfg.enabled || !src) return refuse("이 댓글 연동은 꺼져 있어요", "app_off");
	const comment = store.comments().find(c => c.id === draft.commentId);
	if (!comment) return refuse("원댓글을 찾지 못했어요", "original_gone");
	const text = (req.text ?? draft.text).trim();
	if (!text) return refuse("보낼 글이 비어 있어요", "empty");
	if (req.approval.by === "rule") {
		const why = ruleRefusal(src, comment.text, draft, store.replies(), now());
		if (why) return refuse(why, "not_approved");
	} else if (req.approval.by !== "owner") return refuse("보내기 승인이 없어요", "not_approved");
	const sendId = `send:${comment.id}`;
	const prior = store.replies().find(r => r.id === sendId);
	if (prior?.state === "unsure" && !(req.resend && req.approval.by === "owner")) return refuse("이 답글은 올라갔는지 확인이 필요해요. 다시 보내기나 완료를 골라 주세요", "needs_resolve");
	if (deps.inflight.has(sendId) || prior?.state === "sending" || prior?.state === "sent") return prior?.state === "sent" ? refuse("이미 답글을 보냈어요", "already_sent") : refuse("이미 보내는 중이에요", "already_sending");
	const adapter = deps.adapters[src.kind];
	if (!adapter) return refuse("이 댓글 종류를 보낼 수 없어요", "config");
	const record: Reply = { id: sendId, commentId: comment.id, source: src.key, thread: comment.thread, text, state: "sending", at: now(), draft: draft.code, via: req.approval.by, collector: deps.collector, ...(prior?.state === "failed" || prior?.state === "unsure" ? { attempts: (prior.attempts ?? 1) + 1 } : {}) };
	deps.inflight.add(sendId);
	store.putReply(record);
	deps.onState?.(record);
	const done = (async (): Promise<Reply> => {
		let outcome: ReplyOutcome;
		try {
			outcome = await adapter.reply(src, comment, text, sendId);
		} catch (e) {
			// A throw says nothing about whether the POST reached the platform.
			outcome = { ok: false, reason: UNKNOWN_REASON, code: "unknown", sent: "maybe", detail: e instanceof Error ? e.message : String(e) };
		}
		deps.inflight.delete(sendId);
		if (!outcome.ok && outcome.detail) deps.log?.(`comments: ${sendId} post failed (${outcome.code ?? "unknown"}): ${outcome.detail.slice(0, 500)}`);
		const final: Reply = outcome.ok ? { ...record, state: "sent", ...(outcome.ref ? { ref: outcome.ref } : {}) } : { ...record, state: outcome.sent === "no" ? "failed" : "unsure", reason: outcome.reason, code: outcome.code ?? "unknown" };
		store.putReply(final);
		if (outcome.ok) store.setDraftStatus(draft.code, "sent");
		deps.onState?.(final);
		return final;
	})();
	return { ok: true, reply: record, done };
}
