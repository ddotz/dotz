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
import { existsSync, readFileSync } from "node:fs";
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
};

export const INTEGRATIONS: IntegrationEntry[] = [
	{
		key: "mail", label: "메일", kind: "app", icon: "mail",
		iconPath: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3.5 7.5l8.5 6 8.5-6",
		on: { features: ["webmail-no-api"], flags: ["zele"] },
		match: { conv: ["mail:"], draft: ["받는이"], text: ["메일"] },
	},
	{
		key: "kakao", label: "카카오톡", kind: "app", icon: "kakao",
		iconPath: "M12 4c4.7 0 8.5 2.9 8.5 6.5S16.7 17 12 17c-.8 0-1.6-.1-2.3-.3L5.5 19.5l1-3.6C4.7 14.6 3.5 12.7 3.5 10.5 3.5 6.9 7.3 4 12 4z",
		on: { features: ["kakao"] },
		match: { draft: ["대화방"], text: ["카카오톡", "카톡", "kakao"] },
	},
	{
		key: "instagram", label: "인스타그램", kind: "app", icon: "instagram",
		iconPath: "M7 3.5h10A3.5 3.5 0 0 1 20.5 7v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M17 7h.01",
		on: { files: ["custom/sns/config.json#instagram"] },
		match: { text: ["인스타", "instagram"] },
	},
	{
		key: "youtube", label: "유튜브", kind: "app", icon: "youtube",
		iconPath: "M4 6.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM10 9.5v5l4.5-2.5z",
		on: { files: ["custom/sns/config.json#youtube"] },
		match: { text: ["유튜브", "youtube"] },
	},
];

export type IntegrationContext = { features: ReadonlySet<string>; files: (spec: string) => boolean; flags: ReadonlySet<string> };
type NoticeLike = { id: string; title?: string; text?: string; open?: string; src?: string; read?: boolean; dismissed?: boolean; decision?: { to?: string } };
export type IntegrationItem = Pick<IntegrationEntry, "key" | "label" | "kind" | "icon" | "iconPath"> & { conv: string[]; unread: number; notices: string[] };

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
	return { features, files, flags: new Set(flags) };
}

export const integrationOn = (e: IntegrationEntry, ctx: IntegrationContext): boolean =>
	!!(e.on.features?.some(f => ctx.features.has(f)) || e.on.files?.some(f => ctx.files(f)) || e.on.flags?.some(f => ctx.flags.has(f)));

const whereOf = (n: NoticeLike): string[] => [n.src, n.open, n.decision?.to].filter((s): s is string => typeof s === "string");

// Conversations or notices already live under the entry's `conv` prefixes: this install receives through it, whatever its switches say.
const hasConvs = (e: IntegrationEntry, notices: readonly NoticeLike[], convUnread: Readonly<Record<string, number>>): boolean =>
	(e.match.conv ?? []).some(p => Object.keys(convUnread).some(t => t.startsWith(p)) || notices.some(n => whereOf(n).some(w => w.startsWith(p))));

export function belongsTo(e: IntegrationEntry, n: NoticeLike): boolean {
	const { conv = [], draft = [], text = [] } = e.match;
	const where = whereOf(n);
	if (conv.some(p => where.some(w => w.startsWith(p)))) return true;
	const body = n.text ?? "";
	if (n.decision && draft.some(l => body.includes(`> ${l}:`))) return true;
	const hay = `${n.title ?? ""}\n${body}`.toLowerCase();
	return text.some(t => hay.includes(t.toLowerCase()));
}

// The enabled entries with their notices (newest first as given, at most `cap`) and the unread count: unread notices plus the unread messages
// of the conversations under the entry's `conv` prefixes (`convUnread`: target -> unread messages).
export function integrationItems(ctx: IntegrationContext, notices: readonly NoticeLike[], convUnread: Readonly<Record<string, number>> = {}, cap = 100, entries: readonly IntegrationEntry[] = INTEGRATIONS): IntegrationItem[] {
	return entries.filter(e => integrationOn(e, ctx) || hasConvs(e, notices, convUnread)).map(e => {
		const mine = notices.filter(n => !n.dismissed && belongsTo(e, n));
		const convs = e.match.conv ?? [];
		const fromConvs = Object.entries(convUnread).reduce((c, [t, n]) => c + (convs.some(p => t.startsWith(p)) ? n : 0), 0);
		return { key: e.key, label: e.label, kind: e.kind, icon: e.icon, ...(e.iconPath ? { iconPath: e.iconPath } : {}), conv: convs, unread: mine.filter(n => !n.read).length + fromConvs, notices: mine.slice(0, cap).map(n => n.id) };
	});
}
