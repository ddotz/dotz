import { existsSync, readFileSync } from "node:fs";
import { log, paths } from "./config.ts";
import { dropClaim } from "./tone.ts";
import { restored } from "./notices-schedule.ts";
import type { Notice } from "./notices-types.ts";

/** The notices in `paths.notices` as read on start; empty when the file is missing or unreadable. An entry stored before the claim word was
 * dropped reads the same as a new one (clean), and so does an older report (restored). Split out of hub/notices-store.ts, code unchanged. */
export const loadNotices = (): Notice[] => {
	if (!existsSync(paths.notices)) return [];
	try {
		const parsed = JSON.parse(readFileSync(paths.notices, "utf8"));
		return Array.isArray(parsed) ? parsed.filter((n): n is Notice => typeof n?.id === "string" && typeof n.text === "string").map(n => ({ ...n, text: restored({ ...n, text: dropClaim(n.text) }) })) : [];
	} catch (e) {
		log(`notices.json unreadable, starting empty: ${e}`);
		return [];
	}
};
