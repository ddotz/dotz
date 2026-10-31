// Settings of one schedule (모니터링 > 일반 모니터링 > 예약 > ⋯): the same schema format as a watch's (hub/watch-settings.ts), so the web draws
// the same settings screen. GET / PATCH /api/schedules/<id>/settings; the write ends in patchSchedule (hub/schedule.ts), the call the project
// page already uses. The schedule's internal target (ch:<id>, lane:<name> at the start of its text) is kept as it is: the owner edits the words.
import { SettingsError, validateFields, viewOf, type SettingField, type SettingValue, type SettingView } from "./app-settings.ts";
import { listSchedules, MIN_EVERY_MINUTES, patchSchedule } from "./schedule.ts";

const STORE = "schedules.json";
export const SCHEDULE_FIELDS: SettingField[] = [
	{ key: "enabled", label: "예약 켜기", type: "bool", help: "끄면 실행을 멈추고, 켜면 다음 시각부터 다시 실행해요", store: STORE, path: "paused", def: true, switch: true, section: "watch" },
	{ key: "at", label: "다음 실행", type: "text", help: "예: 2026-11-02 09:00 (이 컴퓨터 시간)", store: STORE, path: "at", max: 40, def: "", switch: true, section: "watch" },
	{ key: "every_minutes", label: "반복 주기(분)", type: "number", help: `몇 분마다 다시 실행할지예요 (0은 한 번만, ${MIN_EVERY_MINUTES}분에서 7일)`, store: STORE, path: "every_minutes", min: 0, max: 7 * 24 * 60, switch: true, section: "watch" },
	{ key: "text", label: "내용", type: "text", help: "정해진 시각에 비서에게 보내는 지시예요", store: STORE, path: "text", max: 2000, def: "", switch: true, section: "advanced" },
];

// The internal target at the start of a schedule's text (hub/monitors.ts strips the same prefix for the row's name).
const PREFIX = /^\s*(?:(?:ch|lane|th):\S+\s*)+/;
const pad = (n: number) => String(n).padStart(2, "0");
/** An ISO time as the hub's own clock reads it, "YYYY-MM-DD HH:MM". */
export const localTime = (iso: string): string => {
	const d = new Date(iso);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// "YYYY-MM-DD HH:MM" is local time (what the screen shows); an ISO time with an offset is taken as it is.
const parseLocal = (s: string): string => {
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(s.trim());
	const ms = m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!).getTime() : Date.parse(s);
	if (!Number.isFinite(ms)) throw new SettingsError("at: YYYY-MM-DD HH:MM 형식이어야 해요");
	return new Date(ms).toISOString();
};

const find = (id: string) => {
	const s = listSchedules().find(x => x.id === id);
	if (!s) throw new SettingsError(`no schedule ${id}`, 404);
	return s;
};
export function readScheduleSettings(id: string): SettingView[] {
	const s = find(id);
	const value: Record<string, SettingValue> = { enabled: !s.paused, at: localTime(s.at), every_minutes: s.every_minutes ?? 0, text: s.text.replace(PREFIX, "").trim() };
	return SCHEDULE_FIELDS.map(f => viewOf(f, value[f.key]!));
}

/** Validates the whole set, then one patchSchedule call; never a partial write. */
export function writeScheduleSettings(id: string, values: unknown): SettingView[] {
	const s = find(id), clean = validateFields(SCHEDULE_FIELDS, values);
	const input: Record<string, unknown> = {};
	if (clean.enabled !== undefined) input.paused = !clean.enabled;
	if (clean.at !== undefined) input.at = parseLocal(String(clean.at));
	if (clean.every_minutes !== undefined) {
		const n = Number(clean.every_minutes);
		if (n && n < MIN_EVERY_MINUTES) throw new SettingsError(`every_minutes: 0이거나 ${MIN_EVERY_MINUTES}분 이상이어야 해요`);
		input.every_minutes = n || null;
	}
	if (clean.text !== undefined) {
		if (!clean.text) throw new SettingsError("text: 내용이 비어 있어요");
		input.text = `${(PREFIX.exec(s.text)?.[0] ?? "").trim()} ${clean.text}`.trim();
	}
	patchSchedule(s.id, input);
	return readScheduleSettings(s.id);
}
