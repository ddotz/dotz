import { listSchedules } from "./schedule.ts";
import { allWatches } from "./watch.ts";

// The read-only monitor list for the web (GET /api/monitors): every watch and schedule with the words the owner reads.
export type Monitor = {
	name: string;
	kind: "watch" | "schedule";
	channel?: string;
	last_run?: string;
	last_result?: "ok" | "changed" | "fail";
	next_run?: string;
	every?: string;
};

export const everyKo = (m: number): string => (m % 1440 === 0 ? `${m / 1440}일마다` : m % 60 === 0 ? `${m / 60}시간마다` : `${m}분마다`);
const iso = (ms: number) => new Date(ms).toISOString();

export function listMonitors(): Monitor[] {
	const watches: Monitor[] = allWatches().map(w => {
		const last = w.state.lastRun;
		const result = !last ? undefined : w.state.fails > 0 ? "fail" : w.state.lastChanged ? "changed" : "ok";
		const next = w.paused || w.state.paused ? undefined : w.state.nextAt ?? Date.parse(last ?? w.created) + w.every_minutes * 60_000;
		return {
			name: w.name,
			kind: "watch",
			...(w.channels?.[0] ? { channel: w.channels[0] } : {}),
			...(last ? { last_run: last } : {}),
			...(result ? { last_result: result } : {}),
			...(next && Number.isFinite(next) ? { next_run: iso(next) } : {}),
			every: everyKo(w.every_minutes),
		};
	});
	const schedules: Monitor[] = listSchedules().map(s => {
		// A schedule's text starts with its internal target (ch:<id>, lane:<name>); the owner reads the words.
		const channel = /^\s*(ch:\d+)/.exec(s.text)?.[1];
		const name = s.text.replace(/^\s*(?:(?:ch|lane|th):\S+\s*)+/, "").trim().slice(0, 60) || "예약";
		return {
			name,
			kind: "schedule",
			...(channel ? { channel } : {}),
			...(s.last ? { last_run: s.last, last_result: "ok" as const } : {}),
			...(s.paused ? {} : { next_run: s.at }),
			...(s.every_minutes ? { every: everyKo(s.every_minutes) } : {}),
		};
	});
	return [...watches, ...schedules];
}
