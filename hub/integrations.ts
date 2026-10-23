// Integrations that contact the owner first and ask for approval (webmail, KakaoTalk, Instagram, YouTube ...). Each one is a sub-item
// of 모니터링 in the chat list (web/js/30-integrations.js). A feature adds its entry to INTEGRATIONS below: that is data only, the web
// code draws whatever this file lists.
//
//   key        stable id, [a-z0-9-]
//   label      the Korean name in the list
//   kind       "app": an interactive (app-type) source the owner talks to; 모니터링 lists these as the 앱 group, between 감시 소식 and the plain monitors
//   icon       an icon name of web/js/01-core.js ICONS; `iconPath` (24x24 stroke path) registers it when the web has none yet
//   on         shown only when one of these holds on this install: a feature folder that is enabled (feature.md `enabled`), a data file
//              that exists ("dir/file.json", or "dir/file.json#key" = the file has that key), or a named runtime flag set by the caller.
//              An entry with a `match.conv` prefix is also on when this install has a conversation or a notice under that prefix.
//   match      which notices belong to it: a conversation prefix on where the notice lives (`conv`, e.g. "mail:"), the label of an
//              approval draft (`draft`, the "> 대화방:" line of hub/draft-approval.ts), or a case-insensitive pattern on title + text
//   watches    gateway watches this app owns (a name, or a prefix ending in "-"): paused while the app is off, deleted by 제거
//   data       what 제거 deletes only when the owner also picks "데이터 지우기": "dir" (a folder) or "dir/file.json#key" (one key of a file)
// This install can switch any entry off (custom/apps.json, hub/app-off.ts): off wins over every `on` rule, the conversation prefix included.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadFeatureDirs } from "./featuredirs.ts";

export type IntegrationEntry = {
	key: string;
	label: string;
	kind: "app";
	icon: string;
	iconPath?: string;
	on: { features?: string[]; files?: string[]; flags?: string[] };
	match: { conv?: string[]; draft?: string[]; text?: string[] };
	watches?: string[];
	data?: string[];
};

export const INTEGRATIONS: IntegrationEntry[] = [
	{
		key: "mail", label: "메일", kind: "app", icon: "mail",
		iconPath: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3.5 7.5l8.5 6 8.5-6",
		on: { features: ["webmail-no-api"], flags: ["zele"] },
		match: { conv: ["mail:"], draft: ["받는이"], text: ["메일"] },
		watches: ["webmail-"], data: ["custom/webmail"],
	},
	{
		key: "kakao", label: "카카오톡", kind: "app", icon: "kakao",
		iconPath: "M12 4c4.7 0 8.5 2.9 8.5 6.5S16.7 17 12 17c-.8 0-1.6-.1-2.3-.3L5.5 19.5l1-3.6C4.7 14.6 3.5 12.7 3.5 10.5 3.5 6.9 7.3 4 12 4z",
		on: { features: ["kakao"] },
		match: { draft: ["대화방"], text: ["카카오톡", "카톡", "kakao"] },
		watches: ["kakao-new"], data: ["custom/kakao"],
	},
	{
		key: "instagram", label: "인스타그램", kind: "app", icon: "instagram",
		iconPath: "M7 3.5h10A3.5 3.5 0 0 1 20.5 7v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M17 7h.01",
		on: { files: ["custom/sns/config.json#instagram"] },
		match: { text: ["인스타", "instagram"] },
		watches: ["sns-ig-"], data: ["custom/sns/config.json#instagram"],
	},
	{
		key: "youtube", label: "유튜브", kind: "app", icon: "youtube",
		iconPath: "M4 6.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM10 9.5v5l4.5-2.5z",
		on: { files: ["custom/sns/config.json#youtube"] },
		match: { text: ["유튜브", "youtube"] },
		watches: ["sns-yt-"], data: ["custom/sns/config.json#youtube"],
	},
	{
		key: "site", label: "웹사이트 댓글", kind: "app", icon: "comment",
		iconPath: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 9.5h8M8 12.5h5",
		on: { flags: ["comments-site"] },
		match: { text: ["웹사이트 댓글"] },
	},
];

export type IntegrationContext = { features: ReadonlySet<string>; files: (spec: string) => boolean; flags: ReadonlySet<string>; off: ReadonlySet<string> };
type NoticeLike = { id: string; title?: string; text?: string; open?: string; src?: string; read?: boolean; dismissed?: boolean; ignored?: string; decision?: { to?: string; state?: string; draft?: unknown } };
// What waits on the owner in one app, counted here so the web scans nothing: `drafts` = reply drafts that wait for his 보내기 (open send-approval
// [ask]s), `unread` = unread notices and conversation messages (the draft asks are not counted twice), `sentToday` = replies sent by themselves today.
export type IntegrationNeeds = { drafts: number; unread: number; sentToday: number };
export type IntegrationItem = Pick<IntegrationEntry, "key" | "label" | "kind" | "icon" | "iconPath"> & { conv: string[]; unread: number; notices: string[]; needs: IntegrationNeeds };
// A mail's suggested reply state (hub/mail.ts MailSuggest) with the time the state was set (or the mail's own time): the "sent today" count reads these.
export type SuggestLike = { target: string; state?: string; at?: string };

export const APPS_FILE = "custom/apps.json";
// The apps this install switched off: custom/apps.json {"mail":{"off":true}}. A missing or unreadable file = none off.
// Cached by the file's mtime and size: the notice lists ask on every call.
const offCache = new Map<string, { sig: string; off: Set<string> }>();
export function readAppOff(dataDir: string): Set<string> {
	const file = join(dataDir, APPS_FILE);
	try {
		const st = statSync(file), sig = `${st.mtimeMs}:${st.size}`, hit = offCache.get(file);
		if (hit?.sig === sig) return hit.off;
		const v = JSON.parse(readFileSync(file, "utf8"));
		const off = new Set(Object.entries(v ?? {}).filter(([, s]) => (s as { off?: unknown } | null)?.off === true).map(([k]) => k));
		offCache.set(file, { sig, off });
		return off;
	} catch {
		return new Set();
	}
}

// What is on at this install, read from disk: enabled feature folders (a personal copy of a shipped folder wins), data files, and the flags the caller knows.
export function integrationContext(dataDir: string, flags: Iterable<string> = []): IntegrationContext {
	const features = new Set(loadFeatureDirs(dataDir).features.filter(f => f.enabled).map(f => f.id));
	const files = (spec: string): boolean => {
		const [rel, key] = spec.split("#");
		const file = join(dataDir, rel!);
		if (!existsSync(file)) return false;
		if (!key) return true;
		try {
			const v = JSON.parse(readFileSync(file, "utf8"));
			return v != null && typeof v === "object" && v[key] != null;
		} catch {
			return false;
		}
	};
	return { features, files, flags: new Set(flags), off: readAppOff(dataDir) };
}

export const integrationOn = (e: IntegrationEntry, ctx: IntegrationContext): boolean =>
	!ctx.off.has(e.key) && !!(e.on.features?.some(f => ctx.features.has(f)) || e.on.files?.some(f => ctx.files(f)) || e.on.flags?.some(f => ctx.flags.has(f)));

export const whereOf = (n: NoticeLike): string[] => [n.src, n.open, n.decision?.to].filter((s): s is string => typeof s === "string");

// Conversations or notices already live under the entry's `conv` prefixes: this install receives through it, whatever its switches say.
const hasConvs = (e: IntegrationEntry, notices: readonly NoticeLike[], convUnread: Readonly<Record<string, number>>): boolean =>
	(e.match.conv ?? []).some(p => Object.keys(convUnread).some(t => t.startsWith(p)) || notices.some(n => whereOf(n).some(w => w.startsWith(p))));

const SESSION_SRC = /^(?:lane:|ch:|worklog$|main$)/;

export function belongsTo(e: IntegrationEntry, n: NoticeLike): boolean {
	const { conv = [], draft = [], text = [] } = e.match;
	const where = whereOf(n);
	if (conv.some(p => where.some(w => w.startsWith(p)))) return true;
	const body = n.text ?? "";
	if (n.decision && draft.some(l => body.includes(`> ${l}:`))) return true;
	// A work session's or channel's own report ("카톡 보내기를 고쳤어요") talks about the app; it is not a notice of the app.
	if (SESSION_SRC.test(n.src ?? "")) return false;
	const hay = `${n.title ?? ""}\n${body}`.toLowerCase();
	return text.some(t => hay.includes(t.toLowerCase()));
}

// The key of the app (an entry on at this install, or one whose conversation the notice lives in) the notice belongs to; none = the owner's own monitor.
export function appKeyOf(n: NoticeLike, ctx: IntegrationContext, entries: readonly IntegrationEntry[] = INTEGRATIONS): string | undefined {
	const where = whereOf(n);
	return entries.find(e => belongsTo(e, n) && (integrationOn(e, ctx) || ctx.off.has(e.key) || (e.match.conv ?? []).some(p => where.some(w => w.startsWith(p)))))?.key;
}

// The enabled entries with their notices (newest first as given, at most `cap`) and the unread count: unread notices plus the unread messages
// of the conversations under the entry's `conv` prefixes (`convUnread`: target -> unread messages). `suggests` = the mails' reply states, `now` = the clock.
export function integrationItems(ctx: IntegrationContext, notices: readonly NoticeLike[], convUnread: Readonly<Record<string, number>> = {}, cap = 100, entries: readonly IntegrationEntry[] = INTEGRATIONS, suggests: readonly SuggestLike[] = [], now = Date.now(), comments: Readonly<Record<string, { drafts: number; unread: number }>> = {}): IntegrationItem[] {
	const today = new Date(now).toDateString();
	return entries.filter(e => !ctx.off.has(e.key) && (integrationOn(e, ctx) || hasConvs(e, notices, convUnread))).map(e => {
		const mine = notices.filter(n => !n.dismissed && belongsTo(e, n));
		const convs = e.match.conv ?? [];
		const fromConvs = Object.entries(convUnread).reduce((c, [t, n]) => c + (convs.some(p => t.startsWith(p)) ? n : 0), 0);
		const waits = (n: NoticeLike) => n.decision?.state === "open" && !!n.decision.draft && !n.ignored;
		const sentToday = suggests.filter(s => s.state === "sent" && convs.some(p => s.target.startsWith(p)) && s.at && new Date(s.at).toDateString() === today).length;
		const cm = comments[e.key] ?? { drafts: 0, unread: 0 };
		const needs = { drafts: mine.filter(waits).length + cm.drafts, unread: mine.filter(n => !n.read && !waits(n)).length + fromConvs + cm.unread, sentToday };
		return { key: e.key, label: e.label, kind: e.kind, icon: e.icon, ...(e.iconPath ? { iconPath: e.iconPath } : {}), conv: convs, unread: mine.filter(n => !n.read).length + fromConvs + cm.unread, notices: mine.slice(0, cap).map(n => n.id), needs };
	});
}

// The apps the 앱 추가 sheet lists: only those the owner switched off or removed here (`off`). An entry never set up on this install is not listed;
// the owner asks for it and 새로 추가하기 builds it (hub/app-templates.ts). `conv` lets the web tell a mail this install still holds (data is kept
// while off) from one that only a peer shows.
export type AvailableApp = Pick<IntegrationEntry, "key" | "label" | "icon" | "iconPath"> & { off: boolean; conv: string[] };
export const integrationAvailable = (shown: readonly { key: string }[], ctx: IntegrationContext, entries: readonly IntegrationEntry[] = INTEGRATIONS): AvailableApp[] =>
	entries.filter(e => ctx.off.has(e.key) && !shown.some(i => i.key === e.key)).map(e => ({ key: e.key, label: e.label, icon: e.icon, ...(e.iconPath ? { iconPath: e.iconPath } : {}), off: ctx.off.has(e.key), conv: e.match.conv ?? [] }));
