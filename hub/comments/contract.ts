// Comment-source contract (design of record: docs/comments-api.md). One shape for the comments of every platform (YouTube, Instagram, a
// website): list the new ones since a cursor, post a reply. A platform is an adapter; nothing else in the engine knows a platform.
// Identity: commentId() is built from the platform's own comment id, so it is the same on every machine that collects it (`collector`
// only says who saw it first). One door out: dispatchReply() is the only function a reply is posted through (owner's 보내기 or an
// owner-enabled rule), a reply is posted at most once per comment, and the record goes sending -> sent | failed(+reason).
import { type Draft, type Reply, type Store } from "./store.ts";

export type SourceKind = "youtube" | "instagram" | "website";
export type AutoSend = { on: boolean; match: string[]; max_per_day: number };
export type SiteConfig = {
	read: { kind: "rss" | "json" | "script"; url?: string; command?: string[] };
	post: { kind: "webhook" | "script"; url?: string; command?: string[]; secret?: string };
	owner?: string; // the owner's display name on the site: comments by it are his own
};
// One chosen source = one account/channel/site. `watch` lists the post ids to follow ("*" = all); empty = nothing is read (costs nothing).
export type SourceConfig = { key: string; kind: SourceKind; label: string; watch: string[]; autoDraft: boolean; everyMin?: number; autoSince?: number; autoSend?: AutoSend; site?: SiteConfig };
export type CommentsConfig = { enabled: boolean; sources: Record<string, SourceConfig> };

export type RawComment = { native: string; thread: string; parent?: string; author: string; text: string; postTitle: string; postLink?: string; at: number; mine?: boolean };
export type Comment = Omit<RawComment, "native" | "mine"> & { id: string; source: string; native: string; mine: boolean; collector: string };
export type Post = { id: string; title: string; link?: string };

export type ReplyOutcome = { ok: true; ref?: string } | { ok: false; reason: string };
export type CommentAdapter = {
	kind: SourceKind;
	// Comments newer than `cursor` (the adapter's own opaque string) and the next cursor. Throws on an API failure.
	list(src: SourceConfig, cursor: string | undefined): Promise<{ comments: RawComment[]; cursor?: string }>;
	reply(src: SourceConfig, c: Comment, text: string, sendId: string): Promise<ReplyOutcome>;
	// The posts the owner can choose to follow, and his own past replies (tone examples).
	posts?(src: SourceConfig): Promise<Post[]>;
	ownReplies?(src: SourceConfig, limit: number): Promise<string[]>;
};

export const commentId = (source: string, native: string): string => `cm:${source}:${native}`;
export const threadKey = (source: string, thread: string): string => `${source}/${thread}`;
export const watches = (src: SourceConfig, thread: string): boolean => src.watch.includes("*") || src.watch.includes(thread);

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
export type ReplyRequest = { code: string; approval: Approval; text?: string };
export type GateDeps = { store: Store; adapters: Partial<Record<SourceKind, CommentAdapter>>; now: () => number; collector: string; inflight: Set<string>; onState?: (r: Reply) => void };
export type GateResult = { ok: true; reply: Reply; done: Promise<Reply> } | { ok: false; reason: string };

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

// The one send gate. Refuses without the owner's explicit pick (approval "owner", set only by the owner's 보내기 route or an
// approved ask) or an enabled per-source rule that matches; refuses a second send of the same comment unless the first one failed.
export function dispatchReply(req: ReplyRequest, deps: GateDeps): GateResult {
	const { store, now } = deps;
	const refuse = (reason: string): GateResult => ({ ok: false, reason });
	const draft: Draft | undefined = store.drafts().find(d => d.code === req.code);
	if (!draft) return refuse("그 초안을 찾지 못했어요");
	if (draft.status !== "pending") return refuse("이 초안은 더 이상 보낼 수 없어요");
	const cfg = store.config();
	const src = cfg.sources[draft.source];
	if (!cfg.enabled || !src) return refuse("이 댓글 연동은 꺼져 있어요");
	const comment = store.comments().find(c => c.id === draft.commentId);
	if (!comment) return refuse("원댓글을 찾지 못했어요");
	const text = (req.text ?? draft.text).trim();
	if (!text) return refuse("보낼 글이 비어 있어요");
	if (req.approval.by === "rule") {
		if (!ruleAllows(src, comment.text)) return refuse("자동 보내기 규칙에 맞지 않아요");
		if (!draft.clean) return refuse("확인할 점이 있는 초안은 자동으로 보내지 않아요");
		const today = store.replies().filter(r => r.source === src.key && r.via === "rule" && r.state !== "failed" && r.at > now() - DAY).length;
		if (today >= (src.autoSend?.max_per_day ?? 0)) return refuse("오늘 자동으로 보낼 수 있는 횟수를 다 썼어요");
	} else if (req.approval.by !== "owner") return refuse("보내기 승인이 없어요");
	const sendId = `send:${comment.id}`;
	const prior = store.replies().find(r => r.id === sendId);
	if (deps.inflight.has(sendId) || prior?.state === "sending" || prior?.state === "sent") return refuse(prior?.state === "sent" ? "이미 답글을 보냈어요" : "이미 보내는 중이에요");
	const adapter = deps.adapters[src.kind];
	if (!adapter) return refuse("이 댓글 종류를 보낼 수 없어요");
	const record: Reply = { id: sendId, commentId: comment.id, source: src.key, thread: comment.thread, text, state: "sending", at: now(), draft: draft.code, via: req.approval.by, collector: deps.collector };
	deps.inflight.add(sendId);
	store.putReply(record);
	deps.onState?.(record);
	const done = (async (): Promise<Reply> => {
		let outcome: ReplyOutcome;
		try {
			outcome = await adapter.reply(src, comment, text, sendId);
		} catch (e) {
			outcome = { ok: false, reason: e instanceof Error && e.message ? e.message.slice(0, 200) : "보내는 중 오류가 났어요" };
		}
		deps.inflight.delete(sendId);
		const final: Reply = outcome.ok ? { ...record, state: "sent", ...(outcome.ref ? { ref: outcome.ref } : {}) } : { ...record, state: "failed", reason: outcome.reason };
		store.putReply(final);
		if (outcome.ok) store.setDraftStatus(draft.code, "sent");
		deps.onState?.(final);
		return final;
	})();
	return { ok: true, reply: record, done };
}
