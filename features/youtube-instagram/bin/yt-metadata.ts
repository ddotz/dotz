// Watch (daily): recent uploads that miss one of the configured languages, one `needs-translation ...` line per new video.
// Two list calls (uploads playlist, then videos with localizations). The first run records the recent videos and prints
// nothing; a video is reported once.
import { type Ctx, SetupError } from "../lib/config.ts";
import { COSTS, can } from "../lib/quota.ts";
import { main, oneLine, type RunResult, runWatch } from "../lib/watchkit.ts";
import { recentUploads, videosWithLocalizations } from "../lib/youtube.ts";

const RECENT = 10;
const SEEN_CAP = 200;
type State = { seen: string[] };

export async function run(ctx: Ctx, _args: string[] = []): Promise<RunResult> {
	return runWatch<State>(ctx, {
		body: async (cfg, prev) => {
			if (!cfg.youtube) throw new SetupError("youtube is not connected");
			const { channel_id, base_language, languages } = cfg.youtube;
			const targets = languages.filter(l => l !== base_language);
			if (!targets.length) return "skip";
			if (!can(ctx, cfg, COSTS.list * 2)) return "skip";
			const uploads = await recentUploads(ctx, channel_id, RECENT);
			const videos = uploads.length ? await videosWithLocalizations(ctx, uploads.map(u => u.id)) : [];
			const seen = new Set(prev?.seen ?? []);
			const lines: string[] = [];
			if (prev) {
				for (const v of videos.filter(x => !seen.has(x.id))) {
					const missing = targets.filter(l => !v.localizations[l]);
					if (missing.length) lines.push(`needs-translation ${v.id} missing=${missing.join(",")}: ${oneLine(v.title, 120)}`);
				}
			}
			return { lines, state: { seen: [...new Set([...(prev?.seen ?? []), ...videos.map(v => v.id)])].slice(-SEEN_CAP) } };
		},
	});
}

if (import.meta.main) await main(run);
