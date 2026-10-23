// Reading the new comments of the owner's channel: InnerTube first (no quota, lib/innertube.ts), the Data API commentThreads as the
// fallback when the web endpoints change or fail. InnerTube shows only relative times, so "new" is decided by comment ids kept per
// caller (scope): the first read of a scope records what is there and reports nothing, like the Data API's first read. Comments
// that already have replies are taken as handled, and the channel's own comments are skipped. A fallback read adds its ids too, so
// switching back never repeats a comment.
import { type Ctx, paths, readJson, writeJson } from "./config.ts";
import { InnerTubeError, innertubeComments } from "./innertube.ts";
import { commentThreadsSince, type YtComment } from "./youtube.ts";

export type CommentRead = { comments: YtComment[]; newest?: string; overflow: boolean };
export const hooks: { read?: typeof innertubeComments } = {};
export type ReadOpts = { scope: string; allowApi: boolean; read?: typeof innertubeComments };

const SEEN_CAP = 3000;
type Seen = Record<string, string[]>;

const loadSeen = (): Seen => {
	try {
		return readJson<Seen>(paths.innertubeSeen()) ?? {};
	} catch {
		return {};
	}
};
const remember = (scope: string, ids: string[]): void => {
	const all = loadSeen();
	all[scope] = [...new Set([...(all[scope] ?? []), ...ids])].slice(-SEEN_CAP);
	writeJson(paths.innertubeSeen(), all);
};

export async function readCommentsSince(ctx: Ctx, channelId: string, since: string | undefined, maxPages: number, o: ReadOpts): Promise<CommentRead | undefined> {
	try {
		const inner = await (o.read ?? hooks.read ?? innertubeComments)(ctx, channelId);
		const known = new Set(loadSeen()[o.scope] ?? []);
		const first = since === undefined || known.size === 0;
		remember(o.scope, inner.map(c => c.id));
		const now = ctx.now().toISOString();
		if (first) return { comments: [], newest: now, overflow: false };
		const fresh = inner.filter(c => !known.has(c.id) && c.authorChannelId !== channelId && c.replyCount === 0);
		const comments: YtComment[] = fresh
			.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
			.map(c => ({ id: c.id, videoId: c.videoId, videoTitle: c.videoTitle, author: c.author, authorChannelId: c.authorChannelId, text: c.text, publishedAt: c.publishedAt, replied: false }));
		return { comments, newest: now, overflow: false };
	} catch (e) {
		if (!(e instanceof InnerTubeError)) throw e;
		if (!o.allowApi) return undefined;
		const r = await commentThreadsSince(ctx, channelId, since, maxPages);
		if (r.comments.length && Object.keys(loadSeen()).length) remember(o.scope, r.comments.map(c => c.id));
		return r;
	}
}
