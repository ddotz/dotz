import { createHash } from "node:crypto";
import { alertMatter } from "./alert-gate.ts";
import type { NoticeClass } from "./notice-class.ts";
import { type View, webText } from "./web-i18n.ts";

/** One notice as its kind sees it: `name` leads the title (an item title, a session's or the gateway's name), `conv` is the conversation it lives in. */
export type KindItem = { name: string; conv: string; text?: string; id?: string; at?: string; key?: string; watch?: string; folded?: boolean };
/** Whether the kind reaches each channel at all; the owner's switches for its class (hub/notify-route.ts route) still apply on top. */
export type KindChannels = { bell: boolean; push: boolean; discord: boolean; messenger: boolean };
/**
 * One kind of notice the owner gets. `cls`: its class (NOTICE_CLASSES). `title`: the web/i18n key of its push title (`{name}` = the item's name).
 * `lead`: whose name the title leads with, the gateway's (NAME) or the item's own. `tag`: the notification tag of one item (one matter, one
 * notification). `open`: the conversation a tap opens. `renotify`: a new report of the same item notifies again (a repeat of an alert does not).
 */
export type KindRow = { cls: NoticeClass; channels: KindChannels; title: string; lead: "gateway" | "item"; tag: (i: KindItem) => string; open: (i: KindItem) => string; renotify: boolean };

const ALL: KindChannels = { bell: true, push: true, discord: true, messenger: true };
const inConv = (i: KindItem): string => i.conv;
const askTag = (i: KindItem): string => `ask:${i.conv.startsWith("lane:") ? i.conv.slice(5) : i.conv}`;
const resultTag = (i: KindItem): string => (i.conv.startsWith("lane:") ? i.conv : `result:${i.key ?? i.id}`);
const worklogTag = (i: KindItem): string => `worklog:${i.key ?? i.id}`;
const alertTag = (i: KindItem): string => `alert:${createHash("sha256").update(alertMatter(i.text ?? "")).digest("hex").slice(0, 12)}`;
const answerTag = (conv: string): string => (conv === "main" ? "answer" : conv.startsWith("lane:") ? conv : conv === "alert" ? "alert" : `answer:${conv}`);
const watchTag = (i: KindItem): string => `watch:${i.key ?? i.watch ?? (i.folded ? `${i.id}:${i.at}` : i.id)}`;

/** Every kind of notice that reaches the owner, by name. A writer says its kind as `nk` on the event (or the post's extra); see kindOf. */
export const NOTICE_KINDS = {
	ask: { cls: "ask", channels: ALL, title: "notice.push.check", lead: "item", tag: askTag, open: inConv, renotify: false },
	"session-ask": { cls: "ask", channels: ALL, title: "notice.push.question", lead: "item", tag: askTag, open: inConv, renotify: false },
	decision: { cls: "ask", channels: ALL, title: "notice.push.decision", lead: "gateway", tag: i => `decision:${i.id}`, open: i => (i.conv.startsWith("auth:") ? "main" : i.conv), renotify: true },
	alert: { cls: "alert", channels: ALL, title: "notice.push.alert", lead: "gateway", tag: alertTag, open: inConv, renotify: false },
	"session-fail": { cls: "alert", channels: ALL, title: "notice.push.fail", lead: "item", tag: resultTag, open: inConv, renotify: false },
	"worklog-fail": { cls: "alert", channels: ALL, title: "notice.push.fail", lead: "item", tag: worklogTag, open: inConv, renotify: false },
	"answer-fail": { cls: "alert", channels: ALL, title: "notice.push.fail", lead: "item", tag: i => answerTag(i.conv), open: inConv, renotify: false },
	"session-done": { cls: "result", channels: ALL, title: "notice.push.done", lead: "item", tag: resultTag, open: inConv, renotify: false },
	"worklog-done": { cls: "result", channels: ALL, title: "notice.push.done", lead: "item", tag: worklogTag, open: inConv, renotify: false },
	"answer-done": { cls: "result", channels: ALL, title: "notice.push.done", lead: "item", tag: i => answerTag(i.conv), open: inConv, renotify: false },
	mail: { cls: "news", channels: ALL, title: "notice.push.mail", lead: "item", tag: i => `watch:${i.conv}`, open: inConv, renotify: true },
	watch: { cls: "news", channels: ALL, title: "notice.push.news", lead: "item", tag: watchTag, open: inConv, renotify: true },
	"self-update": { cls: "news", channels: ALL, title: "notice.push.update", lead: "gateway", tag: () => "update", open: inConv, renotify: false },
	answer: { cls: "conv", channels: ALL, title: "notice.push.message", lead: "item", tag: i => answerTag(i.conv), open: inConv, renotify: false },
	"send-fail": { cls: "alert", channels: ALL, title: "notice.push.fail", lead: "gateway", tag: i => `send:${i.id}`, open: inConv, renotify: false },
	"send-check": { cls: "alert", channels: ALL, title: "notice.push.check", lead: "gateway", tag: i => `send:${i.id}`, open: inConv, renotify: false },
	undelivered: { cls: "alert", channels: ALL, title: "notice.push.fail", lead: "gateway", tag: i => `undelivered:${i.id}`, open: inConv, renotify: false },
	"usage-stop": { cls: "alert", channels: ALL, title: "notice.push.alert", lead: "gateway", tag: () => "usage-stop", open: inConv, renotify: false },
	"orch-error": { cls: "alert", channels: ALL, title: "notice.push.alert", lead: "gateway", tag: () => "orch-error", open: inConv, renotify: false },
	ledger: { cls: "news", channels: ALL, title: "notice.push.news", lead: "gateway", tag: i => `ledger:${i.id}`, open: inConv, renotify: true },
	"gateway-note": { cls: "log", channels: { bell: false, push: false, discord: true, messenger: true }, title: "notice.push.message", lead: "gateway", tag: i => `note:${i.id}`, open: inConv, renotify: false },
} as const satisfies Record<string, KindRow>;
export type NoticeKindName = keyof typeof NOTICE_KINDS;
export const NOTICE_KIND_NAMES = Object.keys(NOTICE_KINDS) as NoticeKindName[];

/** The kind a writer named (`nk` on an event or a post's extra), or undefined when it named none or one the registry does not know. */
export const kindOf = (v: unknown): NoticeKindName | undefined => NOTICE_KIND_NAMES.find(k => k === v);
export const kindRow = (v: unknown): KindRow | undefined => {
	const k = kindOf(v);
	return k ? NOTICE_KINDS[k] : undefined;
};

/** A push title is at most this long, the sender's name included (a push service takes 4096 bytes in all). */
export const TITLE_MAX = 80;
/** The push title of `nk` in the install's language (`view`: another one), with `name` shortened so the whole stays within TITLE_MAX. */
export function pushTitle(nk: NoticeKindName, name: string, view?: View): string {
	const key = NOTICE_KINDS[nk].title;
	const full = webText(key, { name }, view);
	if (full.length <= TITLE_MAX) return full;
	const room = name.length - (full.length - TITLE_MAX) - 1;
	return room > 0 ? webText(key, { name: `${name.slice(0, room).replace(/[\uD800-\uDBFF]$/, "")}…` }, view) : `${full.slice(0, TITLE_MAX - 1)}…`;
}
