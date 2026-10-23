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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSettings, SettingsError, writeSettings } from "./app-settings.ts";
import { APPS_FILE, appBase, appEntries, belongsTo, type IntegrationEntry } from "./integrations.ts";
import { watchFacts } from "./monitors.ts";
import type { Watch } from "./watch.ts";
import { watchLabel } from "./workchannels.ts";

export type FeatureDecl = {
	id: string;
	name: string;
	/** The one line under the name while it is on. */
	hint: string;
	/** False: not implemented (the API does not allow it, or the feature folder has no code for it). Declared, never listed. */
	ready?: boolean;
	/** The key of a setting of hub/app-settings.ts that is this feature's switch (the setting is the one source of truth). */
	setting?: string;
	/** Patterns on an approval's title and text: the approvals of this feature. "." takes every approval no other feature claims. */
	approves?: string[];
};
export type AppDecl = { features: FeatureDecl[]; /** Hosts whose login this app keeps: a login keeper of such a site is the app's. */ sites?: string[] };

export const APP_FEATURES: Record<string, AppDecl> = {
	mail: {
		features: [
			{ id: "new_mail", name: "새 메일", hint: "새 메일이 오면 알려 줘요" },
			{ id: "reply_draft", name: "답장 초안", hint: "답할 메일에 초안을 만들고 보내기 전에 물어요", setting: "auto_draft", approves: ["."] },
		],
		sites: ["mail.naver.com", "mail.google.com", "outlook.live.com", "outlook.office.com"],
	},
	kakao: {
		features: [
			{ id: "watch_rooms", name: "방 감시", hint: "정한 채팅방의 새 메시지를 지켜봐요", setting: "enabled" },
			{ id: "reply_draft", name: "답장 초안", hint: "새 메시지에 초안을 만들고 보내기 전에 물어요", approves: ["."] },
		],
		sites: ["kakao.com"],
	},
	instagram: {
		features: [
			{ id: "comment_reply", name: "댓글 답글", hint: "댓글에 답글 초안을 만들고 달기 전에 물어요", setting: "auto_draft" },
			{ id: "reels_approval", name: "릴스(쇼츠) 올리기 승인", hint: "릴스를 올리기 전에 오너 승인을 받아요", approves: ["."] },
			{ id: "post_edit", name: "게시물 정보 수정", hint: "올린 게시물의 설명을 고쳐요", ready: false },
			{ id: "dm", name: "DM 답장", hint: "다이렉트 메시지에 답해요", ready: false },
		],
		sites: ["instagram.com"],
	},
	youtube: {
		features: [
			{ id: "comment_reply", name: "댓글 답글", hint: "댓글에 답글 초안을 만들고 달기 전에 물어요", setting: "auto_draft" },
			{ id: "metadata", name: "메타데이터", hint: "올린 영상의 제목과 설명을 언어별로 고치기 전에 물어요", approves: ["메타|metadata|번역|언어"] },
			{ id: "upload_approval", name: "쇼츠·영상 올리기 승인", hint: "쇼츠와 영상을 올리기 전에 오너 승인을 받아요", approves: ["."] },
		],
		sites: ["youtube.com", "studio.youtube.com"],
	},
	site: {
		features: [{ id: "comment_reply", name: "댓글 답글", hint: "웹사이트 댓글에 답글 초안을 만들고 달기 전에 물어요", approves: ["."] }],
	},
};

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

export type FeatureView = { id: string; name: string; status: string; on: boolean };
export type InternalView = { id: string; kind: "login" | "sync"; name: string; dot: "ok" | "fail" | "idle"; status: string; last_run?: string; reason?: string };
export type ApprovalView = { id: string; title: string; feature?: string; state: string; at?: string };
export type FeaturesView = { app: string; features: FeatureView[]; internal: InternalView[]; approvals: ApprovalView[] };
type NoticeLike = { id: string; title?: string; text?: string; src?: string; open?: string; ts?: string; updated?: string; dismissed?: boolean; ignored?: string; decision?: { to?: string; state?: string; draft?: unknown } };

const KIND_KO = { login: "로그인 유지", sync: "동기화" } as const;

function readApps(dataDir: string): Record<string, any> {
	try {
		const v = JSON.parse(readFileSync(join(dataDir, APPS_FILE), "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}
const declOf = (app: string): FeatureDecl[] => (APP_FEATURES[appBase(app)]?.features ?? []).filter(f => f.ready !== false);

function featureOn(dataDir: string, app: string, f: FeatureDecl, settings: ReadonlyMap<string, unknown>): boolean {
	if (f.setting) return settings.get(f.setting) === true;
	return readApps(dataDir)[app]?.features?.[f.id] !== false;
}

/** One internal row of a watch the app owns. The reason is the words the watch's own failure carries (hub/watchtext.ts), never the raw output. */
export function internalOf(w: Watch): InternalView {
	const f = watchFacts(w), kind = w.session ? "login" : "sync", last = w.state.lastRun;
	const dot = f.fails ? "fail" : !last || w.paused || w.state.paused ? "idle" : "ok";
	const status = dot === "fail" ? `${f.fails}번 연달아 실패했어요` : dot === "idle" ? (w.paused || w.state.paused ? "멈춰 있어요" : "아직 확인 전이에요") : "정상이에요";
	return { id: w.name, kind, name: `${KIND_KO[kind]} · ${watchLabel(w.name)}`, dot, status, ...(last ? { last_run: last } : {}), ...(dot === "fail" ? { reason: f.last_output || "확인에 실패했어요" } : {}) };
}

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
	const approvals = open.map(n => ({ id: n.id, title: (n.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120), ...(featureOfNotice(n) ? { feature: featureOfNotice(n)!.id } : {}), state: "open", ...(n.updated ?? n.ts ? { at: n.updated ?? n.ts } : {}) }));
	const features = decls.map(f => {
		const on = featureOn(dataDir, app, f, settings), waiting = approvals.filter(a => a.feature === f.id).length;
		return { id: f.id, name: f.name, on, status: !on ? "꺼져 있어요" : waiting ? `승인 대기 ${waiting}건` : f.hint };
	});
	const internal = watches.filter(w => mine.has(w.name)).map(internalOf);
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

/** A flag the app's own code can ask: is this feature on for this instance? (A feature that is not declared is on.) */
export function featureEnabled(dataDir: string, app: string, id: string): boolean {
	const f = declOf(app).find(x => x.id === id);
	if (!f) return true;
	return featureOn(dataDir, app, f, new Map(readSettings(dataDir, app).map(s => [s.key, s.value])));
}

/** Runs one watch the app owns (다시 시도). Not the app's = 404. */
export async function retryInternal(dataDir: string, app: string, watch: unknown, watches: readonly WatchLike[], run: (name: string) => Promise<void>): Promise<void> {
	if (typeof watch !== "string" || !(ownedWatches(dataDir, watches).get(app) ?? []).includes(watch)) throw new SettingsError(`${String(watch)}: 이 앱의 내부 기능이 아니에요`, 404);
	await run(watch);
}
