// The switches of an app's features, split out of hub/app-features.ts so the code that DOES the feature (a feature folder's script, the mail
// route, the comment engine) can ask "is it on?" without loading the monitoring side (watches, config.ts). Pure fs: the data dir is a parameter.
//   featureEnabled(dataDir, app, id)  the one question every feature path asks before it acts; off = the path does nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSettings, type SettingSection } from "./app-settings.ts";
import { APPS_FILE, appBase, appEntries } from "./integrations.ts";
import { instanceOf } from "./reply-model.ts";

export type FeatureDecl = {
	id: string;
	name: string;
	/** The one line under the name while it is on. */
	hint: string;
	/** The section of the settings screen this feature's switch belongs to (default 기타 기능). */
	section?: SettingSection;
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
			{ id: "new_mail", name: "새 메일", hint: "새 메일이 오면 알려 줘요", section: "notify" },
			{ id: "reply_draft", name: "자동 초안", hint: "답할 메일에 초안을 만들고 보내기 전에 물어요", setting: "auto_draft", section: "draft", approves: ["."] },
		],
		sites: ["mail.naver.com", "mail.google.com", "outlook.live.com", "outlook.office.com"],
	},
	kakao: {
		features: [
			{ id: "watch_rooms", name: "감시", hint: "정한 채팅방의 새 메시지를 지켜봐요", setting: "enabled", section: "watch" },
			{ id: "reply_draft", name: "자동 초안", hint: "새 메시지에 초안을 만들고 보내기 전에 물어요", section: "draft", approves: ["."] },
		],
		sites: ["kakao.com"],
	},
	instagram: {
		features: [
			{ id: "comment_reply", name: "자동 초안", hint: "댓글에 답글 초안을 만들고 달기 전에 물어요", setting: "auto_draft", section: "draft" },
			{ id: "reels_approval", name: "릴스(쇼츠) 올리기 승인", hint: "릴스를 올리기 전에 오너 승인을 받아요", section: "draft", approves: ["."] },
			{ id: "post_edit", name: "게시물 정보 수정", hint: "올린 게시물의 설명을 고쳐요", ready: false },
			{ id: "dm_read", name: "DM 읽기", hint: "받은 DM을 읽기만 해요. 답장은 보내지 않아요", section: "more" },
			{ id: "dm", name: "DM 답장", hint: "다이렉트 메시지에 답해요", ready: false },
		],
		sites: ["instagram.com"],
	},
	youtube: {
		features: [
			{ id: "comment_reply", name: "자동 초안", hint: "댓글에 답글 초안을 만들고 달기 전에 물어요", setting: "auto_draft", section: "draft" },
			{ id: "metadata", name: "메타데이터", hint: "올린 영상의 제목과 설명을 언어별로 고치기 전에 물어요", section: "draft", approves: ["메타|metadata|번역|언어"] },
			{ id: "upload_approval", name: "쇼츠·영상 올리기 승인", hint: "쇼츠와 영상을 올리기 전에 오너 승인을 받아요", section: "draft", approves: ["."] },
		],
		sites: ["youtube.com", "studio.youtube.com"],
	},
	site: {
		features: [{ id: "comment_reply", name: "자동 초안", hint: "웹사이트 댓글에 답글 초안을 만들고 달기 전에 물어요", section: "draft", approves: ["."] }],
	},
};

export function readApps(dataDir: string): Record<string, any> {
	try {
		const v = JSON.parse(readFileSync(join(dataDir, APPS_FILE), "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}
export const declOf = (app: string): FeatureDecl[] => (APP_FEATURES[appBase(app)]?.features ?? []).filter(f => f.ready !== false);

export function featureOn(dataDir: string, app: string, f: FeatureDecl, settings: ReadonlyMap<string, unknown>): boolean {
	if (f.setting) return settings.get(f.setting) === true;
	return readApps(dataDir)[app]?.features?.[f.id] !== false;
}

/** A flag the app's own code can ask: is this feature on for this instance? (A feature that is not declared is on.) */
export function featureEnabled(dataDir: string, app: string, id: string): boolean {
	const f = declOf(app).find(x => x.id === id);
	if (!f) return true;
	return featureOn(dataDir, app, f, new Map(readSettings(dataDir, app).map(s => [s.key, s.value])));
}

/** Whether the mail app instance that owns mail `<key>` (matched by its source like mailDiscordOn) has 새 메일 on. */
export const mailFeatureOn = (dataDir: string, key: string, id: string): boolean => featureEnabled(dataDir, instanceOf(appEntries(dataDir), "mail", `mail:${key}`), id);
