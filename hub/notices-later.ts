import { now, TZ } from "./config.ts";
import { msg } from "./i18n.ts";
import { settleExpiredQuestions } from "./notices-answers.ts";
import { expiresAtOf, plainCard } from "./notices-decisions.ts";
import { sweepJudging } from "./notices-judging.ts";
import { broadcast } from "./notices-read.ts";
import { isOpenDecision, twinOf } from "./notices-rules.ts";
import { items, save, unreadCount } from "./notices-store.ts";
import { tellAsker } from "./notices-tell.ts";
import type { Notice } from "./notices-types.ts";
import { decisionHooks, halfHooks } from "./notices-wiring.ts";

/** What 자세히 / 나중에 answer: the card as it is now, or why nothing changed. */
export type CardReply = { status: 200; body: { ok: true; item: Notice } } | { status: 400 | 404 | 409 | 502; body: { error: string } };
type Refused = Exclude<CardReply, { status: 200 }>;
type Waiting = { item: Notice } | { refused: Refused };

function waitingCard(id: unknown): Waiting {
	const item = items.find(i => i.id === String(id));
	if (!item?.decision) return { refused: { status: 404, body: { error: "unknown notice" } } };
	if (!plainCard(item.decision)) return { refused: { status: 400, body: { error: "unknown option" } } };
	if (!isOpenDecision(item)) return { refused: { status: 409, body: { error: "not waiting" } } };
	return { item };
}

function announce(list: Notice[], at: string): void {
	if (!list.length) return;
	save();
	const unread = unreadCount();
	for (const n of list) broadcast({ ts: at, kind: "notice", source: "gateway", item: n, unread });
}

/** The owner's 자세히 알려 주세요 on an open card: its asker is asked once (`ask` starts its turn, and throws when it could not be reached) to post the card again with before → after; the card stays open and takes `more_at` only once the ask was delivered, so a failed ask answers 502 and the button works again. */
export function moreNotice(id: unknown, ask: (to: string, text: string) => void): CardReply {
	const w = waitingCard(id);
	if ("refused" in w) return w.refused;
	const { item } = w, d = item.decision!;
	if (d.more_at) return { status: 200, body: { ok: true, item } };
	try {
		ask(d.to, msg().asker.more(item.title));
	} catch {
		return { status: 502, body: { error: msg().asker.moreFailed } };
	}
	const at = now();
	d.more_at = at;
	announce([item], at);
	return { status: 200, body: { ok: true, item } };
}

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** HH:MM of `ms` on the owner's clock. */
export const clockText = (ms: number): string => clock.format(ms);
const MORNING_HOUR = 8;
const DAY_MINUTES = 24 * 60;
/** The next 08:00 on the owner's clock after `fromMs` (a whole minute). */
export function nextMorning(fromMs: number): number {
	const [h = 0, m = 0] = clockText(fromMs).split(":").map(Number);
	const ahead = (MORNING_HOUR * 60 - (h * 60 + m) + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES;
	return Math.floor(fromMs / 60_000) * 60_000 + ahead * 60_000;
}
const HOUR_MS = 3_600_000;
export const LATER_FOR = ["hour", "morning"] as const;

/** The owner's 나중에 on an open card: read and off the open lists until `later_until` (an hour from now, or the next 08:00), its asker told not to wait. A card whose
 * answer time would end before then gets a full answer window from `later_until`. */
export function laterNotice(id: unknown, body: { for?: unknown }): CardReply {
	const span = LATER_FOR.find(f => f === body.for);
	if (!span) return { status: 400, body: { error: "for must be hour or morning" } };
	const w = waitingCard(id);
	if ("refused" in w) return w.refused;
	const { item } = w, d = item.decision!, at = now();
	const until = span === "hour" ? Date.parse(at) + HOUR_MS : nextMorning(Date.parse(at));
	d.later_until = new Date(until).toISOString();
	if (d.expires_at && d.expires_at <= d.later_until) {
		const exp = expiresAtOf({ to: d.to, ...(item.by ? { by: item.by } : {}) }, d.later_until);
		if (exp) d.expires_at = exp;
		delete d.half_told;
	}
	item.read = true;
	const twins = items.filter(n => twinOf(item, n) && !n.read);
	for (const n of twins) n.read = true;
	tellAsker(item, msg().asker.later(item.title, clockText(until)));
	announce([item, ...twins], at);
	return { status: 200, body: { ok: true, item } };
}

/**
 * The open card a Discord card with `question` in conversation `conv` stands for: the one of that title, else one whose title holds it or is held in it; none
 * when no open card matches (the card closed). Cards that have an id may share a title: of several, the one whose own lines are all in `shown`, the text of
 * the Discord message, else the oldest.
 */
export function cardAsked(conv: string, question: string, shown = ""): string | undefined {
	const open = items.filter(n => isOpenDecision(n) && plainCard(n.decision!) && n.decision!.to === conv), same = open.filter(n => n.title === question);
	const own = same.length > 1 ? same.find(n => !!n.decision!.evidence?.length && n.decision!.evidence.every(l => shown.includes(l))) : undefined;
	return (own ?? same[0] ?? open.find(n => !!question && (question.includes(n.title) || n.title.includes(question))))?.id;
}

function pastHalf(n: Notice, at: string): boolean {
	const d = n.decision!, from = Date.parse(at);
	const span = Date.parse(expiresAtOf({ to: d.to, ...(n.by ? { by: n.by } : {}) }, at) ?? at) - from;
	return !!d.expires_at && Date.parse(d.expires_at) - from <= span / 2;
}

function remindHalfTime(at: string): Notice[] {
	const hit = items.filter(n => isOpenDecision(n) && plainCard(n.decision!) && !n.decision!.half_told && !n.decision!.later_until && pastHalf(n, at));
	for (const n of hit) n.decision!.half_told = true;
	announce(hit, at);
	for (const n of hit) for (const fn of halfHooks) fn(n);
	return hit;
}

function wakeLater(at: string): Notice[] {
	const hit = items.filter(n => isOpenDecision(n) && n.decision!.later_until && n.decision!.later_until <= at);
	for (const n of hit) {
		delete n.decision!.later_until;
		n.read = false;
		if (pastHalf(n, at)) n.decision!.half_told = true;
	}
	announce(hit, at);
	for (const n of hit) for (const fn of decisionHooks) fn(n);
	return hit;
}

/** The periodic pass over the questions (hub/main.ts settleSweep): expiry, the half-time reminder, the cards put off whose time came, judging that never settled. Returns how many expired. */
export function sweepQuestions(at = now()): number {
	const expired = settleExpiredQuestions(at);
	remindHalfTime(at);
	wakeLater(at);
	sweepJudging(at);
	return expired;
}
