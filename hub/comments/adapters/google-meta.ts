// YouTube (Data API) and Instagram (Graph API) adapters of the comment contract. Both reuse the connection of features/youtube-instagram
// (tokens in ~/.dotz/secrets, quota accounting); there is no second login. The API access is injected so tests use stubs.
import type { Config, Ctx } from "../../../features/youtube-instagram/lib/config.ts";
import { mentions, ownerView, UNKNOWN_USER } from "../../../features/youtube-instagram/lib/ig-owner.ts";
import type { IgAuthor, IgComment, IgCommentRead, IgMedia } from "../../../features/youtube-instagram/lib/instagram.ts";
import type { YtComment, YtReply } from "../../../features/youtube-instagram/lib/youtube.ts";
import { type Comment, type CommentAdapter, FALLBACK_TITLE, type PostInfo, type RawComment } from "../contract.ts";

export type YoutubeApi = {
	channelId: () => string;
	threadsSince: (channelId: string, since: string | undefined) => Promise<{ comments: YtComment[]; newest?: string }>;
	uploads: (channelId: string) => Promise<{ id: string; title: string }[]>;
	/** Title and thumbnail of the given videos, answered from the cache and one batched videos.list call for the rest. Videos it cannot name are left out. */
	videos: (ids: string[]) => Promise<Record<string, { title: string; thumb?: string }>>;
	reply: (parentId: string, text: string) => Promise<string>;
	ownReplies: (channelId: string, limit: number) => Promise<string[]>;
	/** Re-reads top-level comments by id: the video and the channel's replies of each one still there; an id missing from the answer is deleted. */
	threadsByIds?: (channelId: string, ids: string[]) => Promise<Record<string, { videoId: string; replies: YtReply[] }>>;
	/** The threads the channel answered, newest first, with its replies (youtube.ts ownerHistory); `deadline` is epoch ms. Missing = no history. */
	history?: (channelId: string, opts: { target: number; deadline: number }) => Promise<YtComment[]>;
};

const videoLink = (id: string) => `https://www.youtube.com/watch?v=${id}`;

// A thread as stored rows: the top comment, then the channel's own replies that came with it (its answer is stored next to the comment, so the comment is not open).
function ytRows(c: YtComment, channelId: string, shown: Pick<RawComment, "postTitle" | "postLink" | "thumb">): RawComment[] {
	return [
		{ native: c.id, thread: c.videoId, author: c.author, text: c.text, ...shown, at: Date.parse(c.publishedAt) || 0, mine: c.authorChannelId === channelId },
		...(c.ownerReplies ?? []).map((r): RawComment => ({ native: r.id, thread: c.videoId, parent: c.id, author: r.author, text: r.text, ...shown, at: Date.parse(r.publishedAt) || 0, mine: true })),
	];
}

export function youtubeAdapter(api: () => YoutubeApi): CommentAdapter {
	return {
		kind: "youtube",
		async list(_src, cursor) {
			const a = api();
			const id = a.channelId();
			const { comments, newest } = await a.threadsSince(id, cursor);
			if (!comments.length) return { comments: [], cursor: newest ?? cursor };
			const info = await a.videos([...new Set(comments.map(c => c.videoId))]);
			// Issue #32: the InnerTube read (the usual path) carries no replies, so a comment the owner already answered looked open and got an auto draft.
			// The new comments that came without the channel's replies are looked up by id (1 unit per 50) before they are stored; a failed lookup keeps
			// the read as it is (the re-check finds the replies later).
			const bare = comments.filter(c => !c.ownerReplies && c.authorChannelId !== id).map(c => c.id);
			const found = bare.length && a.threadsByIds ? await a.threadsByIds(id, bare).catch(() => undefined) : undefined;
			for (const c of comments) if (!c.ownerReplies && found?.[c.id]?.replies.length) c.ownerReplies = found[c.id]!.replies;
			const shown = (videoId: string) => ({ postTitle: info[videoId]?.title ?? FALLBACK_TITLE.youtube, postLink: videoLink(videoId), ...(info[videoId]?.thumb ? { thumb: info[videoId]!.thumb } : {}) });
			const raw: RawComment[] = comments.flatMap(c => ytRows(c, id, shown(c.videoId)));
			return { comments: raw, cursor: newest ?? cursor };
		},
		// Past replies for the pair file: no video titles are looked up (a title costs quota and no pair needs it).
		async history(_src, opts) {
			const a = api();
			if (!a.history) return [];
			const id = a.channelId();
			return (await a.history(id, opts)).flatMap(c => ytRows(c, id, { postTitle: FALLBACK_TITLE.youtube, postLink: videoLink(c.videoId) }));
		},
		// The owner may answer an old comment long after it was read (the list reads "since newest"): look at the open ones again, by id.
		async recheck(_src, open) {
			const a = api();
			const tops = open.filter(c => !c.parent);
			if (!a.threadsByIds || !tops.length) return { comments: [], gone: [] };
			const found = await a.threadsByIds(a.channelId(), tops.map(c => c.native));
			const comments: RawComment[] = [];
			const gone: string[] = [];
			for (const c of tops) {
				const t = found[c.native];
				if (!t) {
					gone.push(c.native);
					continue;
				}
				for (const r of t.replies) comments.push({ native: r.id, thread: c.thread, parent: c.native, author: r.author, text: r.text, postTitle: c.postTitle, ...(c.postLink ? { postLink: c.postLink } : {}), ...(c.thumb ? { thumb: c.thumb } : {}), at: Date.parse(r.publishedAt) || 0, mine: true });
			}
			return { comments, gone };
		},
		async reply(_src, c, text) {
			try {
				return { ok: true, ref: await api().reply(c.native, text) };
			} catch (e) {
				return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "유튜브가 답글을 받지 않았어요" };
			}
		},
		async posts() {
			const a = api();
			return (await a.uploads(a.channelId())).map(u => ({ id: u.id, title: u.title, link: videoLink(u.id) }));
		},
		async retitle(_src, threads) {
			const info = await api().videos(threads);
			return Object.fromEntries(Object.entries(info).map(([id, v]): [string, PostInfo] => [id, { title: v.title, link: videoLink(id), ...(v.thumb ? { thumb: v.thumb } : {}) }]));
		},
		ownReplies: (_src, limit) => api().ownReplies(api().channelId(), limit),
	};
}

export type InstagramApi = {
	username: () => string;
	userId?: () => string;
	media: () => Promise<IgMedia[]>;
	comments: (mediaId: string) => Promise<IgComment[]>;
	/** Like `comments`, with whether every page was read (only then is a missing comment known to be deleted). Missing = `comments` read everything. */
	read?: (mediaId: string) => Promise<IgCommentRead>;
	reply: (commentId: string, text: string) => Promise<string>;
	/** Who wrote one reply (a single-object GET; the nested reply lists carry no author). Missing = replies keep the author the list gave. */
	author?: (replyId: string) => Promise<IgAuthor>;
	/** Resolved authors by reply id, kept for good (an author never changes). */
	authorCache?: { get: (replyId: string) => IgAuthor | undefined; put: (entries: Record<string, IgAuthor>) => void };
	/** The newest media of the account, paged (instagram.ts mediaHistory). Missing = `media`. */
	mediaHistory?: () => Promise<IgMedia[]>;
};
const MAX_AUTHOR_LOOKUPS = 150;
const MAX_HISTORY_LOOKUPS = 1000;

// Fills in the author of replies that came without one: from the cache first, else one single-object GET per reply (then cached).
// A lookup that fails (deleted reply, rate limit) leaves that reply as it was; a later read tries again.
// `budget`: lookups left, shared by the media of one history read.
async function withAuthors(a: InstagramApi, list: IgComment[], budget = { left: MAX_AUTHOR_LOOKUPS }): Promise<IgComment[]> {
	if (!a.author) return list;
	const fresh: Record<string, IgAuthor> = {};
	// A reply the list also gives at top level (the owner's, pinned ones) has its author there: no lookup for it (igRows borrows it).
	const topAuthor = new Set(list.filter(c => known(c.username)).map(c => c.id));
	const out: IgComment[] = [];
	for (const c of list) {
		const replies = [];
		for (const r of c.replies ?? []) {
			if (!r.id || r.username !== UNKNOWN_USER || topAuthor.has(r.id)) {
				replies.push(r);
				continue;
			}
			let who = a.authorCache?.get(r.id);
			if (!who && budget.left > 0) {
				budget.left--;
				who = await a.author(r.id).catch(() => undefined);
				if (who && (who.username || who.fromId)) fresh[r.id] = who;
			}
			replies.push(who ? { ...r, username: who.username || r.username, fromId: who.fromId ?? r.fromId } : r);
		}
		out.push({ ...c, replies });
	}
	a.authorCache?.put(fresh);
	return out;
}
const readMedia = async (a: InstagramApi, mediaId: string): Promise<IgCommentRead> => (a.read ? a.read(mediaId) : { comments: await a.comments(mediaId), complete: true });

const igAuthor = (username: string | undefined): string => username || UNKNOWN_USER;
const known = (username: string | undefined): string | undefined => (username && username !== UNKNOWN_USER ? username : undefined);
const igTitle = (m: IgMedia): string => (m.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || FALLBACK_TITLE.instagram;
const igThumb = (m: IgMedia): string | undefined => m.thumb;

type IgCursor = { t?: string; counts?: Record<string, number> };

// One media's read as stored rows, each comment once (issue #31): a top-level comment as it is; a reply under its comment, keyed by its real id with
// the API's own time; an item the comments edge listed although it is a reply (it is also in a `replies` list, or has `parent_id`) only as that reply.
// A reply without an id (never seen from the API) keeps the old `<comment>.<index>` key.
function igRows(list: IgComment[], isOwner: (c: { id?: string; username?: string; fromId?: string }) => boolean, thread: string, shown: Pick<RawComment, "postTitle" | "postLink" | "thumb">): RawComment[] {
	const nested = new Set(list.flatMap(c => (c.replies ?? []).map(r => r.id).filter((id): id is string => !!id)));
	// The same reply also listed at top level: its author, text and time fill what the nested copy lacks.
	const topById = new Map(list.map(c => [c.id, c]));
	const out: RawComment[] = [];
	for (const c of list) {
		// One malformed comment must not fail the whole read.
		try {
			if (nested.has(c.id)) continue;
			const at = Date.parse(c.timestamp) || 0;
			out.push({ native: c.id, thread, ...(c.parentId ? { parent: c.parentId } : {}), author: igAuthor(c.username), text: c.text ?? "", ...shown, at, mine: isOwner(c) });
			(c.replies ?? []).forEach((r, i) => {
				const twin = r.id ? topById.get(r.id) : undefined;
				out.push({ native: r.id ?? `${c.id}.${i}`, thread, parent: c.id, author: igAuthor(known(r.username) ?? known(twin?.username)), text: r.text || (twin?.text ?? ""), ...shown, at: Date.parse(r.timestamp ?? twin?.timestamp ?? "") || at + 1 + i, mine: isOwner(r) || (!!twin && isOwner(twin)) });
			});
		} catch {}
	}
	return out;
}

// History rows of one media: an own top-level row that @mentions the author of an earlier comment answers that comment (the owner's way of replying here), so it gets it as `parent`.
function withMentionParents(rows: RawComment[]): RawComment[] {
	return rows.map(r => {
		if (!r.mine || r.parent) return r;
		const asked = rows.filter(x => !x.mine && !x.parent && x.at < r.at && mentions(r.text, x.author)).sort((a, b) => b.at - a.at)[0];
		return asked ? { ...r, parent: asked.native } : r;
	});
}

// A media is read again only when its comment count moved since the last run (the count comes with the media list), so a quiet
// account costs one request per run.
export function instagramAdapter(api: () => InstagramApi): CommentAdapter {
	// The media list of the last list() call: retitle() right after it needs no second request.
	let lastMedia: IgMedia[] | undefined;
	return {
		kind: "instagram",
		async list(src, cursor) {
			const a = api();
			const prev: IgCursor = cursor ? JSON.parse(cursor) : {};
			const owner = { userId: a.userId?.(), username: a.username() };
			const counts: Record<string, number> = {};
			const raw: RawComment[] = [];
			lastMedia = await a.media();
			for (const m of lastMedia) {
				counts[m.id] = m.comments_count;
				if (!m.comments_count || (!src.watch.includes("*") && !src.watch.includes(m.id)) || prev.counts?.[m.id] === m.comments_count) continue;
				const title = igTitle(m), link = m.permalink, thumb = igThumb(m);
				const shown = { postTitle: title, ...(link ? { postLink: link } : {}), ...(thumb ? { thumb } : {}) };
				const list = await withAuthors(a, (await readMedia(a, m.id)).comments);
				// Replies carry no author in the list: it is looked up per reply (withAuthors); the owner's are found by author, by id and by his @mentions (lib/ig-owner.ts).
				raw.push(...igRows(list, ownerView(list, owner).isOwner, m.id, shown));
			}
			const t = raw.reduce((max, r) => (r.at > Date.parse(max) ? new Date(r.at).toISOString() : max), prev.t ?? new Date(0).toISOString());
			return { comments: raw, cursor: JSON.stringify({ t, counts }) };
		},
		// Re-reads the media that hold open comments (or replies still without an author): the owner's replies under them, with the author looked up, and
		// the open comments the platform no longer lists (only when every page was read).
		async recheck(_src, open) {
			const a = api();
			const owner = { userId: a.userId?.(), username: a.username() };
			const comments: RawComment[] = [];
			const gone: string[] = [];
			const byMedia = new Map<string, Comment[]>();
			for (const c of open) byMedia.set(c.thread, [...(byMedia.get(c.thread) ?? []), c]);
			let failure: unknown;
			let read = 0;
			for (const [mediaId, rows] of byMedia) {
				try {
					const res = await readMedia(a, mediaId);
					const list = await withAuthors(a, res.comments);
					const wanted = new Set(rows.map(r => r.parent ?? r.native));
					const first = rows[0]!;
					const shown = { postTitle: first.postTitle, ...(first.postLink ? { postLink: first.postLink } : {}), ...(first.thumb ? { thumb: first.thumb } : {}) };
					// His own rows handed over (stored top-level, issue #31) come back with their comment when they are replies.
					const selves = new Set(rows.filter(r => r.mine).map(r => r.native));
					comments.push(...igRows(list, ownerView(list, owner).isOwner, mediaId, shown).filter(r => r.mine && r.parent && (wanted.has(r.parent) || selves.has(r.native)) && !/\.\d+$/.test(r.native)));
					const seen = new Set(list.flatMap(c => [c.id, ...(c.replies ?? []).flatMap(r => (r.id ? [r.id] : []))]));
					if (res.complete) for (const r of rows) if (!r.parent && !seen.has(r.native)) gone.push(r.native);
					read++;
				} catch (e) {
					failure ??= e;
				}
			}
			// One media that cannot be read (deleted, no access) must not hide the rest; a read that failed everywhere is an error.
			if (failure && !read) throw failure;
			return { comments, gone };
		},
		// Past replies for the pair file, newest media first: each media that has comments is read like `list` does (authors looked up from one shared budget); only the owner's
		// replies and the comments they answer are kept. One media that cannot be read is skipped; a read that failed everywhere is an error.
		async history(_src, opts) {
			const a = api();
			const owner = { userId: a.userId?.(), username: a.username() };
			const budget = { left: MAX_HISTORY_LOOKUPS };
			const out: RawComment[] = [];
			let replies = 0;
			let failure: unknown;
			let read = 0;
			for (const m of a.mediaHistory ? await a.mediaHistory() : await a.media()) {
				if (replies >= opts.target || Date.now() >= opts.deadline) break;
				if (!m.comments_count) continue;
				try {
					const link = m.permalink, thumb = igThumb(m);
					const shown = { postTitle: igTitle(m), ...(link ? { postLink: link } : {}), ...(thumb ? { thumb } : {}) };
					const list = await withAuthors(a, (await readMedia(a, m.id)).comments, budget);
					const rows = withMentionParents(igRows(list, ownerView(list, owner).isOwner, m.id, shown));
					const answers = rows.filter(r => r.mine && r.parent && !/\.\d+$/.test(r.native));
					const asked = new Set(answers.map(r => r.parent));
					out.push(...answers, ...rows.filter(r => !r.mine && asked.has(r.native)));
					replies += answers.length;
					read++;
				} catch (e) {
					failure ??= e;
				}
			}
			if (failure && !read) throw failure;
			return out;
		},
		answered: (c, mine) => mine.some(x => x.at >= c.at && mentions(x.text, c.author)),
		// The target is always a comment id (a reply goes to its top-level comment), never a username.
		async reply(_src, c, text) {
			try {
				return { ok: true, ref: await api().reply(c.parent ?? c.native, text) };
			} catch (e) {
				return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "인스타가 답글을 받지 않았어요" };
			}
		},
		async posts() {
			return (await api().media()).map(m => ({ id: m.id, title: igTitle(m), ...(m.permalink ? { link: m.permalink } : {}), ...(igThumb(m) ? { thumb: igThumb(m) } : {}) }));
		},
		async retitle(_src, threads) {
			const out: Record<string, PostInfo> = {};
			for (const m of lastMedia ?? (await api().media())) if (threads.includes(m.id) && igTitle(m) !== FALLBACK_TITLE.instagram) out[m.id] = { title: igTitle(m), ...(m.permalink ? { link: m.permalink } : {}), ...(igThumb(m) ? { thumb: igThumb(m) } : {}) };
			return out;
		},
	};
}

export type { Config, Ctx };
