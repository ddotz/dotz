// Which conversation each page shows, and which answers stay quiet. A part of the notice store split out of hub/notices.ts, code unchanged.

/* ---------- unread answers: one bell item per conversation the owner is not looking at ---------- */
const VIEW_MS = 60_000;
// What each open web page reports it is showing (id -> conversation, "" = hidden / not a chat). A report older than VIEW_MS no longer counts.
export const viewers = new Map<string, { conv: string; at: number }>();
export function isViewing(conv: string, nowMs = Date.now()): boolean {
	for (const [id, v] of viewers) {
		if (nowMs - v.at >= VIEW_MS) viewers.delete(id);
		else if (v.conv === conv) return true;
	}
	return false;
}
// The reply to a choice-button answer is a quiet reply: no push, no corner toast, no message item. A button answer is the owner's message
// carrying `picks` or `decision` (hub/intake.ts sendWeb); the first answer after it in that conversation is its reply. A reply that asks or
// fails still speaks up, and so does a session's [done] (its result item). Safe to call twice for one event (push and notices both do).
export const QUIET_MS = 10 * 60_000;
export const awaitingReply = new Map<string, number>();
export const quietReplies = new Set<string>();
