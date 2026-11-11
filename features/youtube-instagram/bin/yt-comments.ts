// Watch: new YouTube comments without an owner reply, one `yt-comment ...` line each. The comments are read through InnerTube
// without quota (lib/yt-read.ts); only when that fails does one commentThreads call cover every video of the channel (1 quota unit
// per page, at most 3 pages). The first run prints nothing, quiet hours leave the baseline untouched and the next run catches up.
// On the Data API path, 3 pages that do not reach the baseline add a `yt-comment-overflow` line (older new comments not listed).
import type { Ctx } from "../lib/config.ts";
import { SetupError } from "../lib/config.ts";
import type { CommentDeps } from "../../reply-drafts/lib/comments.ts";
import { COSTS, can } from "../lib/quota.ts";
import { realReplyDeps, titleArg, withReplyDrafts } from "../lib/reply-adapter.ts";
import { main, oneLine, type RunResult, runWatch } from "../lib/watchkit.ts";
import { readCommentsSince } from "../lib/yt-read.ts";
import { videoInfos } from "../lib/youtube.ts";

const MAX_PAGES = 3;
type State = { since: string };

// With the reply-drafts switch for youtube on, the comment lines come out as ready approval [ask] messages (reply-drafts/lib/comments.ts).
export async function run(ctx: Ctx, _args: string[] = [], deps?: CommentDeps): Promise<RunResult> {
	const res = await runWatch<State>(ctx, {
		quiet: true,
		body: async (cfg, prev) => {
			if (!cfg.youtube) throw new SetupError("youtube is not connected");
			const read = await readCommentsSince(ctx, cfg.youtube.channel_id, prev?.since, MAX_PAGES, { scope: "watch", allowApi: can(ctx, cfg, COSTS.list * MAX_PAGES) });
			if (!read) return "skip";
			const { comments, newest, overflow } = read;
			const since = newest && (!prev || Date.parse(newest) > Date.parse(prev.since)) ? newest : (prev?.since ?? ctx.now().toISOString());
			const untitled = comments.filter(c => !c.videoTitle).map(c => c.videoId);
			const info = untitled.length ? await videoInfos(ctx, untitled) : {};
			const lines = comments.reverse().map(c => `yt-comment ${c.id} video=${c.videoId}${titleArg(c.videoTitle ?? info[c.videoId]?.title)} by=${oneLine(c.author, 60)}: ${oneLine(c.text, 200)}`);
			if (overflow) lines.push(`yt-comment-overflow more than ${comments.length} new comments; older ones not listed`);
			return { lines, state: { since } };
		},
	});
	return withReplyDrafts(ctx, "youtube", res, deps);
}

if (import.meta.main) await main((ctx, args) => run(ctx, args, realReplyDeps()));
