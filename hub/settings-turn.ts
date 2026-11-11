import { settingsContext, settingsTarget, type Turn } from "./app-settings.ts";
import { DATA_DIR, paths } from "./config.ts";
import { eventTarget, tailEvents } from "./events.ts";
import { appEntries } from "./integrations.ts";
import { watchOfSubject, watchSettingsContext } from "./watch-settings.ts";

// The note a settings turn carries (intake.ts sendWeb): the app's fields and values plus the last few turns of this conversation only.
// `conv` is the conversation the turn is in: the settings conversation, or the project's own when a monitor of that project is asked about.
export function settingsNote(app: string, conv = settingsTarget(app)): string {
	const target = conv;
	const mine = [...tailEvents(paths.inbox), ...tailEvents(paths.outbox)]
		.filter(e => (e.kind === "message" || e.kind === "out") && typeof e.text === "string" && eventTarget(e) === target)
		.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
	const recent: Turn[] = mine.map(e => ({ from: e.kind === "message" ? "owner" : "bot", text: String(e.text) }));
	const watch = watchOfSubject(app);
	if (watch) return watchSettingsContext(watch, recent);
	return settingsContext(DATA_DIR, app, appEntries(DATA_DIR).find(e => e.key === app)?.label ?? app, recent);
}
