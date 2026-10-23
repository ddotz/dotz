// YouTube (Data API) and Instagram (Graph API) adapters of the comment contract. Both reuse the connection of features/youtube-instagram
// (tokens in ~/.dotz/secrets, quota accounting); there is no second login. The API access is injected so tests use stubs.
import type { Config, Ctx } from "../../../features/youtube-instagram/lib/config.ts";
import type { IgComment, IgMedia } from "../../../features/youtube-instagram/lib/instagram.ts";
import type { YtComment } from "../../../features/youtube-instagram/lib/youtube.ts";
import type { CommentAdapter, RawComment } from "../contract.ts";

export type YoutubeApi = {
	channelId: () => string;
	threadsSince: (channelId: string, since: string | undefined) => Promise<{ comments: YtComment[]; newest?: string }>;
	uploads: (channelId: string) => Promise<{ id: string; title: string }[]>;
	reply: (parentId: string, text: string) => Promise<string>;
	ownReplies: (channelId: string, limit: number) => Promise<string[]>;
};

export function youtubeAdapter(api: () => YoutubeApi): CommentAdapter {
	return {
		kind: "youtube",
		async list(_src, cursor) {
			const a = api();
			const id = a.channelId();
			const { comments, newest } = await a.threadsSince(id, cursor);
			if (!comments.length) return { comments: [], cursor: newest ?? cursor };
			const titles = new Map((await a.uploads(id)).map(u => [u.id, u.title]));
			const raw: RawComment[] = comments.map(c => ({
				native: c.id,
				thread: c.videoId,
				author: c.author,
				text: c.text,
				postTitle: titles.get(c.videoId) ?? "유튜브 영상",
				postLink: `https://www.youtube.com/watch?v=${c.videoId}`,
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
			return (await a.uploads(a.channelId())).map(u => ({ id: u.id, title: u.title, link: `https://www.youtube.com/watch?v=${u.id}` }));
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

type IgCursor = { t?: string; counts?: Record<string, number> };

// A media is read again only when its comment count moved since the last run (the count comes with the media list), so a quiet
// account costs one request per run.
export function instagramAdapter(api: () => InstagramApi): CommentAdapter {
	return {
		kind: "instagram",
		async list(src, cursor) {
			const a = api();
			const prev: IgCursor = cursor ? JSON.parse(cursor) : {};
			const owner = a.username().toLowerCase();
			const counts: Record<string, number> = {};
			const raw: RawComment[] = [];
			for (const m of await a.media()) {
				counts[m.id] = m.comments_count;
				if (!m.comments_count || (!src.watch.includes("*") && !src.watch.includes(m.id)) || prev.counts?.[m.id] === m.comments_count) continue;
				const title = (m.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "인스타 게시물";
				for (const c of await a.comments(m.id)) {
					// One malformed comment must not fail the whole read.
					try {
						const at = Date.parse(c.timestamp) || 0;
						raw.push({ native: c.id, thread: m.id, author: igAuthor(c.username), text: c.text ?? "", postTitle: title, at, mine: (c.username ?? "").toLowerCase() === owner });
						(c.replies ?? []).forEach((r, i) => raw.push({ native: `${c.id}.${i}`, thread: m.id, parent: c.id, author: igAuthor(r.username), text: r.text ?? "", postTitle: title, at: at + 1 + i, mine: (r.username ?? "").toLowerCase() === owner }));
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
			return (await api().media()).map(m => ({ id: m.id, title: (m.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "인스타 게시물" }));
		},
	};
}

export type { Config, Ctx };
