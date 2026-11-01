// One classification of everything the owner is told, by what he must do (owner 2026-11-01, "1) 이대로 진행"). The bell's tabs and badge
// (web/js/30-notices.js), the web push (hub/push.ts) and Discord's ping (hub/discord.ts via pushReachesOwner) all read it; a notice gets its
// class when it is read or broadcast (hub/notices.ts withClass), so nothing stored changes.
//   ask    답변 필요  [ask] questions, send approvals, login / 2FA requests: push at once, pinned on top until answered, orange badge.
//   alert  경고       gateway failures, lost logins, monitors failing again and again: push, red badge.
//   result 결과       a session's or background job's [done] / [fail], a work log entry that finished: push.
//   news   새 소식    mail, KakaoTalk, comments, monitors, schedules: push per app (that app's own switch), grouped by app in the bell.
//   conv   대화       a new answer in a conversation the owner is not looking at: push only then (hub/push.ts shouldNotify).
//   log    기록       [run] progress and routine records: no push, no badge, only in 작업내역.
import type { Notice, NoticeKind, NoticeTone } from "./notices.ts";

export const NOTICE_CLASSES = ["ask", "alert", "result", "news", "conv", "log"] as const;
export type NoticeClass = (typeof NOTICE_CLASSES)[number];
export const CLASS_LABELS: Record<NoticeClass, string> = { ask: "답변 필요", alert: "경고", result: "결과", news: "새 소식", conv: "대화", log: "기록" };
// The owner's push switches start from these (config.json notify.push overrides them).
export const CLASS_PUSH_DEFAULTS: Record<NoticeClass, boolean> = { ask: true, alert: true, result: true, news: true, conv: true, log: false };
export type Badge = "orange" | "red" | "plain" | "none";
const BADGE: Record<NoticeClass, Badge> = { ask: "orange", alert: "red", result: "plain", news: "plain", conv: "plain", log: "none" };
export type ClassOf = { cls: NoticeClass; push: boolean; badge: Badge; pin: boolean };

// The gateway's routine reports in the alert channel: kept as a record, never a warning.
export const ROUTINE_ALERT = /^토큰 누수 점검/;

// `decision`: the state of the notice's decision when it has one; `quiet`: an alert the gateway already told (a repeat, an all-clear, a reply in
// the alert channel, or a non-critical post by someone other than the gateway; the event path decides it, hub/push.ts classifyEvent).
export type ClassInput = { kind: NoticeKind; tone: NoticeTone; decision?: string; key?: string; text?: string; read?: boolean; ignored?: boolean; quiet?: boolean };

function clsOf(n: ClassInput): NoticeClass {
	if (n.kind === "decision" || n.decision !== undefined || n.tone === "ask") return "ask";
	if (n.tone === "run") return "log";
	switch (n.kind) {
		case "alert":
			if (n.key === "self-update") return "news";
			return n.quiet || ROUTINE_ALERT.test(n.text ?? "") ? "log" : "alert";
		case "result":
		case "worklog":
			return n.tone === "done" || n.tone === "fail" ? "result" : "log";
		case "watch":
			return "news";
		case "message":
			return "conv";
	}
	return "log";
}

export function noticeClass(n: ClassInput): ClassOf {
	const cls = clsOf(n);
	// Pinned while it still waits: an open decision, or an [ask] the owner has neither answered nor ignored.
	const pin = cls === "ask" && (n.decision !== undefined ? n.decision === "open" : !n.read && !n.ignored);
	return { cls, push: CLASS_PUSH_DEFAULTS[cls], badge: BADGE[cls], pin };
}
export const classOfNotice = (n: Notice): ClassOf =>
	noticeClass({ kind: n.kind, tone: n.tone, ...(n.decision ? { decision: n.decision.state } : {}), ...(n.key ? { key: n.key } : {}), text: n.text, read: n.read, ignored: !!n.ignored });
