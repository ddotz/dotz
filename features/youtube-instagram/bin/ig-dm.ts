// Watch: reads the Instagram DMs (read only) into cache/ig-dm.json for the 모니터링 > 인스타 DM view. It prints nothing: a DM never wakes the
// orchestrator. One conversation-list call per run, plus the messages of the conversations whose updated_time moved. With the feature
// row "DM 읽기" off (hub/app-features.ts) it makes no request at all.
import { featureEnabled } from "../../../hub/app-feature-flags.ts";
import { type Ctx, dataDir, SetupError } from "../lib/config.ts";
import { syncDms } from "../lib/ig-dm.ts";
import { main, type RunResult, runWatch } from "../lib/watchkit.ts";

export const dmEnabled = (): boolean => featureEnabled(dataDir(), "instagram", "dm_read");

export async function run(ctx: Ctx, _args: string[] = [], enabled: () => boolean = dmEnabled): Promise<RunResult> {
	return runWatch<null>(ctx, {
		quiet: true,
		body: async cfg => {
			if (!cfg.instagram) throw new SetupError("instagram is not connected");
			await syncDms(ctx, { enabled, own: { id: cfg.instagram.user_id, username: cfg.instagram.username } });
			return { lines: [] };
		},
	});
}

if (import.meta.main) await main((ctx, args) => run(ctx, args));
