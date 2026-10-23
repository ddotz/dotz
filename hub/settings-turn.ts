import { settingsContext, settingsTarget, type Turn } from "./app-settings.ts";
import { DATA_DIR, paths } from "./config.ts";
import { eventTarget, tailEvents } from "./events.ts";
import { INTEGRATIONS } from "./integrations.ts";

// The note a settings turn carries (intake.ts sendWeb): the app's fields and values plus the last few turns of this conversation only.
export function settingsNote(app: string): string {
	const target = settingsTarget(app);
	const mine = [...tailEvents(paths.inbox), ...tailEvents(paths.outbox)]
		.filter(e => (e.kind === "message" || e.kind === "out") && typeof e.text === "string" && eventTarget(e) === target)
		.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
	const recent: Turn[] = mine.map(e => ({ from: e.kind === "message" ? "owner" : "bot", text: String(e.text) }));
	return settingsContext(DATA_DIR, app, INTEGRATIONS.find(e => e.key === app)?.label ?? app, recent);
}
