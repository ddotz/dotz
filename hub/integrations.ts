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
// An entry is the DEFAULT instance of its app (id = key). The owner can add more instances of one app (two mail accounts) and rename each:
// custom/apps.json {"mail":{"label":"회사"},"mail-2":{"app":"mail","label":"개인","filter":{"conv":["mail:naver-"],"watches":["webmail-naver"]}}}.
// An instance id is `<app key>` or `<app key>-<slug>` (so an app key has no hyphen). `filter` says what is the instance's: conversation prefixes,
// watch names/prefixes, text patterns and stored data. The default instance owns what no sibling's filter claims (appEntries below).
// Website comments (hub/comments, docs/comments-api.md): with two or more `website` sources in custom/comments/config.json, every source is an
// app of its own (`site-<slug of the source key>`, label = the source's label, `sources` = [its key], `watches` = the source's own `watches`),
// replacing the one "site" entry; with one source the "site" entry stays as it is. apps.json can rename, switch off or delete each by its id.
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
	/** Instance fields (appEntries): the registry key, an added instance, a deleted default, and what sibling instances claim from this one. */
	app?: string;
	created?: boolean;
	gone?: boolean;
	not?: { conv: string[]; watches: string[] };
	/** The comment sources (hub/comments config keys) this entry shows; none = every source of its app. */
	sources?: string[];
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

export type IntegrationContext = { features: ReadonlySet<string>; files: (spec: string) => boolean; flags: ReadonlySet<string>; off: ReadonlySet<string>; entries?: readonly IntegrationEntry[] };
type NoticeLike = { id: string; title?: string; text?: string; open?: string; src?: string; read?: boolean; dismissed?: boolean; ignored?: string; decision?: { to?: string; state?: string; draft?: unknown } };
// What waits on the owner in one app, counted here so the web scans nothing: `drafts` = reply drafts that wait for his 보내기 (open send-approval
// [ask]s), `unread` = unread notices and conversation messages (the draft asks are not counted twice), `sentToday` = replies sent by themselves today.
export type IntegrationNeeds = { drafts: number; unread: number; sentToday: number };
export type IntegrationItem = Pick<IntegrationEntry, "key" | "label" | "kind" | "icon" | "iconPath" | "sources"> & { app: string; conv: string[]; convNot?: string[]; unread: number; notices: string[]; needs: IntegrationNeeds };
// A mail's suggested reply state (hub/mail.ts MailSuggest) with the time the state was set (or the mail's own time): the "sent today" count reads these.
export type SuggestLike = { target: string; state?: string; at?: string };

export const APPS_FILE = "custom/apps.json";
// What custom/apps.json holds per instance id: {"mail":{"off":true}} (the old shape: one default instance per app, read as it is), a label the owner
// set, an added instance's `app` and `filter`, and `deleted` on a default instance that was deleted (it stays off). A missing or unreadable file = {}.
// `source` = a mail item's source key (POST /api/mail source): the instance owns `mail:<source>-…`, the same as the conv prefix `mail:<source>-`.
export type AppFilter = { source?: string; conv?: string[]; watches?: string[]; text?: string[]; data?: string[] };
// `watches` at the instance level = extra watch names (or prefixes ending in "-") that are this instance's own, beside the registry's (a custom plugin's login keeper).
export type AppRaw = { app?: string; label?: string; off?: boolean; deleted?: boolean; filter?: AppFilter; watches?: string[] };
// Cached by the file's mtime and size: the notice lists ask on every call.
const offCache = new Map<string, { sig: string; raw: Record<string, AppRaw>; off: Set<string> }>();
function readApps(dataDir: string): { raw: Record<string, AppRaw>; off: Set<string> } {
	const file = join(dataDir, APPS_FILE);
	try {
		const st = statSync(file), sig = `${st.mtimeMs}:${st.size}`, hit = offCache.get(file);
		if (hit?.sig === sig) return hit;
		const v = JSON.parse(readFileSync(file, "utf8"));
		const raw: Record<string, AppRaw> = v && typeof v === "object" && !Array.isArray(v) ? v : {};
		const off = new Set(Object.entries(raw).filter(([, s]) => s?.off === true).map(([k]) => k));
		const next = { sig, raw, off };
		offCache.set(file, next);
		return next;
	} catch {
		return { raw: {}, off: new Set() };
	}
}
/** The instances this install switched off (ids): custom/apps.json {"mail":{"off":true}}. */
export const readAppOff = (dataDir: string): Set<string> => readApps(dataDir).off;
export const readAppsFile = (dataDir: string): Record<string, AppRaw> => readApps(dataDir).raw;

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);
// The same cleaning hub/mail.ts mailKey applies to a source, so the prefix matches the keys the mails get.
export const srcKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100);
const convPrefixes = (reg: IntegrationEntry, f?: AppFilter): string[] => {
	const src = typeof f?.source === "string" ? srcKey(f.source) : "", base = reg.match.conv?.[0];
	return [...strs(f?.conv), ...(src && base ? [`${base}${src}-`] : [])];
};
export const appLabel = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 30) : undefined);
export const instanceIdOf = (app: string, id: string): boolean => id === app || (id.startsWith(`${app}-`) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id));
/** The app key an instance id belongs to (ids are `<app>` or `<app>-<slug>`). */
export const appBase = (id: string): string => id.split("-")[0]!;

// The website comment sources of this install (custom/comments/config.json, only while comments are enabled), cached like apps.json.
export type SiteSource = { key: string; label: string; watches: string[] };
const SITE_FILE = "custom/comments/config.json";
const siteCache = new Map<string, { sig: string; list: SiteSource[] }>();
export function siteSources(dataDir: string): SiteSource[] {
	const file = join(dataDir, SITE_FILE);
	try {
		const st = statSync(file), sig = `${st.mtimeMs}:${st.size}`, hit = siteCache.get(file);
		if (hit?.sig === sig) return hit.list;
		const v = JSON.parse(readFileSync(file, "utf8"));
		const all: [string, Record<string, unknown>][] = v?.enabled === true && v.sources && typeof v.sources === "object" ? Object.entries(v.sources) : [];
		const list = all.filter(([, s]) => s && typeof s === "object" && s.kind === "website").map(([k, s]) => {
			const key = typeof s.key === "string" && s.key ? s.key : k;
			return { key, label: appLabel(s.label) ?? key, watches: strs(s.watches) };
		});
		siteCache.set(file, { sig, list });
		return list;
	} catch {
		return [];
	}
}
// One instance id per source: `site-<slug>` (a key that already starts with "site-" keeps its slug), unique within the list.
export function siteIds(list: readonly SiteSource[]): string[] {
	const seen = new Set<string>();
	return list.map((s, i) => {
		const slug = s.key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^site-(?=.)/, "");
		let id = `site-${slug || i + 1}`;
		while (seen.has(id)) id = `${id}-${i + 1}`;
		seen.add(id);
		return id;
	});
}

/** Every instance as a registry-shaped entry, deleted defaults included (`gone`): a registry entry is the default instance of its app, then come the added
 *  ones (`created`, shown whenever they are on). A label replaces the registry's. An added instance matches only its own filter; the default keeps the registry
 *  rules minus what the added ones claim (`not`), unless it has a filter of its own. */
export function appEntries(dataDir: string): IntegrationEntry[] {
	const raw = readAppsFile(dataDir), out: IntegrationEntry[] = [];
	for (const reg of INTEGRATIONS) {
		const sites = reg.key === "site" ? siteSources(dataDir) : [], perSite = sites.length > 1 ? siteIds(sites) : [];
		const kids = Object.entries(raw).filter(([id, r]) => id !== reg.key && instanceIdOf(reg.key, id) && !perSite.includes(id) && r && typeof r === "object" && !r.deleted);
		const mine = raw[reg.key] && typeof raw[reg.key] === "object" ? raw[reg.key]! : {}, own = convPrefixes(reg, mine.filter);
		const theirs = (r: AppRaw) => [...strs(r.filter?.watches), ...strs(r.watches)];
		const extra = [...strs(mine.watches), ...(sites.length === 1 ? sites[0]!.watches : [])];
		if (perSite.length)
			sites.forEach((s, i) => {
				const id = perSite[i]!, r: AppRaw = raw[id] && typeof raw[id] === "object" ? raw[id]! : {}, w = [...s.watches, ...strs(r.watches)];
				out.push({ key: id, app: reg.key, label: appLabel(r.label) ?? s.label, kind: reg.kind, icon: reg.icon, ...(reg.iconPath ? { iconPath: reg.iconPath } : {}),
					on: reg.on, match: { text: [] }, sources: [s.key], ...(w.length ? { watches: w } : {}), ...(r.deleted ? { gone: true } : {}) });
			});
		else
			out.push({ ...reg, app: reg.key, label: appLabel(mine.label) ?? reg.label, ...(mine.deleted ? { gone: true } : {}),
				match: own.length ? { ...reg.match, conv: own } : reg.match,
				...(extra.length ? { watches: [...(reg.watches ?? []), ...extra] } : {}),
				not: { conv: own.length ? [] : kids.flatMap(([, r]) => convPrefixes(reg, r.filter)), watches: kids.flatMap(([, r]) => theirs(r)) } });
		for (const [id, r] of kids)
			out.push({ key: id, app: reg.key, created: true, label: appLabel(r.label) ?? reg.label, kind: reg.kind, icon: reg.icon, ...(reg.iconPath ? { iconPath: reg.iconPath } : {}),
				on: reg.on, match: { conv: convPrefixes(reg, r.filter), text: strs(r.filter?.text) }, watches: theirs(r), data: strs(r.filter?.data) });
	}
	return out;
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
	return { features, files, flags: new Set(flags), off: readAppOff(dataDir), entries: appEntries(dataDir).filter(e => !e.gone) };
}

export const integrationOn = (e: IntegrationEntry, ctx: IntegrationContext): boolean =>
	!ctx.off.has(e.key) && !!(e.created || e.on.features?.some(f => ctx.features.has(f)) || e.on.files?.some(f => ctx.files(f)) || e.on.flags?.some(f => ctx.flags.has(f)));

export const whereOf = (n: NoticeLike): string[] => [n.src, n.open, n.decision?.to].filter((s): s is string => typeof s === "string");

// Where the entry's `conv` prefixes reach, minus what a sibling instance claims.
export const inConv = (e: IntegrationEntry, where: string): boolean => (e.match.conv ?? []).some(p => where.startsWith(p)) && !(e.not?.conv ?? []).some(p => where.startsWith(p));

// Conversations or notices already live under the entry's `conv` prefixes: this install receives through it, whatever its switches say.
const hasConvs = (e: IntegrationEntry, notices: readonly NoticeLike[], convUnread: Readonly<Record<string, number>>): boolean =>
	Object.keys(convUnread).some(t => inConv(e, t)) || notices.some(n => whereOf(n).some(w => inConv(e, w)));

const SESSION_SRC = /^(?:lane:|ch:|worklog$|main$)/;

export function belongsTo(e: IntegrationEntry, n: NoticeLike): boolean {
	const { draft = [], text = [] } = e.match;
	const where = whereOf(n);
	if (where.some(w => inConv(e, w))) return true;
	if (where.some(w => (e.not?.conv ?? []).some(p => w.startsWith(p)))) return false;
	const body = n.text ?? "";
	if (n.decision && draft.some(l => body.includes(`> ${l}:`))) return true;
	// A work session's or channel's own report ("카톡 보내기를 고쳤어요") talks about the app; it is not a notice of the app.
	if (SESSION_SRC.test(n.src ?? "")) return false;
	const hay = `${n.title ?? ""}\n${body}`.toLowerCase();
	return text.some(t => hay.includes(t.toLowerCase()));
}

// The key of the app (an entry on at this install, or one whose conversation the notice lives in) the notice belongs to; none = the owner's own monitor.
export function appKeyOf(n: NoticeLike, ctx: IntegrationContext, entries: readonly IntegrationEntry[] = ctx.entries ?? INTEGRATIONS): string | undefined {
	const where = whereOf(n);
	return entries.find(e => belongsTo(e, n) && (integrationOn(e, ctx) || ctx.off.has(e.key) || where.some(w => inConv(e, w))))?.key;
}

// The enabled entries with their notices (newest first as given, at most `cap`) and the unread count: unread notices plus the unread messages
// of the conversations under the entry's `conv` prefixes (`convUnread`: target -> unread messages). `suggests` = the mails' reply states, `now` = the clock.
export function integrationItems(ctx: IntegrationContext, notices: readonly NoticeLike[], convUnread: Readonly<Record<string, number>> = {}, cap = 100, entries: readonly IntegrationEntry[] = ctx.entries ?? INTEGRATIONS, suggests: readonly SuggestLike[] = [], now = Date.now(), comments: Readonly<Record<string, { drafts: number; unread: number }>> = {}): IntegrationItem[] {
	const today = new Date(now).toDateString();
	return entries.filter(e => !ctx.off.has(e.key) && (integrationOn(e, ctx) || hasConvs(e, notices, convUnread))).map(e => {
		const mine = notices.filter(n => !n.dismissed && belongsTo(e, n));
		const convs = e.match.conv ?? [];
		const fromConvs = Object.entries(convUnread).reduce((c, [t, n]) => c + (inConv(e, t) ? n : 0), 0);
		const waits = (n: NoticeLike) => n.decision?.state === "open" && !!n.decision.draft && !n.ignored;
		const sentToday = suggests.filter(s => s.state === "sent" && inConv(e, s.target) && s.at && new Date(s.at).toDateString() === today).length;
		// A per-source entry adds up its sources (`src:<key>`, hub/comments/gateway.ts commentNeeds); any other entry reads its own key.
		const cm = e.sources ? e.sources.map(s => comments[`src:${s}`]).reduce((a, b) => ({ drafts: a.drafts + (b?.drafts ?? 0), unread: a.unread + (b?.unread ?? 0) }), { drafts: 0, unread: 0 }) : (comments[e.key] ?? { drafts: 0, unread: 0 });
		const needs = { drafts: mine.filter(waits).length + cm.drafts, unread: mine.filter(n => !n.read && !waits(n)).length + fromConvs + cm.unread, sentToday };
		return { key: e.key, app: e.app ?? e.key, label: e.label, kind: e.kind, icon: e.icon, ...(e.iconPath ? { iconPath: e.iconPath } : {}), ...(e.sources ? { sources: e.sources } : {}), conv: convs, ...(e.not?.conv.length ? { convNot: e.not.conv } : {}), ...(e.watches?.length ? { watches: e.watches } : {}), ...(e.not?.watches.length ? { watchesNot: e.not.watches } : {}), unread: mine.filter(n => !n.read).length + fromConvs + cm.unread, notices: mine.slice(0, cap).map(n => n.id), needs };
	});
}

// The apps the 앱 추가 sheet lists: only those the owner switched off or removed here (`off`). An entry never set up on this install is not listed;
// the owner asks for it and 새로 추가하기 builds it (hub/app-templates.ts). `conv` lets the web tell a mail this install still holds (data is kept
// while off) from one that only a peer shows.
export type AvailableApp = Pick<IntegrationEntry, "key" | "label" | "icon" | "iconPath"> & { app: string; off: boolean; conv: string[]; convNot?: string[] };
export const integrationAvailable = (shown: readonly { key: string }[], ctx: IntegrationContext, entries: readonly IntegrationEntry[] = ctx.entries ?? INTEGRATIONS): AvailableApp[] =>
	entries.filter(e => ctx.off.has(e.key) && !shown.some(i => i.key === e.key)).map(e => ({ key: e.key, app: e.app ?? e.key, label: e.label, icon: e.icon, ...(e.iconPath ? { iconPath: e.iconPath } : {}), off: ctx.off.has(e.key), conv: e.match.conv ?? [], ...(e.not?.conv.length ? { convNot: e.not.conv } : {}) }));
