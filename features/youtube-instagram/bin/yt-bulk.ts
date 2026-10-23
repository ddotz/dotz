// Watch (hourly, only with youtube.bulk on): multilingual descriptions for every public video, within the day's quota budget
// (lib/bulk.ts). Prints one Korean progress line that changes only every 10%, which the YouTube app shows as its row.
import type { Translate } from "../lib/bulk.ts";
import { runBulk } from "../lib/bulk.ts";
import { type Ctx } from "../lib/config.ts";
import { main, type RunResult, runWatch } from "../lib/watchkit.ts";

export async function run(ctx: Ctx, _args: string[] = [], translate?: Translate): Promise<RunResult> {
	return runWatch<null>(ctx, {
		body: async cfg => {
			if (!cfg.youtube?.bulk) return "skip";
			const call = translate ?? (await import("../../reply-drafts/lib/flow.ts")).defaultCall();
			return { lines: await runBulk(ctx, cfg, { translate: call }) };
		},
	});
}

if (import.meta.main) await main(run);
