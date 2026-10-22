// Watch: login upkeep, silent when fine. YouTube: makes sure a refresh-token grant still works (no quota cost, cached access
// token reused). Instagram: refreshes the long-lived token when it is older than 7 days or expires within 20 days. A
// rejected login prints DOTZ_FAIL youtube-auth / instagram-auth; network trouble is absorbed by the watch runner.
import type { Ctx } from "../lib/config.ts";
import { refreshIfNeeded } from "../lib/instagram.ts";
import { main, type RunResult, runWatch } from "../lib/watchkit.ts";
import { accessToken } from "../lib/youtube.ts";

export async function run(ctx: Ctx, _args: string[] = []): Promise<RunResult> {
	return runWatch<null>(ctx, {
		body: async cfg => {
			if (cfg.youtube) await accessToken(ctx);
			if (cfg.instagram) await refreshIfNeeded(ctx);
			return { lines: [] };
		},
	});
}

if (import.meta.main) await main(run);
