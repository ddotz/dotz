// Settings of one monitor (모니터링 > 일반 모니터링 > 설정): the same schema format as hub/app-settings.ts (validated by the same validateFields),
// but the values live on the watch. PATCH /api/watches/<name>/settings is the one write path and ends in patchWatch (hub/watch.ts), the call
// the project page and the pause button already use; the switches, a change card's 적용 and a peer's /api/peer/act all send that plain request.
import { settingsContextOf, validateFields, viewOf, type SettingField, type SettingValue, type SettingView, type Turn } from "./app-settings.ts";
import { allWatches, patchWatch } from "./watch.ts";

const WATCH_STORE = "watches.json";
export const WATCH_FIELDS: SettingField[] = [
	{ key: "enabled", label: "켜기", type: "bool", help: "끄면 확인을 멈추고, 켜면 다시 확인해요", store: WATCH_STORE, path: "paused", def: true, switch: true },
	{ key: "every_minutes", label: "확인 간격(분)", type: "number", help: "몇 분마다 확인할지예요 (1분에서 7일)", store: WATCH_STORE, path: "every_minutes", min: 1, max: 7 * 24 * 60, def: 10, switch: true },
	{ key: "to", label: "알림 방식", type: "enum", help: "비서가 먼저 보거나, 알림 대화나 채팅에 바로 알려요", store: WATCH_STORE, path: "to", options: ["orchestrator", "alert", "chat"], labels: { orchestrator: "비서가 알려줌", alert: "알림 대화", chat: "채팅" }, def: "orchestrator", switch: true },
	{ key: "label", label: "이름", type: "text", help: "목록에 보이는 이름이에요", store: WATCH_STORE, path: "label", def: "", switch: true },
];

/** The watch id or name of a settings subject "w:<name>", or undefined. */
export const watchOfSubject = (subject: string): string | undefined => (/^w:[a-z0-9-]{1,40}$/.test(subject) && allWatches().some(w => w.name === subject.slice(2)) ? subject.slice(2) : undefined);

const find = (idOrName: string) => {
	const w = allWatches().find(x => x.id === idOrName || x.name === idOrName);
	if (!w) throw new Error(`no watch ${idOrName}`);
	return w;
};
export function readWatchSettings(idOrName: string): SettingView[] {
	const w = find(idOrName);
	const value: Record<string, SettingValue> = { enabled: !w.paused, every_minutes: w.every_minutes, to: w.to, label: w.label ?? w.name };
	return WATCH_FIELDS.map(f => viewOf(f, value[f.key]!));
}

/** Validates the whole set, then one patchWatch call; never a partial write. */
export function writeWatchSettings(idOrName: string, values: unknown): SettingView[] {
	const w = find(idOrName), clean = validateFields(WATCH_FIELDS, values);
	const input: Record<string, unknown> = {};
	if (clean.enabled !== undefined) input.paused = !clean.enabled;
	for (const k of ["every_minutes", "to", "label"]) if (clean[k] !== undefined) input[k] = clean[k];
	patchWatch(w.id, input);
	return readWatchSettings(w.id);
}

/** What the orchestrator gets with a monitor's settings turn: only this monitor's fields and values. */
export const watchSettingsContext = (idOrName: string, recent: readonly Turn[] = []): string => {
	const w = find(idOrName);
	return settingsContextOf(`w:${w.name}`, `모니터 "${w.label ?? w.name}"`, readWatchSettings(w.id), recent);
};
