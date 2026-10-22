// Watch: new YouTube comments without an owner reply, one `yt-comment ...` line each. One commentThreads call covers every
// video of the channel (1 quota unit per page, at most 3 pages); the baseline is the newest thread time seen, so the first
// run prints nothing, quiet hours and an exhausted quota leave it untouched and the next run catches up. When the 3 pages
// do not reach the baseline an extra `yt-comment-overflow` line says older new comments were not listed.
import type { Ctx } from "../lib/config.ts";
import { SetupError } from "../lib/config.ts";
import { COSTS, can } from "../lib/quota.ts";
import { main, oneLine, type RunResult, runWatch } from "../lib/watchkit.ts";
import { commentThreadsSince } from "../lib/youtube.ts";

const MAX_PAGES = 3;
type State = { since: string };

export async function run(ctx: Ctx, _args: string[] = []): Promise<RunResult> {
	return runWatch<State>(ctx, {
		quiet: true,
		body: async (cfg, prev) => {
			if (!cfg.youtube) throw new SetupError("youtube is not connected");
			if (!can(ctx, cfg, COSTS.list * MAX_PAGES)) return "skip";
			const { comments, newest, overflow } = await commentThreadsSince(ctx, cfg.youtube.channel_id, prev?.since, MAX_PAGES);
			const since = newest && (!prev || Date.parse(newest) > Date.parse(prev.since)) ? newest : (prev?.since ?? ctx.now().toISOString());
			const lines = comments.reverse().map(c => `yt-comment ${c.id} video=${c.videoId} by=${oneLine(c.author, 60)}: ${oneLine(c.text, 200)}`);
			if (overflow) lines.push(`yt-comment-overflow more than ${comments.length} new comments; older ones not listed`);
			return { lines, state: { since } };
		},
	});
}

if (import.meta.main) await main(run);
