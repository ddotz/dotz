// What one session hands to another (dotz_conv send, the handback of handed work): the record the receiving conversation shows, and the
// rules that keep that traffic from being taken for an answer to the owner.
import { now } from "./config.ts";
import { emit } from "./events.ts";
import type { Prompt, WorkLink, WorkRow } from "./prompts-model.ts";

const LOUD = /^\s*\[(?:ask|fail)\]/i;

/** The handed text as an event of the receiving conversation: the web draws one collapsed row, a messenger gets no post. */
export function recordHanded(h: { to: string; from: string; text: string; handback?: boolean }): void {
	emit("inbox", { ts: now(), kind: "handed", source: "session", channel: h.to, from: h.from, text: h.text, ...(h.handback ? { handback: true } : {}) });
}

/** An answer to handed text is stored and shown but notifies no one, unless it opens [ask] or [fail] or an owner message still waits behind it. */
export const hushedAnswer = (p: { handback?: true; bookkeeping?: true; replyTo?: string }, text: string, ownerWaits: (id: string) => boolean): { hushed: true } | undefined =>
	(p.handback || p.bookkeeping) && !LOUD.test(text) && !(p.replyTo !== undefined && ownerWaits(p.replyTo)) ? { hushed: true } : undefined;

/** The workers a request still waits on: each once, none whose result was taken or that already finished. */
export const waitedOn = (links: readonly WorkLink[], work: readonly WorkRow[]): WorkLink[] => [
	...new Map(links.filter(l => !l.delivered && !l.cancelled && !work.some(w => w.id === l.id && (w.status === "done" || w.status === "failed"))).map(l => [l.id, l])).values(),
];

/** A handback went out: the deferred requests handed by the same session for the same message, with no worker left to wait on, are done. True when one was closed. */
export function closeHanded(open: readonly Prompt[], p: Prompt, linksOf: (p: Prompt) => WorkLink[], work: readonly WorkRow[]): boolean {
	const closing = open.filter(d => d !== p && d.from === p.from && d.target === p.target && d.replyTo === p.replyTo && !waitedOn(linksOf(d), work).length);
	for (const d of closing) d.done = true;
	return closing.length > 0;
}

/**
 * An answer with no message id in `p`'s conversation: the id-less requests there, older than its prompt, that it settles. A provider-error
 * stop closes on the reminder's answer (`nudge`) once no worker of its own is pending; a request deferred to workers closes once none of
 * them still runs, on the reminder's answer or on the answer to a note naming one of them (the failure handover).
 */
export function closeIdless(open: readonly Prompt[], p: Prompt, linksOf: (p: Prompt) => WorkLink[], work: readonly WorkRow[], nudge: boolean): void {
	const runs = new Set(work.filter(w => w.status === "running" || w.status === "stalled").map(w => w.id));
	for (const d of open) {
		if (d.target !== p.target || d.replyTo || d.at > p.at) continue;
		const ls = linksOf(d).filter(l => !l.delivered && !l.cancelled);
		if (d.retry ? nudge && !ls.length : ls.length > 0 && !ls.some(l => runs.has(l.id)) && (nudge || ls.some(l => p.text.includes(l.id)))) d.done = true;
	}
}
