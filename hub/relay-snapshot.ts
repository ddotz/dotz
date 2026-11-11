import { scrub } from "./activity.ts";

// A computer reached only through a messenger room (hub/jandi-peers.ts) cannot be asked for its screens, so it posts a short summary of itself into the
// same room as one of its replies: `<reply_prefix> #dotz-status.v1 <json>`. The computer that reads the room keeps the last one per computer and shows
// it read-only (GET /api/relay/<adapter>/<key>/status, web/js/42-relay-chat.js); the line never shows as a chat message or raises a notification.
// This file is the format both ends share: what goes in, how it is cleaned and cut to size, and how it is read back.

export const SNAPSHOT_MARK = "#dotz-status.v1";
/** The whole message stays under this (the relay's own text limit is 4000). */
export const MAX_SNAPSHOT_CHARS = 3500;

export type SnapProject = { key: string; name: string; note?: string; live?: number };
export type SnapSession = { name: string; title?: string; status: string; live: boolean; waiting?: boolean; at?: string };
export type SnapMonitor = { name: string; kind: "watch" | "schedule"; result?: "ok" | "changed" | "fail"; paused?: boolean; conn?: "connected" | "disconnected"; last?: string; next?: string; summary?: string };
export type SnapNotice = { at: string; tone: string; title: string };
export type Snapshot = {
	v: 1;
	/** When the sending computer made it (ms). */
	at: number;
	projects: SnapProject[];
	sessions: SnapSession[];
	monitors: SnapMonitor[];
	todos: { open: number; items: string[] };
	notices: SnapNotice[];
	/** Something was left out to stay under MAX_SNAPSHOT_CHARS. */
	cut?: true;
};

const LIMITS = { projects: 20, sessions: 15, monitors: 20, todos: 5, notices: 5 } as const;
const TEXT_MAX = 120;

// Personal paths (a home folder, a Windows user folder) and e-mail addresses never leave the computer; tokens and known secret values go through scrub.
const PATH_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^\s"'`)]*/g;
const MAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** One shown string, cleaned: secrets masked, personal paths and mail addresses replaced, one line, at most `max` characters. */
export function cleanText(s: unknown, max = TEXT_MAX): string {
	if (typeof s !== "string") return "";
	const out = scrub(s).replace(PATH_RE, "…").replace(MAIL_RE, "…").replace(/\s+/g, " ").trim();
	return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const str = (v: unknown, max = TEXT_MAX) => cleanText(v, max) || undefined;
const opt = <K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } => (v === undefined || v === "" ? {} : ({ [k]: v } as { [P in K]?: V }));
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list.includes(v as T) ? (v as T) : undefined);

/** Any input shaped like a snapshot, made safe: unknown fields dropped, every string cleaned, lists cut to their limits. */
export function normalizeSnapshot(raw: unknown): Snapshot | undefined {
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o !== "object" || o.v !== 1 || typeof o.at !== "number" || !Number.isFinite(o.at)) return undefined;
	const t = (o.todos ?? {}) as Record<string, unknown>;
	const snap: Snapshot = {
		v: 1,
		at: o.at,
		projects: arr(o.projects)
			.map(p => ({ key: str(p.key, 200) ?? "", name: str(p.name, 80) ?? "", ...opt("note", str(p.note)), ...opt("live", typeof p.live === "number" && p.live > 0 ? Math.floor(p.live) : undefined) }))
			.filter(p => p.key && p.name)
			.slice(0, LIMITS.projects),
		sessions: arr(o.sessions)
			.map(s => ({ name: str(s.name, 60) ?? "", ...opt("title", str(s.title, 80)), status: str(s.status, 30) ?? "", live: s.live === true, ...opt("waiting", s.waiting === true ? true : undefined), ...opt("at", str(s.at, 40)) }))
			.filter(s => s.name)
			.slice(0, LIMITS.sessions),
		monitors: arr(o.monitors)
			.map(m => ({
				name: str(m.name, 80) ?? "",
				kind: oneOf(m.kind, ["watch", "schedule"] as const) ?? "watch",
				...opt("result", oneOf(m.result, ["ok", "changed", "fail"] as const)),
				...opt("paused", m.paused === true ? true : undefined),
				...opt("conn", oneOf(m.conn, ["connected", "disconnected"] as const)),
				...opt("last", str(m.last, 40)),
				...opt("next", str(m.next, 40)),
				...opt("summary", str(m.summary)),
			}))
			.filter(m => m.name)
			.slice(0, LIMITS.monitors),
		todos: { open: typeof t.open === "number" && t.open > 0 ? Math.floor(t.open) : 0, items: (Array.isArray(t.items) ? t.items : []).map(x => cleanText(x)).filter(Boolean).slice(0, LIMITS.todos) },
		notices: arr(o.notices)
			.map(n => ({ at: str(n.at, 40) ?? "", tone: str(n.tone, 20) ?? "", title: str(n.title) ?? "" }))
			.filter(n => n.title)
			.slice(0, LIMITS.notices),
	};
	if (o.cut === true) snap.cut = true;
	return snap;
}

const bodyOf = (prefix: string, s: Snapshot) => `${prefix ? `${prefix} ` : ""}${SNAPSHOT_MARK} ${JSON.stringify(s)}`;

/** The message to post: cleaned, then cut (the longest lists lose their last items first) until it fits MAX_SNAPSHOT_CHARS. Undefined for a non-snapshot. */
export function encodeSnapshot(prefix: string, raw: unknown): string | undefined {
	const s = normalizeSnapshot(raw);
	if (!s) return undefined;
	let out = bodyOf(prefix, s);
	while (out.length > MAX_SNAPSHOT_CHARS) {
		const lists = [s.monitors, s.sessions, s.projects, s.notices, s.todos.items] as unknown[][];
		const longest = lists.reduce((a, b) => (b.length > a.length ? b : a));
		if (!longest.length) return undefined;
		longest.pop();
		s.cut = true;
		out = bodyOf(prefix, s);
	}
	return out;
}

/** A reply's text (after the reply prefix) is a snapshot line: it is never shown as a message. */
export const isSnapshotText = (text: string): boolean => text.trimStart().startsWith(SNAPSHOT_MARK);

/** The snapshot in a reply's text (after the reply prefix), checked and cleaned again; undefined when it is not one or does not parse. */
export function decodeSnapshot(text: string): Snapshot | undefined {
	const t = text.trimStart();
	if (!t.startsWith(SNAPSHOT_MARK)) return undefined;
	try {
		return normalizeSnapshot(JSON.parse(t.slice(SNAPSHOT_MARK.length)));
	} catch {
		return undefined;
	}
}

// What a reader would call a change: the times a watch ran or runs next, its last output line and a session's last report move on every run, so they
// do not count (a fresh copy of them still goes out with the next real change or the heartbeat). Every post is a message in the owner's room.
const stable = (s: Snapshot) =>
	JSON.stringify({
		projects: s.projects,
		sessions: s.sessions.map(({ at: _at, ...rest }) => rest),
		monitors: s.monitors.map(({ last: _l, next: _n, summary: _s, ...rest }) => rest),
		todos: s.todos,
		notices: s.notices,
	});
/** Whether `b` differs from `a` in what a reader would notice: the sender posts only when this is true (or the heartbeat is due). */
export const snapshotChanged = (a: Snapshot | undefined, b: Snapshot): boolean => !a || stable(a) !== stable(b);
