// While a conversation's session waits on a dotz_auth request (the tool holds its turn until the owner answers in the web app or
// on Discord), owner messages to that conversation only queue behind the wait. The gateway answers each one itself, with no model
// call: what is awaited and until when, and that the message is handled after. A bare "취소" from the owner closes the request,
// the same as DELETE /api/auth/<id>. Owner report 2026-11-05: four JANDI messages got no answer for ten minutes while the main
// session waited on a login form shown in the web app only.
import { TZ, tzLabel } from "./config.ts";
import { msg } from "./i18n.ts";
import type { AuthWait } from "./auth.ts";

export type WaitDeps = {
	pending(): AuthWait[];
	/** Whether two targets are answered by the same session (hub/convsessions.ts keyOf). */
	sameSession(a: string, b: string): boolean;
	cancel(id: string): boolean;
	post(target: string, text: string, replyTo?: string): void;
};
/** One owner message (or burst) as it reaches hub/intake.ts flush; `owner` is false for anything not the owner's. */
export type Inbound = { target: string; text: string; owner: boolean; replyTo?: string };

const CANCEL = /^\s*(취소|cancel)\s*[.!]?\s*$/i;
const PURPOSE_MAX = 80;
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export const untilText = (ms: number): string => `${clock.format(ms)} ${tzLabel()}`;
export function waitWhat(w: AuthWait): string {
	const p = w.purpose.replace(/\s+/g, " ").trim() || w.site;
	return p.length > PURPOSE_MAX ? `${p.slice(0, PURPOSE_MAX - 1)}…` : p;
}

// A lane's request waits in that lane's own step, not in a conversation's turn.
const waitsFor = (target: string, d: WaitDeps): AuthWait[] =>
	target.startsWith("lane:") ? [] : d.pending().filter(w => !w.target.startsWith("lane:") && d.sameSession(w.target, target)).sort((a, b) => a.expiresAt - b.expiresAt);

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
	if (!m.owner) return false;
	const w = waitsFor(m.target, d)[0];
	if (!w) return false;
	d.post(m.target, msg().authWaitNotice(waitWhat(w), untilText(w.expiresAt)), m.replyTo);
	return true;
}

/** What the asking conversation hears when a request opens: where the form is and that "취소" closes it. */
export function openedText(w: AuthWait, link: string | undefined): string {
	const m = msg();
	return m.authOpenNotice(waitWhat(w), untilText(w.expiresAt), link ? m.authOpenWhereLink(link) : m.authOpenWhereApp);
}
