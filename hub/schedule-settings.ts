// Settings of one schedule (모니터링 > 일반 모니터링 > 예약 > ⋯): the same schema format as a watch's (hub/watch-settings.ts), so the web draws
// the same settings screen. GET / PATCH /api/schedules/<id>/settings; the write ends in patchSchedule (hub/schedule.ts), the call the project
// page already uses. The schedule's internal target (ch:<id>, lane:<name> at the start of its text) is kept as it is: the owner edits the words.
import { SettingsError, validateFields, viewOf, type SettingField, type SettingValue, type SettingView } from "./app-settings.ts";
import { listSchedules, MIN_EVERY_MINUTES, NAME_MAX, patchSchedule, type Schedule, SCHEDULE_KINDS, scheduleKind } from "./schedule.ts";

const STORE = "schedules.json";
export const SCHEDULE_FIELDS: SettingField[] = [
	{ key: "name", label: "이름", type: "text", help: "목록과 알림에 보이는 이름이에요", store: STORE, path: "name", max: NAME_MAX, def: "", switch: true, section: "watch" },
	{ key: "kind", label: "종류", type: "enum", help: "알림은 그 시각에 알려 주고, 작업은 비서가 일을 하고 결과를 알려 주고, 조용한 점검은 꼭 알아야 할 때만 알려요", store: STORE, path: "kind", options: [...SCHEDULE_KINDS], labels: { owner: "알림", task: "작업", check: "조용한 점검" }, def: "owner", switch: true, section: "watch" },
	{ key: "enabled", label: "예약 켜기", type: "bool", help: "끄면 실행을 멈추고, 켜면 다음 시각부터 다시 실행해요", store: STORE, path: "paused", def: true, switch: true, section: "watch" },
	{ key: "at", label: "다음 실행", type: "text", help: "예: 2026-11-02 09:00 (이 컴퓨터 시간)", store: STORE, path: "at", max: 40, def: "", switch: true, section: "watch" },
	{ key: "every_minutes", label: "반복", type: "enum", help: "다시 실행하는 간격이에요. 시각은 다음 실행을 따라요", store: STORE, path: "every_minutes", options: [], def: "0", switch: true, section: "watch" },
	{ key: "text", label: "내용", type: "text", help: "정해진 시각에 비서에게 보내는 지시예요", store: STORE, path: "text", max: 2000, def: "", switch: true, section: "advanced", lines: 5 },
];

// The internal target at the start of a schedule's text (hub/monitors.ts strips the same prefix for the row's name).
const PREFIX = /^\s*(?:(?:ch|lane|th):\S+\s*)+/;
const pad = (n: number) => String(n).padStart(2, "0");
/** An ISO time as the hub's own clock reads it, "YYYY-MM-DD HH:MM". */
export const localTime = (iso: string): string => {
	const d = new Date(iso);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const clock = (d: Date) => `${d.getHours() < 12 ? "오전" : "오후"} ${d.getHours() % 12 || 12}:${pad(d.getMinutes())}`;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
/** A schedule's repeat as the owner reads it, its time of day from `at` on the hub's clock: "매일 오전 7:00", "매주 월요일 오전 9:00", "2시간마다"; "" for a one-shot. */
export function repeatLabel(minutes: number, at: string): string {
	if (!minutes) return "";
	const d = new Date(at), days = minutes % 1440 === 0 ? minutes / 1440 : 0;
	if (days === 7) return `매주 ${WEEKDAYS[d.getDay()]}요일 ${clock(d)}`;
	if (days) return `${days === 1 ? "매일" : `${days}일마다`} ${clock(d)}`;
	return minutes === 60 ? "매시간" : minutes % 60 === 0 ? `${minutes / 60}시간마다` : `${minutes}분마다`;
}
const REPEATS = [0, 30, 60, 180, 360, 720, 1440, 10080];
const fieldsOf = (s: Schedule): SettingField[] => {
	const options = [...new Set([...REPEATS, s.every_minutes ?? 0])].sort((a, b) => a - b);
	const labels = Object.fromEntries(options.map(m => [String(m), repeatLabel(m, s.at) || "한 번만"]));
	return SCHEDULE_FIELDS.map(f => (f.key === "every_minutes" ? { ...f, options: options.map(String), labels } : f));
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
	const value: Record<string, SettingValue> = { name: s.name ?? "", kind: scheduleKind(s), enabled: !s.paused, at: localTime(s.at), every_minutes: String(s.every_minutes ?? 0), text: s.text.replace(PREFIX, "").trim() };
	return fieldsOf(s).map(f => viewOf(f, value[f.key]!));
}

/** Validates the whole set, then one patchSchedule call; never a partial write. */
export function writeScheduleSettings(id: string, values: unknown): SettingView[] {
	const s = find(id), clean = validateFields(fieldsOf(s), values);
	const input: Record<string, unknown> = {};
	if (clean.enabled !== undefined) input.paused = !clean.enabled;
	if (clean.at !== undefined) input.at = parseLocal(String(clean.at));
	if (clean.every_minutes !== undefined) {
		const n = Number(clean.every_minutes);
		if (n && n < MIN_EVERY_MINUTES) throw new SettingsError(`every_minutes: 0이거나 ${MIN_EVERY_MINUTES}분 이상이어야 해요`);
		input.every_minutes = n || null;
	}
	if (clean.name !== undefined) {
		if (!String(clean.name).trim()) throw new SettingsError("name: 이름이 비어 있어요");
		input.name = clean.name;
	}
	if (clean.kind !== undefined) input.kind = clean.kind;
	if (clean.text !== undefined) {
		if (!clean.text) throw new SettingsError("text: 내용이 비어 있어요");
		input.text = `${(PREFIX.exec(s.text)?.[0] ?? "").trim()} ${clean.text}`.trim();
	}
	patchSchedule(s.id, input);
	return readScheduleSettings(s.id);
}
