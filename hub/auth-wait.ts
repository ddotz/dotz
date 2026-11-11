// While a session waits on its own dotz_auth call (the tool holds the turn until the owner answers in the web app or on Discord),
// owner messages to that session only queue behind the wait. The gateway says so itself, with no model call: what is awaited and
// until when, at most once per request and conversation in REPEAT_MS, and only then: this is the one allowed exception to the ban on
// canned receipts (memory/boundaries.md 2026-10-17). A bare "취소" from the owner closes the request, the same as DELETE
// /api/auth/<id>. Owner report 2026-11-05: four JANDI messages got no answer for ten minutes while the main session waited on a
// login form shown in the web app only. Requests no session waits on (a lane's, kakao onboarding's) carry no session and never match.
import { TZ, tzLabel } from "./config.ts";
import { msg } from "./i18n.ts";
import type { AuthWait } from "./auth.ts";

export type WaitDeps = {
	pending(): AuthWait[];
	/** The session that answers a target (hub/convsessions.ts keyOf). */
	sessionOf(target: string): string;
	/** Whether that session is inside a turn: one that died or stopped holds no message back, so nothing is "waiting". */
	busy(target: string): boolean;
	cancel(id: string): boolean;
	post(target: string, text: string, replyTo?: string): void;
};
/** One owner message (or burst) as it reaches hub/intake.ts flush; `owner` is false for anything not the owner's. */
export type Inbound = { target: string; text: string; owner: boolean; replyTo?: string };

const CANCEL = /^\s*(취소|cancel)\s*[.!]?\s*$/i;
const PURPOSE_MAX = 80;
const REPEAT_MS = 5 * 60_000;
const told = new Map<string, number>();
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export const untilText = (ms: number): string => `${clock.format(ms)} ${tzLabel()}`;
export function waitWhat(w: AuthWait): string {
	const p = w.purpose.replace(/\s+/g, " ").trim() || w.site;
	return p.length > PURPOSE_MAX ? `${p.slice(0, PURPOSE_MAX - 1)}…` : p;
}

/** The text of a burst when it is one message the owner typed and nothing more; a reply, a quote, a forward, a decision answer or
 *  an attached file is about something else, so its "취소" is not an order to close a request. */
export function bareText(events: Record<string, any>[]): string {
	const e = events.length === 1 ? events[0] : undefined;
	if (!e || e.attachments?.length || e.reply || e.quoted || e.reply_to || e.decision || e.picks?.length || e.elements?.length || e.refs?.length) return "";
	return String(e.text ?? "");
}

const waitsFor = (target: string, d: WaitDeps): AuthWait[] => {
	const session = d.sessionOf(target);
	return d.pending().filter(w => w.session === session).sort((a, b) => a.expiresAt - b.expiresAt);
};
/** A request of this conversation's session is open: the message goes through intake so it hears the notice or closes the request. */
export const authHolds = (target: string, d: WaitDeps): boolean => waitsFor(target, d).length > 0;

/** The owner's "취소" while a request of this conversation's session is pending: closes it and says so. True when the message was
 *  that, so the caller delivers nothing to the session (its dotz_auth call already returns "cancelled"). */
export function cancelReply(m: Inbound, d: WaitDeps): boolean {
	if (!m.owner || !CANCEL.test(m.text)) return false;
	const closed = waitsFor(m.target, d).filter(w => d.cancel(w.id));
	for (const w of closed) d.post(m.target, msg().authCancelledNotice(waitWhat(w)), m.replyTo);
	return closed.length > 0;
}

/** One short gateway reply to an owner message that arrives while this conversation's session waits on a request. The message
 *  still goes to the session as before; true when the notice was posted. */
export function waitNotice(m: Inbound, d: WaitDeps): boolean {
	if (!m.owner || !d.busy(m.target)) return false;
	const w = waitsFor(m.target, d)[0];
	if (!w) return false;
	const now = Date.now();
	for (const [k, at] of told) if (now - at >= REPEAT_MS) told.delete(k);
	const key = `${w.id}|${m.target}`;
	if (told.has(key)) return false;
	told.set(key, now);
	d.post(m.target, msg().authWaitNotice(waitWhat(w), untilText(w.expiresAt)), m.replyTo);
	return true;
}

/** What the asking conversation hears when a request opens: where the form is and that "취소" closes it. */
export function openedText(w: AuthWait, link: string | undefined): string {
	const m = msg();
	return m.authOpenNotice(waitWhat(w), untilText(w.expiresAt), link ? m.authOpenWhereLink(link) : m.authOpenWhereApp);
}
