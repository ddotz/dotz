// YouTube (Data API) and Instagram (Graph API) adapters of the comment contract. Both reuse the connection of features/youtube-instagram
// (tokens in ~/.dotz/secrets, quota accounting); there is no second login. The API access is injected so tests use stubs.
import type { Config, Ctx } from "../../../features/youtube-instagram/lib/config.ts";
import { mentions, ownerView, UNKNOWN_USER } from "../../../features/youtube-instagram/lib/ig-owner.ts";
import type { IgComment, IgMedia } from "../../../features/youtube-instagram/lib/instagram.ts";
import type { YtComment } from "../../../features/youtube-instagram/lib/youtube.ts";
import { type Comment, type CommentAdapter, FALLBACK_TITLE, type PostInfo, type RawComment } from "../contract.ts";

export type YoutubeApi = {
	channelId: () => string;
	threadsSince: (channelId: string, since: string | undefined) => Promise<{ comments: YtComment[]; newest?: string }>;
	uploads: (channelId: string) => Promise<{ id: string; title: string }[]>;
	/** Title and thumbnail of the given videos, answered from the cache and one batched videos.list call for the rest. Videos it cannot name are left out. */
	videos: (ids: string[]) => Promise<Record<string, { title: string; thumb?: string }>>;
	reply: (parentId: string, text: string) => Promise<string>;
	ownReplies: (channelId: string, limit: number) => Promise<string[]>;
};

const videoLink = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export function youtubeAdapter(api: () => YoutubeApi): CommentAdapter {
	return {
		kind: "youtube",
		async list(_src, cursor) {
			const a = api();
			const id = a.channelId();
			const { comments, newest } = await a.threadsSince(id, cursor);
			if (!comments.length) return { comments: [], cursor: newest ?? cursor };
			const info = await a.videos([...new Set(comments.map(c => c.videoId))]);
			const raw: RawComment[] = comments.map(c => ({
				native: c.id,
				thread: c.videoId,
				author: c.author,
				text: c.text,
				postTitle: info[c.videoId]?.title ?? FALLBACK_TITLE.youtube,
				postLink: videoLink(c.videoId),
				...(info[c.videoId]?.thumb ? { thumb: info[c.videoId]!.thumb } : {}),
				at: Date.parse(c.publishedAt) || 0,
				mine: c.authorChannelId === id,
			}));
			return { comments: raw, cursor: newest ?? cursor };
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
	reply: (commentId: string, text: string) => Promise<string>;
};

const igAuthor = (username: string | undefined): string => username || UNKNOWN_USER;
const known = (username: string | undefined): string | undefined => (username && username !== UNKNOWN_USER ? username : undefined);
const igTitle = (m: IgMedia): string => (m.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || FALLBACK_TITLE.instagram;
const igThumb = (m: IgMedia): string | undefined => m.thumb;

type IgCursor = { t?: string; counts?: Record<string, number> };

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
				const list = await a.comments(m.id);
				// Replies carry no author: the owner's are found by id and by his @mentions (lib/ig-owner.ts).
				const view = ownerView(list, owner);
				// The owner's and pinned replies come twice: nested under their parent (which knows the parent, but often not the author) and as an
				// entry of the top-level list under the same real id. Keep the nested one (stored once, with its parent) and borrow the author from the other.
				const topById = new Map(list.map(c => [c.id, c]));
				const nested = new Set(list.flatMap(c => (c.replies ?? []).flatMap(r => (r.id ? [r.id] : []))));
				for (const c of list) {
					// One malformed comment must not fail the whole read.
					try {
						const at = Date.parse(c.timestamp) || 0;
						if (!nested.has(c.id)) raw.push({ native: c.id, thread: m.id, author: igAuthor(c.username), text: c.text ?? "", ...shown, at, mine: view.isOwner(c) });
						// A reply is stored under its real id, author and time; only a reply the API gave no id gets a position-based id.
						(c.replies ?? []).forEach((r, i) => {
							const twin = r.id ? topById.get(r.id) : undefined;
							const when = Date.parse(r.timestamp ?? twin?.timestamp ?? "");
							raw.push({ native: r.id ?? `${c.id}.${i}`, thread: m.id, parent: c.id, author: igAuthor(known(r.username) ?? known(twin?.username)), text: r.text || (twin?.text ?? ""), ...shown, at: when || at + 1 + i, mine: view.isOwner(r) });
						});
					} catch {}
				}
			}
			const t = raw.reduce((max, r) => (r.at > Date.parse(max) ? new Date(r.at).toISOString() : max), prev.t ?? new Date(0).toISOString());
			return { comments: raw, cursor: JSON.stringify({ t, counts }) };
		},
		answered: (c, mine) => mine.some(x => x.at >= c.at && mentions(x.text, c.author)),
		// Older versions stored each reply a second time under a synthetic `<parent>.<n>` id (author unknown, the parent's time) next to the reply's
		// real record, which had no parent. One pass over what is stored: the real record takes the parent, the synthetic copy goes. A synthetic
		// reply without a real twin stays (it is all there is). Matching is by post and text, the twin must not predate the parent.
		tidy(src, stored) {
			const key = (c: Comment) => `${c.thread}\n${c.text}`;
			const synthetic = (c: Comment) => c.parent !== undefined && c.native.startsWith(`${c.parent}.`) && /^\d+$/.test(c.native.slice(c.parent.length + 1));
			const own = stored.filter(c => c.source === src.key);
			const at = new Map(own.map(c => [c.native, c.at]));
			const twins = new Map<string, Comment[]>();
			for (const c of own) if (!c.parent) twins.get(key(c))?.push(c) ?? twins.set(key(c), [c]);
			const parentOf = new Map<string, string>();
			const gone = new Set<string>();
			for (const c of own) {
				if (!synthetic(c)) continue;
				const from = at.get(c.parent!) ?? 0;
				const twin = twins.get(key(c))?.find(r => !parentOf.has(r.id) && r.native !== c.parent && r.at >= from && (c.author === UNKNOWN_USER || r.author === c.author));
				if (!twin) continue;
				parentOf.set(twin.id, c.parent!);
				gone.add(c.id);
			}
			return gone.size ? stored.filter(c => !gone.has(c.id)).map(c => (parentOf.has(c.id) ? { ...c, parent: parentOf.get(c.id)! } : c)) : undefined;
		},
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
