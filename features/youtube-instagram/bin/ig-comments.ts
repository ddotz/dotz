// Watch: new Instagram comments without an owner reply, one `ig-comment ...` line each. One media call per run; comments
// are only fetched for media whose comments_count changed since the last run. The first run records the counts and the
// time and prints nothing; quiet hours leave the baseline alone so the next run catches up.
import type { Ctx } from "../lib/config.ts";
import { SetupError } from "../lib/config.ts";
import type { CommentDeps } from "../../reply-drafts/lib/comments.ts";
import { commentsFor, mediaWithCounts } from "../lib/instagram.ts";
import { withReplyDrafts } from "../lib/reply-adapter.ts";
import { main, oneLine, type RunResult, runWatch } from "../lib/watchkit.ts";

type State = { counts: Record<string, number>; since: string };

// With the reply-drafts switch for instagram on, the comment lines come out as ready approval [ask] messages (reply-drafts/lib/comments.ts).
export async function run(ctx: Ctx, _args: string[] = [], deps?: CommentDeps): Promise<RunResult> {
	const res = await runWatch<State>(ctx, {
		quiet: true,
		body: async (cfg, prev) => {
			if (!cfg.instagram) throw new SetupError("instagram is not connected");
			const owner = cfg.instagram.username.toLowerCase();
			const media = await mediaWithCounts(ctx);
			const counts = Object.fromEntries(media.map(m => [m.id, m.comments_count]));
			if (!prev) return { lines: [], state: { counts, since: ctx.now().toISOString() } };
			const sinceMs = Date.parse(prev.since);
			let newest = sinceMs;
			const found: { at: number; line: string }[] = [];
			for (const m of media.filter(x => x.comments_count !== (prev.counts[x.id] ?? 0))) {
				for (const c of await commentsFor(ctx, m.id)) {
					const at = Date.parse(c.timestamp);
					if (at <= sinceMs) continue;
					newest = Math.max(newest, at);
					if (c.username.toLowerCase() === owner || c.replies.some(r => r.username.toLowerCase() === owner)) continue;
					found.push({ at, line: `ig-comment ${c.id} media=${m.id} by=${oneLine(c.username, 60)}: ${oneLine(c.text, 200)}` });
				}
			}
			found.sort((a, b) => a.at - b.at);
			return { lines: found.map(f => f.line), state: { counts, since: new Date(newest).toISOString() } };
		},
	});
	return withReplyDrafts(ctx, "instagram", res, deps);
}

if (import.meta.main) await main(run);
