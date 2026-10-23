// Real wiring of the Instagram DM routes inside the gateway (hub/routes.ts imports this).
import { loadConfig, realCtx } from "../features/youtube-instagram/lib/config.ts";
import { readDms, syncDms } from "../features/youtube-instagram/lib/ig-dm.ts";
import { DATA_DIR } from "./config.ts";
import { featureEnabled } from "./app-feature-flags.ts";
import { createIgDmWeb } from "./ig-dm-web.ts";

const enabled = (): boolean => featureEnabled(DATA_DIR, "instagram", "dm_read");
const account = () => {
	try {
		const i = loadConfig().instagram;
		return i ? { id: i.user_id, username: i.username } : undefined;
	} catch {
		return undefined;
	}
};

export const igDmRoute = createIgDmWeb({
	enabled,
	account,
	read: readDms,
	sync: async () => {
		const own = account();
		if (!own) throw new Error("인스타가 연결돼 있지 않아요");
		return syncDms(realCtx(), { enabled, own });
	},
}).route;
