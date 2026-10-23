import { listSchedules } from "./schedule.ts";
import { allWatches, type Watch } from "./watch.ts";
import { describeOutput, failKindKo } from "./watchtext.ts";
import { watchLabel } from "./workchannels.ts";

// The read-only monitor list for the web (GET /api/monitors): every watch and schedule with the words the owner reads.
export type Monitor = {
	name: string;
	// A watch's own [a-z0-9-] name when `name` is its label: the web matches the watch's notices by it and shows it as small text.
	watch?: string;
	kind: "watch" | "schedule";
	channel?: string;
	last_run?: string;
	last_result?: "ok" | "changed" | "fail";
	next_run?: string;
	every?: string;
	// A watch's health in words (the web's status header and the monitor note of a conversation turn): fails in a row, the last good run,
	// the last output as a person reads it, and whether it keeps a login (it has a session).
	fails?: number;
	last_ok?: string;
	last_output?: string;
	keeper?: boolean;
};

const everyKo = (m: number): string => (m % 1440 === 0 ? `${m / 1440}일마다` : m % 60 === 0 ? `${m / 60}시간마다` : `${m}분마다`);
const iso = (ms: number) => new Date(ms).toISOString();

export function watchFacts(w: Watch): Pick<Monitor, "fails" | "last_ok" | "last_output" | "keeper"> {
	const said = describeOutput(w.state.last ?? "", { issue: w.state.fails > 0 }).text.replace(/\s+/g, " ").trim();
	const output = (w.state.fails > 0 && !said && w.state.kind ? failKindKo(w.state.kind) : said).slice(0, 200);
	return { fails: w.state.fails, ...(w.state.lastOk ? { last_ok: w.state.lastOk } : {}), ...(output ? { last_output: output } : {}), ...(w.session ? { keeper: true } : {}) };
}

export function listMonitors(): Monitor[] {
	const watches: Monitor[] = allWatches().map(w => {
		const last = w.state.lastRun;
		const result = !last ? undefined : w.state.fails > 0 ? "fail" : w.state.lastChanged ? "changed" : "ok";
		const next = w.paused || w.state.paused ? undefined : w.state.nextAt ?? Date.parse(last ?? w.created) + w.every_minutes * 60_000;
		return {
			name: watchLabel(w.name),
			watch: w.name,
			kind: "watch",
			// watch channels are bare Discord ids; the web opens conversations by ch:<id>
			...(w.channels?.[0] ? { channel: /^\d+$/.test(w.channels[0]) ? `ch:${w.channels[0]}` : w.channels[0] } : {}),
			...(last ? { last_run: last } : {}),
			...(result ? { last_result: result } : {}),
			...(next && Number.isFinite(next) ? { next_run: iso(next) } : {}),
			every: everyKo(w.every_minutes),
			...watchFacts(w),
		};
	});
	const schedules: Monitor[] = listSchedules().map(s => {
		// A schedule's text starts with its internal target (ch:<id>, lane:<name>); the owner reads the words.
		const channel = /^\s*(ch:\d+)/.exec(s.text)?.[1];
		const name = s.text.replace(/^\s*(?:(?:ch|lane|th):\S+\s*)+/, "").trim().slice(0, 200) || "예약";
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
