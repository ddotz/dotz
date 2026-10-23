// Watch: login upkeep, silent when fine. YouTube: makes sure a refresh-token grant still works (no quota cost, cached access
// token reused). Instagram: refreshes the long-lived token when it is older than 7 days or expires within 20 days. A
// rejected login prints DOTZ_FAIL youtube-auth / instagram-auth; network trouble is absorbed by the watch runner. An app with an
// external token source (lib/token-source.ts) is updated from it instead of refreshed here; its 2nd failed run in a row prints DOTZ_FAIL token-source.
// `tokens.ts instagram|youtube` handles one platform (the per-app watches sns-ig-tokens / sns-yt-tokens); no argument does both.
import type { Ctx } from "../lib/config.ts";
import { refreshIfNeeded } from "../lib/instagram.ts";
import { syncInstagramSource, syncYoutubeSource } from "../lib/token-source.ts";
import { main, type RunResult, runWatch } from "../lib/watchkit.ts";
import { accessToken } from "../lib/youtube.ts";

export async function run(ctx: Ctx, args: string[] = []): Promise<RunResult> {
	const only = args[0];
	return runWatch<null>(ctx, {
		body: async cfg => {
			if (cfg.youtube && only !== "instagram") {
				await syncYoutubeSource(ctx, cfg);
				await accessToken(ctx);
			}
			if (cfg.instagram && only !== "youtube") {
				if (cfg.instagram.token_source) await syncInstagramSource(ctx, cfg);
				else await refreshIfNeeded(ctx);
			}
			return { lines: [] };
		},
	});
}

if (import.meta.main) await main(run);
