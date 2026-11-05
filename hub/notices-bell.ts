// What the bell lists: listing, dismissing, viewing, and dropping a conversation's notices. A part of the notice store split out of hub/notices.ts, code unchanged.
import { now } from "./config.ts";
import { readOf } from "./reads.ts";
import type { Notice } from "./notices-types.ts";
import { appBlocked } from "./notices-wiring.ts";
import { NOTICE_CAP, isOpenDecision, waitsOf } from "./notices-rules.ts";
import { channelLanes, laneOfNotice } from "./notices-lanes.ts";
import { broadcast, readable, withClass } from "./notices-read.ts";
import { viewers } from "./notices-viewing.ts";
import { items, markNoticesRead, readConversationNotices, retire, save, unreadCount } from "./notices-store.ts";

// The alert / message twin of a decision: an [ask] item made by the same asking event, or by a repeat of the same text (a session's mid-turn line and its
// turn-end report both post it), so it ends with the decision.
export const laneHasOpenCard = (name: string): boolean => items.some(i => isOpenDecision(i) && i.decision!.to === `lane:${name}`);
const CONV_RE = /^(?:main|alert|worklog|lane:[\w.-]+|ch:\d+|mail:[a-z0-9._-]+|settings:[\w.:-]+)$/;
// POST /api/viewing: the page says which conversation is on screen ("" when hidden). Looking at a conversation reads its message item.
export function setViewing(id: unknown, conv: unknown, nowMs = Date.now()): { ok: boolean; unread?: number } {
	const who = typeof id === "string" ? id.slice(0, 64) : "";
	if (!who || typeof conv !== "string" || (conv !== "" && !CONV_RE.test(conv))) return { ok: false };
	viewers.set(who, { conv, at: nowMs });
	const item = conv ? items.find(n => n.key === `msg:${conv}`) : undefined;
	if (item && !item.read) markNoticesRead({ ids: [item.id] });
	// Items of this conversation that the read position already covers (read on another device, or before this fix) leave the bell too.
	const seen = conv ? readOf(conv) : null;
	if (seen) readConversationNotices(conv, seen, "viewed");
	return { ok: true, unread: unreadCount() };
}

// Called when a session is deleted (hub/lanetrash.ts): its notices go with it. Returns how many were retired.
export function dropLaneNotices(name: string): number {
	const byChannel = channelLanes();
	const list = items.filter(i => !i.dismissed && laneOfNotice(i, byChannel) === name);
	retire(list);
	return list.length;
}

// Called when a channel is deleted, or when its session stops (`messagesOnly`: the channel stays, only its unread-message items go).
// Returns how many were retired.
const channelNotices = (conv: string, messagesOnly: boolean) => items.filter(i => !i.dismissed && (i.src ?? i.open) === conv && (!messagesOnly || i.kind === "message"));
export function dropChannelNotices(conv: string, messagesOnly = false): number {
	const list = channelNotices(conv, messagesOnly);
	retire(list);
	return list.length;
}
// How many notices dropChannelNotices(conv) would retire (the project delete sheet lists it).
export const countChannelNotices = (conv: string): number => channelNotices(conv, false).length;

// Open decisions first, then unread, then the most recently updated.
const sortedNotices = (): Notice[] => {
	const shown = items.filter(i => !i.dismissed && !appBlocked(i));
	const order = new Map(shown.map((i, idx) => [i, idx]));
	return [...shown].sort((a, b) => Number(isOpenDecision(b)) - Number(isOpenDecision(a)) || Number(a.read) - Number(b.read) || b.updated.localeCompare(a.updated) || order.get(b)! - order.get(a)!);
};
// The same list with no limit: what a lookup or a scan inside the hub reads (a limit would hide a card past it).
export const allNotices = (): Notice[] => sortedNotices().map(i => withClass(i, readable(i)));

// `keepOpen` (GET /api/notices): never fewer rows than the open decisions plus 100, so no open card falls off the page.
export function listNotices(limit = 100, keepOpen = false): { items: Notice[]; unread: number } {
	const sorted = sortedNotices();
	const base = Math.max(1, Math.min(Math.floor(limit) || 100, NOTICE_CAP));
	const n = keepOpen ? Math.max(base, sorted.filter(isOpenDecision).length + 100) : base;
	return { items: sorted.slice(0, n).map(i => withClass(i, readable(i))), unread: unreadCount() };
}

// The 알림 conversation's messages whose notice was dismissed (지우기 on it, web/js/30-notices.js): their event times, so every page hides them there.
export const dismissedAlertAts = (): string[] => items.filter(i => i.dismissed && (i.src ?? i.open) === "alert" && i.at).map(i => i.at!);

// Swipe / x in the bell: read and gone from every list and count, on every open tab (a notice_dismiss frame).
export function dismissNotice(id: unknown): { ok: boolean; held?: boolean; unread: number } {
	const item = items.find(i => i.id === String(id));
	if (!item) return { ok: false, unread: unreadCount() };
	// A question that still waits on the owner cannot be swiped away.
	if (isOpenDecision(item)) return { ok: false, held: true, unread: unreadCount() };
	if (!item.dismissed) {
		item.dismissed = true;
		item.read = true;
		save();
		broadcast({ ts: now(), kind: "notice_dismiss", source: "gateway", id: item.id, unread: unreadCount() });
	}
	return { ok: true, unread: unreadCount() };
}

// The ✕ on a failure that waits (waits === "fail"): read, handled now, on every open page. A lost login closes only by its recovery.
export function handledNotice(id: unknown): { status: number; body: Record<string, unknown> } {
	const item = items.find(i => i.id === String(id));
	if (!item) return { status: 404, body: { error: "unknown notice" } };
	if (waitsOf(item) !== "fail") return { status: 409, body: { error: "not waiting" } };
	const at = now();
	item.read = true;
	item.handled = at;
	save();
	broadcast({ ts: at, kind: "notice", source: "gateway", item, unread: unreadCount() });
	return { status: 200, body: { ok: true, item: withClass(item, readable(item)), unread: unreadCount() } };
}

// Undo of dismissNotice (the toast's 실행 취소): listed and counted again, as it was.
export function undismissNotice(id: unknown): { status: number; body: Record<string, unknown> } {
	const item = items.find(i => i.id === String(id));
	if (!item) return { status: 404, body: { error: "unknown notice" } };
	if (item.dismissed) {
		delete item.dismissed;
		save();
		broadcast({ ts: now(), kind: "notice", source: "gateway", item, unread: unreadCount() });
	}
	return { status: 200, body: { ok: true, item: withClass(item, readable(item)), unread: unreadCount() } };
}
