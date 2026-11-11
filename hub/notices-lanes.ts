// Session and channel names for a notice title (live map, lane record, launch event). A part of the notice store split out of hub/notices.ts, code unchanged.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";
import type { HubEvent } from "./events.ts";
import type { Notice } from "./notices-types.ts";
import { convNameOf, laneTitleOf, watchLabelOf } from "./notices-wiring.ts";

// The title a lane was launched with, from its lane_start event (live or replayed): the fallback once lane.json is gone.
export const launchTitles = new Map<string, string>();
// A stopped lane is no longer in the live map: its title lives in the lane record the hub keeps (lanes/<name>/lane.json) and
// in the title its lane_start event carries.
function laneRecord(name: string): Record<string, unknown> | undefined {
	if (!/^[\w.-]+$/.test(name)) return undefined;
	try {
		return JSON.parse(readFileSync(join(paths.lanes, name, "lane.json"), "utf8")) ?? undefined;
	} catch {
		return undefined;   // no record (or an unreadable one): the caller falls back
	}
}
export function recordedTitle(name: string): string | undefined {
	const title = laneRecord(name)?.title;
	if (typeof title === "string" && title.trim()) return title.trim();
	return launchTitles.get(name);
}
// The folder a session works in, from its record: where the commits of its report live.
export function recordedCwd(name: string): string | undefined {
	const cwd = laneRecord(name)?.cwd;
	return typeof cwd === "string" && cwd ? cwd : undefined;
}
export const noteLaunch = (e: HubEvent) => {
	if (typeof e.lane === "string" && typeof e.title === "string" && e.title.trim()) launchTitles.set(e.lane, e.title.trim());
};
export const laneTitle = (name: string) => laneTitleOf(name)?.trim() || recordedTitle(name) || "세션";
export const laneNameKo = laneTitle;

// The name of a conversation for a notice title; never a raw id: a project, then the session that owns the channel, then a plain label.
export function channelTitle(conv: string): string {
	if (conv.startsWith("settings:w:")) return watchLabelOf(conv.slice(11));
	const named = convNameOf(conv)?.trim();
	if (named) return named;
	const lane = conv.startsWith("ch:") ? channelLanes().get(conv) : undefined;
	if (lane) return laneTitle(lane);
	return conv.startsWith("ch:") ? "채널" : conv.startsWith("settings:") ? "설정" : "대화";
}
// The same name for a push: a settings conversation is titled with its monitor's or app's label.
export const conversationTitle = channelTitle;

/* ---------- stale notices: the session is gone, or the owner already read the message ---------- */
// The session a notice belongs to: its key, the conversation it points at, or the session its question goes to.
export function laneOfNotice(i: Notice, byChannel?: Map<string, string>): string | undefined {
	for (const c of [i.key, i.src, i.open, i.decision?.to]) {
		const m = /^lane:([\w.-]+)$/.exec(c ?? "");
		if (m) return m[1];
	}
	// A session's own channel belongs to that session (a notice of its channel goes with it).
	const ch = [i.src, i.open].find(c => c && /^ch:\d+$/.test(c));
	return ch ? byChannel?.get(ch) : undefined;
}

// What the gateway still has, read from its channel map (channels.json): every id a conversation can be, and the session each own channel
// belongs to. null when there is no map (no Discord): then no channel counts as gone.
type ChannelMap = { known: Set<string>; lanes: Map<string, string> };
export function readChannelMap(): ChannelMap | null {
	try {
		const c = JSON.parse(readFileSync(paths.channels, "utf8"));
		if (!c?.chat) return null;
		const lanes = new Map<string, string>(Object.entries<string>(c.lanes ?? {}).map(([lane, id]) => [`ch:${id}`, lane]));
		const fixed = [c.chat, c.worklog, c.alert, c.brief, c.dm, c.category, c.workCategory, ...Object.values<string>(c.homes ?? {})];
		const ids = [...fixed, ...Object.keys(c.work ?? {}), ...(c.local ?? []), ...Object.keys(c.threads ?? {}), ...lanes.keys()].filter(Boolean).map(String);
		return { known: new Set(ids.map(id => id.replace(/^ch:/, ""))), lanes };
	} catch {
		return null;
	}
}
export const channelLanes = () => readChannelMap()?.lanes ?? new Map<string, string>();
export const laneExists = (name: string) => existsSync(join(paths.lanes, name, "lane.json"));
// A session stopped for good: saved as exited, no question waiting on the owner, nothing queued. Returns when it was last active, else undefined.
export function stoppedSince(name: string): number | undefined {
	try {
		const r = JSON.parse(readFileSync(join(paths.lanes, name, "lane.json"), "utf8"));
		const at = Date.parse(r?.lastReportAt ?? r?.startedAt);
		return r?.status === "exited" && !r.pendingAsk && !r.waiting && !Number.isNaN(at) ? at : undefined;
	} catch {
		return undefined;
	}
}

// On load: notices of sessions that no longer exist (deleted, or removed while the hub was down) are retired when they still count (unread or open);
// read ones stay as history. So are the message and result notices of a session that stopped before the stop hook (dropChannelNotices) existed:
// saved as exited, and not active since the notice. And a notice whose message the read position already covers is read.
// After an update the stored wording of what still waits on the owner may be older than the code: an open question, and an unread result or
// alert, is drawn again from its source event (outbox / inbox) by the current rules, in place: id, read and answer state stay. Watch reports
// (their text may hold a model summary), message previews and login requests stay as stored, and so does an item whose event is gone.
// A generic title (the resolvers are not wired yet at load) never replaces a stored one. Returns how many items changed.
export const GENERIC_TITLES = new Set(["세션", "채널", "대화", "설정"]);
