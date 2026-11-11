import { DATA_DIR } from "./config.ts";
import { appEntries } from "./integrations.ts";
import { loadProjects } from "./projects.ts";
import { listSchedules } from "./schedule.ts";
import { allWatches, type Watch } from "./watch.ts";
import { watchConnection } from "./watch-status.ts";
import { describeOutput, failKindKo, scheduleLabel } from "./watchtext.ts";
import { projectTitle, type ScopeContext, watchScope } from "./watch-scope.ts";
import { getSetup, watchLabel } from "./workchannels.ts";

// The read-only monitor list for the web (GET /api/monitors): every watch and schedule with the words the owner reads.
export type Monitor = {
	name: string;
	// A watch's own [a-z0-9-] name when `name` is its label: the web matches the watch's notices by it and shows it as small text.
	watch?: string;
	// A schedule's id: its ⋯ settings screen reads and edits it through /api/schedules/<id>/settings and deletes it with DELETE /api/schedules/<id>.
	schedule?: string;
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
	// The watch's connection, apart from whether an alert went out (hub/watch-status.ts): a disconnected one carries the outage start and why.
	connection?: "connected" | "disconnected";
	since?: string;
	conn_reason?: "login" | "check";
	// Nothing is scheduled while the owner paused it or it stopped itself; the web shows it grey as 꺼짐.
	paused?: boolean;
	// One short line of the last run's own output, for a row's status line (last_output is the fuller text the detail card shows).
	last_summary?: string;
	// Where the monitor is listed (hub/watch-scope.ts): under the app (`app`, an instance key), under its project (`project` = ch:<id> or a folder, `project_title` the name
	// the owner reads), as the gateway's own housekeeping, or "plain" = 일반 모니터링. A hub without the field lists every monitor as plain.
	scope?: "app" | "project" | "internal" | "plain";
	app?: string;
	project?: string;
	project_title?: string;
};

const everyKo = (m: number): string => (m % 1440 === 0 ? `${m / 1440}일마다` : m % 60 === 0 ? `${m / 60}시간마다` : `${m}분마다`);
const iso = (ms: number) => new Date(ms).toISOString();

export function watchFacts(w: Watch): Pick<Monitor, "fails" | "last_ok" | "last_output" | "keeper"> {
	const d = describeOutput(w.state.last ?? "", { issue: w.state.fails > 0 }), said = (d.title || d.text).replace(/\s+/g, " ").trim();
	const output = (w.state.fails > 0 && !said && w.state.kind ? failKindKo(w.state.kind) : said).slice(0, 200);
	return { fails: w.state.fails, ...(w.state.lastOk ? { last_ok: w.state.lastOk } : {}), ...(output ? { last_output: output } : {}), ...(w.session ? { keeper: true } : {}) };
}

export function listMonitors(): Monitor[] {
	const ctx: ScopeContext = { entries: appEntries(DATA_DIR), dataDir: DATA_DIR, projects: loadProjects(), setupName: c => getSetup(c)?.name };
	const watches: Monitor[] = allWatches().map(w => {
		const last = w.state.lastRun;
		const result = !last ? undefined : w.state.fails > 0 ? "fail" : w.state.lastChanged ? "changed" : "ok";
		const paused = !!(w.paused || w.state.paused);
		const next = paused ? undefined : w.state.nextAt ?? Date.parse(last ?? w.created) + w.every_minutes * 60_000;
		const sc = watchScope(w, ctx), facts = watchFacts(w), conn = watchConnection(w), line = (facts.last_output ?? "").split("\n")[0]!.trim();
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
			connection: conn.state,
			...(conn.state === "disconnected" ? { ...(conn.since ? { since: conn.since } : {}), conn_reason: conn.reason } : {}),
			...(paused ? { paused: true } : {}),
			...(line ? { last_summary: line.slice(0, 120) } : {}),
			...(sc.scope === "app" ? { scope: "app" as const, app: sc.app } : sc.scope === "project" ? { scope: "project" as const, project: sc.project, project_title: sc.title } : { scope: sc.scope }),
			...facts,
		};
	});
	const schedules: Monitor[] = listSchedules().map(s => {
		// A schedule's text is the whole instruction it runs, after its internal target (ch:<id>, lane:<name>); the owner reads its short name.
		const channel = /^\s*(ch:\d+)/.exec(s.text)?.[1];
		const name = scheduleLabel(s.text) || "예약";
		return {
			name,
			schedule: s.id,
			kind: "schedule",
			...(channel ? { channel, scope: "project" as const, project: channel, project_title: projectTitle(channel, ctx) } : { scope: "plain" as const }),
			...(s.last ? { last_run: s.last, last_result: "ok" as const } : {}),
			...(s.paused ? { paused: true } : { next_run: s.at }),
			...(s.every_minutes ? { every: everyKo(s.every_minutes) } : {}),
		};
	});
	return [...watches, ...schedules];
}
