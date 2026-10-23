// YouTube (Data API) and Instagram (Graph API) adapters of the comment contract. Both reuse the connection of features/youtube-instagram
// (tokens in ~/.dotz/secrets, quota accounting); there is no second login. The API access is injected so tests use stubs.
import type { Config, Ctx } from "../../../features/youtube-instagram/lib/config.ts";
import type { IgComment, IgMedia } from "../../../features/youtube-instagram/lib/instagram.ts";
import type { YtComment } from "../../../features/youtube-instagram/lib/youtube.ts";
import { type CommentAdapter, FALLBACK_TITLE, type PostInfo, type RawComment } from "../contract.ts";

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
	media: () => Promise<IgMedia[]>;
	comments: (mediaId: string) => Promise<IgComment[]>;
	reply: (commentId: string, text: string) => Promise<string>;
};

const igAuthor = (username: string | undefined): string => username || "알 수 없는 사용자";
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
			const owner = a.username().toLowerCase();
			const counts: Record<string, number> = {};
			const raw: RawComment[] = [];
			lastMedia = await a.media();
			for (const m of lastMedia) {
				counts[m.id] = m.comments_count;
				if (!m.comments_count || (!src.watch.includes("*") && !src.watch.includes(m.id)) || prev.counts?.[m.id] === m.comments_count) continue;
				const title = igTitle(m), link = m.permalink, thumb = igThumb(m);
				const shown = { postTitle: title, ...(link ? { postLink: link } : {}), ...(thumb ? { thumb } : {}) };
				for (const c of await a.comments(m.id)) {
					// One malformed comment must not fail the whole read.
					try {
						const at = Date.parse(c.timestamp) || 0;
						raw.push({ native: c.id, thread: m.id, author: igAuthor(c.username), text: c.text ?? "", ...shown, at, mine: (c.username ?? "").toLowerCase() === owner });
						(c.replies ?? []).forEach((r, i) => raw.push({ native: `${c.id}.${i}`, thread: m.id, parent: c.id, author: igAuthor(r.username), text: r.text ?? "", ...shown, at: at + 1 + i, mine: (r.username ?? "").toLowerCase() === owner }));
					} catch {}
				}
			}
			const t = raw.reduce((max, r) => (r.at > Date.parse(max) ? new Date(r.at).toISOString() : max), prev.t ?? new Date(0).toISOString());
			return { comments: raw, cursor: JSON.stringify({ t, counts }) };
		},
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
