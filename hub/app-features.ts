// What an app owns, as data (모니터링 > 앱 > ⋯ > 기능 / 내부 기능). Everything an app does is the app's own function:
//   features  what the app does for the owner (댓글 답글, 릴스 올리기 승인 ...): a name, a short line, a switch. `ready: false` = the API or the
//             feature folder does not do it yet: it is declared so nobody invents it, and it is never listed.
//   internal  the machinery that keeps the app working: a login keeper (a watch with a session) is 로그인 유지, any other watch the app owns is 동기화.
//             They are rows of the app's settings screen, never rows of 일반 모니터링, and their failures notify under the app.
// A watch belongs to an app by name (the registry's `watches`, an instance's filter.watches), or - for a login keeper - by the site it keeps
// (`sites` below). A new app gets all of this by adding an entry here and its registry entry; no UI code.
//   GET   /api/integrations/<app>/features        -> {features, internal, approvals}
//   PATCH /api/integrations/<app>/features        -> {id, on}: a feature bound to a setting writes that setting, else custom/apps.json <app>.features.<id>
//   POST  /api/integrations/<app>/retry           -> {watch}: runs one owned watch now (다시 시도)
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSettings, SettingsError, writeSettings } from "./app-settings.ts";
import { APP_FEATURES, declOf, type FeatureDecl, featureOn, readApps } from "./app-feature-flags.ts";
import { APPS_FILE, appBase, appEntries, belongsTo, type IntegrationEntry } from "./integrations.ts";
import { watchFacts } from "./monitors.ts";
import type { Watch } from "./watch.ts";

const named = (list: readonly string[], watch: string): boolean => list.some(w => (w.endsWith("-") ? watch.startsWith(w) : watch === w));
type WatchLike = { name: string; session?: { url: string } };
const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
};
const siteOf = (e: IntegrationEntry, w: WatchLike): boolean => {
	const host = w.session ? hostOf(w.session.url) : "";
	return !!host && (APP_FEATURES[appBase(e.key)]?.sites ?? []).some(s => host === s || host.endsWith(`.${s}`));
};

/** The instance (entry key) a watch belongs to, or undefined: by name first (registry, instance filter), then a login keeper by its site (default instance only). */
export function watchOwner(entries: readonly IntegrationEntry[], w: WatchLike): string | undefined {
	const live = entries.filter(e => !e.gone);
	const byName = live.find(e => named(e.watches ?? [], w.name) && !named(e.not?.watches ?? [], w.name));
	if (byName) return byName.key;
	return live.find(e => !e.created && siteOf(e, w) && !named(e.not?.watches ?? [], w.name))?.key;
}
/** Instance key -> the names of the watches it owns (every watch, whatever the app's switch says). */
export function ownedWatches(dataDir: string, watches: readonly WatchLike[]): Map<string, string[]> {
	const entries = appEntries(dataDir), out = new Map<string, string[]>();
	for (const w of watches) {
		const o = watchOwner(entries, w);
		if (o) out.set(o, [...(out.get(o) ?? []), w.name]);
	}
	return out;
}

export { APP_FEATURES, type AppDecl, type FeatureDecl, featureEnabled } from "./app-feature-flags.ts";

export type FeatureView = { id: string; name: string; status: string; on: boolean };
export type ApprovalOption = { n: number; label: string };
export type InternalView = { id: string; kind: "login" | "sync"; name: string; dot: "ok" | "fail" | "idle"; status: string; last_run?: string; reason?: string };
/** An approval row: `title` is the item (post title or the start of the caption), `kind` what is approved, `options` the answers the owner can give from the row (고치기 needs a text, so it stays in the sheet). */
export type ApprovalView = { id: string; title: string; kind?: string; feature?: string; state: string; at?: string; note?: string; options: ApprovalOption[] };
export type FeaturesView = { app: string; features: FeatureView[]; internal: InternalView[]; approvals: ApprovalView[] };
type NoticeLike = { id: string; title?: string; text?: string; src?: string; open?: string; ts?: string; updated?: string; dismissed?: boolean; ignored?: string; decision?: { to?: string; state?: string; draft?: { subject?: string; body?: string } | unknown; options?: { n: number; label: string }[] } };

const KIND_KO = { login: "로그인 유지", sync: "동기화" } as const;
const HANGUL = /[가-힣]/;
const oneLine = (s: unknown, max: number): string => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
// A name written for people has Hangul and no bare lowercase key word ("ig site 로그인" is a key in words, "카카오 로그인 유지" is a name).
const readableName = (s: string): boolean => HANGUL.test(s) && !/(?:^|\s)[a-z][a-z0-9]*(?:\s|$)/.test(s);
// What a sync does, from the words of its watch name; the owner never reads the key ("sns-ig-comments").
const SYNC_NAMES: [RegExp, string][] = [[/comment/, "댓글 가져오기"], [/token/, "로그인 토큰 가져오기"], [/due|publish|job|upload/, "올릴 글 확인"], [/mail|inbox/, "새 메일 가져오기"], [/kakao|chat|msg/, "새 메시지 가져오기"]];
/** The name of an owned watch for the owner: its own label when it is words, else derived from what it does (a login keeper: "<앱> 로그인"). */
export function internalName(w: Pick<Watch, "name" | "label" | "session">, appLabel: string): string {
	const own = (w.label ?? "").trim();
	if (own && readableName(own)) return own;
	if (w.session) return `${appLabel} 로그인`;
	return SYNC_NAMES.find(([re]) => re.test(w.name))?.[1] ?? `${appLabel} 새 소식 확인`;
}
// The item an approval is about: the start of the post title or caption it carries, never the question's id ("(j-1)").
const ID_TAIL = /\s*\(([A-Za-z0-9][\w.:-]*)\)\s*$/;
const KEY_WORD = /\b[a-z]+-\d+\b/gi;
function approvalTitle(n: NoticeLike): string {
	const d = n.decision?.draft as { subject?: string; body?: string } | undefined;
	const item = oneLine(d?.subject, 60) || oneLine(d?.body, 60);
	if (item) return item;
	return oneLine((n.title ?? "").replace(ID_TAIL, "").replace(KEY_WORD, ""), 60) || "승인 요청";
}

// A watch whose last output is a progress line the owner reads as the row's status (the YouTube multilingual bulk apply).
const PROGRESS_WATCH = /bulk/;
/** One internal row of a watch the app owns. The reason is the words the watch's own failure carries (hub/watchtext.ts), never the raw output. */
export function internalOf(w: Watch, appLabel = "앱"): InternalView {
	const f = watchFacts(w), kind = w.session ? "login" : "sync", last = w.state.lastRun;
	const dot = f.fails ? "fail" : !last || w.paused || w.state.paused ? "idle" : "ok";
	const status = dot === "fail" ? `${f.fails}번 연달아 실패했어요` : dot === "idle" ? (w.paused || w.state.paused ? "멈춰 있어요" : "아직 확인 전이에요") : PROGRESS_WATCH.test(w.name) && f.last_output ? f.last_output : "정상이에요";
	return { id: w.name, kind, name: `${KIND_KO[kind]} · ${internalName(w, appLabel)}`, dot, status, ...(last ? { last_run: last } : {}), ...(dot === "fail" ? { reason: f.last_output || "확인에 실패했어요" } : {}) };
}

/** Why a Reels upload cannot go out yet: the Instagram token lacks instagram_business_content_publish (features/youtube-instagram/lib/ig-publish.ts writes the flag). */
export const REELS_BLOCKED = "아직 릴스를 올릴 수 없어요. instagram_business_content_publish 권한이 필요해요. Meta 앱 대시보드의 Instagram API 설정에서 '액세스 토큰 생성'으로 토큰을 다시 만들어 주세요";
const reelsBlocked = (dataDir: string): boolean => existsSync(join(dataDir, "custom", "sns", "cache", "ig-publish.json"));

export function featuresOf(dataDir: string, app: string, watches: readonly Watch[], notices: readonly NoticeLike[]): FeaturesView {
	const entries = appEntries(dataDir), entry = entries.find(e => e.key === app && !e.gone);
	if (!entry) throw new SettingsError(`${app}: 알 수 없는 앱이에요`, 404);
	const decls = declOf(app), settings = new Map(readSettings(dataDir, app).map(s => [s.key, s.value]));
	const mine = new Set(ownedWatches(dataDir, watches).get(app) ?? []);
	// An approval is an open question with a draft in the app's own conversation or about the app (hub/integrations.ts belongsTo).
	const open = notices.filter(n => !n.dismissed && !n.ignored && n.decision?.state === "open" && !!n.decision.draft && belongsTo(entry, n));
	const featureOfNotice = (n: NoticeLike): FeatureDecl | undefined => {
		const hay = `${n.title ?? ""}\n${n.text ?? ""}`;
		const hit = (f: FeatureDecl, any: boolean) => (f.approves ?? []).some(p => (p === "." ? any : new RegExp(p, "i").test(hay)));
		return decls.find(f => hit(f, false)) ?? decls.find(f => hit(f, true));
	};
	const blocked = app === "instagram" && reelsBlocked(dataDir);
	const approvals: ApprovalView[] = open.map(n => ({ id: n.id, title: approvalTitle(n), ...(featureOfNotice(n) ? { feature: featureOfNotice(n)!.id, kind: featureOfNotice(n)!.name } : {}), ...(blocked && featureOfNotice(n)?.id === "reels_approval" ? { note: REELS_BLOCKED } : {}), state: "open", ...(n.updated ?? n.ts ? { at: n.updated ?? n.ts } : {}), options: (n.decision?.options ?? []).filter(o => !o.label.startsWith("고치기")).map(o => ({ n: o.n, label: o.label })) }));
	const features = decls.map(f => {
		const on = featureOn(dataDir, app, f, settings), waiting = approvals.filter(a => a.feature === f.id).length;
		return { id: f.id, name: f.name, on, status: !on ? "꺼져 있어요" : blocked && f.id === "reels_approval" ? REELS_BLOCKED : waiting ? `승인 대기 ${waiting}건` : f.hint };
	});
	const internal = watches.filter(w => mine.has(w.name)).map(w => internalOf(w, entry.label));
	return { app, features, internal, approvals };
}

/** Switches one feature. Unknown or not-ready ids are 404 (a hidden feature has no switch). */
export function setFeature(dataDir: string, app: string, id: unknown, on: unknown): void {
	if (typeof on !== "boolean") throw new SettingsError("on: true 또는 false여야 해요");
	const f = declOf(app).find(x => x.id === id);
	if (!f || !appEntries(dataDir).some(e => e.key === app && !e.gone)) throw new SettingsError(`${String(id)}: 알 수 없는 기능이에요`, 404);
	if (f.setting) {
		writeSettings(dataDir, app, { [f.setting]: on });
		return;
	}
	const doc = readApps(dataDir), mine = doc[app] && typeof doc[app] === "object" ? doc[app] : (doc[app] = {});
	const flags = mine.features && typeof mine.features === "object" ? mine.features : (mine.features = {});
	if (on) delete flags[f.id];
	else flags[f.id] = false;
	if (!Object.keys(flags).length) delete mine.features;
	const file = join(dataDir, APPS_FILE), tmp = `${file}.${process.pid}.tmp`;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
	renameSync(tmp, file);
}

/** Runs one watch the app owns (다시 시도). Not the app's = 404. */
export async function retryInternal(dataDir: string, app: string, watch: unknown, watches: readonly WatchLike[], run: (name: string) => Promise<void>): Promise<void> {
	if (typeof watch !== "string" || !(ownedWatches(dataDir, watches).get(app) ?? []).includes(watch)) throw new SettingsError(`${String(watch)}: 이 앱의 내부 기능이 아니에요`, 404);
	await run(watch);
}
