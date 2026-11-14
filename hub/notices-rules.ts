// Limits and the plain questions asked of one notice (open, waiting, expired, who raised it). A part of the notice store split out of hub/notices.ts, code unchanged.
import { now } from "./config.ts";
import type { HubEvent } from "./events.ts";
import { classOfNotice, isLoginLost } from "./notice-class.ts";
import { readOf } from "./reads.ts";
import { orchestratorOnlyAsk } from "./forline.ts";
import { dropClaim, parseTone, stripHandoff } from "./tone.ts";
import type { Decision, Notice, NoticeTone } from "./notices-types.ts";
import type { ClosedCard } from "./notices-wiring.ts";
import { addressesIn, blockDraftRef, DRAFT_BODY_MAX, type DraftApproval } from "./draft-approval.ts";
import { storedDraftOf } from "./notices-wiring.ts";

export const NOTICE_CAP = 300;
export const TEXT_MAX = 1500;
export const LOUD = new Set<NoticeTone>(["done", "fail", "ask"]);
export const RESTART_PREFIX = /^게이트웨이(?: 재시작했어요|를 다시 시작했어요|가 다시 시작돼서)/;

// A question whose time is up is no longer open on any surface, even before the sweep reaches it (settleExpiredQuestions): the badge,
// 답변 필요, push re-asks and the approval queue all read this one check. Stored times are the hub's clock (now()), compared as ISO strings.
export const hasExpired = (d: Decision | undefined, nowIso = now()): boolean => !!d?.expires_at && d.expires_at <= nowIso;
// The 감시 소식 feed stays small: each watch keeps its newest WATCH_KEEP reports and none older than WATCH_DAYS, dropped when a report is written and
// when the file loads, so notices.json and the payload never grow with the age of the install. An open decision is never dropped.
export const WATCH_KEEP = 50;
export const WATCH_DAYS = 7;
type Aged = { kind: string; title: string; updated: string; decision?: { state: string } };
export function keepWatchNewest<T extends Aged>(list: T[], nowMs: number): T[] {
	const cutoff = new Date(nowMs - WATCH_DAYS * 86_400_000).toISOString();
	const counts = new Map<string, number>();
	const drop = new Set<T>();
	for (const i of list.filter(n => n.kind === "watch").sort((x, y) => y.updated.localeCompare(x.updated))) {
		const n = (counts.get(i.title) ?? 0) + 1;
		counts.set(i.title, n);
		if ((n > WATCH_KEEP || i.updated < cutoff) && i.decision?.state !== "open") drop.add(i);
	}
	return drop.size ? list.filter(i => !drop.has(i)) : list;
}
export const isOpenDecision = (i: Notice) => i.decision?.state === "open" && !hasExpired(i.decision);
// Every notice the pages get carries its class (hub/notice-class.ts), computed as it goes out: the bell's tabs and badge read it, nothing stored changes.
// `waits` is derived, never stored: a failure or lost login that is still the owner's to deal with (see Notice.handled).
export type Waits = "fail" | "login";
export const waitKind = (n: Notice): Waits | undefined => {
	const { cls } = classOfNotice(n);
	if (cls === "ask" || cls === "log" || cls === "conv") return undefined;
	return isLoginLost(n) ? "login" : n.tone === "fail" ? "fail" : undefined;
};
export const waitsOf = (n: Notice): Waits | undefined => (n.dismissed || typeof n.handled === "string" || (n.handled !== null && n.read) ? undefined : waitKind(n));
// A notice that waits on the owner's action: an open decision, or an [ask] item (the alert / message twin of one). Looking at it, anywhere, never
// reads it; only an answer, a resolving signal (resolveAsks) or the owner's x (ignoreNotice) takes it off. Every other notice clears on view.
export const needsAnswer = (i: Notice) => !i.read && !i.dismissed && !i.ignored && !hasExpired(i.decision) && (isOpenDecision(i) || i.tone === "ask");
export const twinOf = (d: Notice, n: Notice) => !n.decision && n.tone === "ask" && (n.at === d.decision?.reply_to || n.text === d.text);

export const REPEATS_MAX = 20;
export const REPEAT_TEXT = 160;
export const FOLD_MS = 24 * 3_600_000;

// The read position (reads.json, one per conversation, shared by every device) is the source of truth for "seen": a conversation's unread answer
// (kind message) whose source message it covers is read. Every other notice is read by the owner's tap, ✕ or read-all, not by looking at a chat.
export function coveredByRead(i: Notice): boolean {
	if (i.kind !== "message" || i.dismissed || needsAnswer(i)) return false;
	const seen = readOf(i.src ?? i.open);
	return !!seen && seen >= (i.at ?? i.ts);
}

export const clean = (raw: unknown) => {
	const p = parseTone(stripHandoff(String(raw ?? "")));
	return { tone: (p.tone ?? "") as NoticeTone, text: dropClaim(p.text.trim()).slice(0, TEXT_MAX) };
};

// Gateway jobs that post on their own get their own title; everything else is a plain worklog / alert entry.
export function systemTitle(text: string, fallback: string): string {
	if (/^토큰 (누수 )?점검/.test(text)) return "토큰 점검";
	if (text.includes("야간 정리")) return "야간 정리";
	if (/^(닥터 점검|Doctor check)/.test(text)) return "닥터 점검";
	return fallback;
}

// A session's [ask] that only hands a chore to the orchestrator is a plain report (forline.ts), not a question for the owner.
export const laneTone = (e: HubEvent, tone: NoticeTone, text: string): NoticeTone =>
	tone === "ask" && (e.kind === "lane_report" || String(e.source ?? "").startsWith("lane:") || String(e.update_key ?? "").startsWith("lane:")) && orchestratorOnlyAsk(text) ? "" : tone;

export const MESSAGE_PREVIEW = 120;
/* ---------- decisions: every question that waits on the owner is its own pinned notice ---------- */
// Created from an [ask] of the assistant or a session (one notice per "결정:" block of the message, one for a plain question), a
// login request (authRequested) or a budget question. Stays unread and cannot be dismissed until answered: by a button
// (answerDecision), by the owner replying in that chat or session (ownerReplied), or by the login request finishing.
export const REASK_MS = 30 * 60_000;
// How long a question waits on the owner before its own state closes it (settleExpiredQuestions): a plain or choice question 72 h, the
// gateway's alert question 24 h. A send-approval card (its draft being handled) and a login request (the request finishing) carry no expiry.
export const ANSWER_WINDOW_MS = 72 * 3_600_000;
export const ALERT_ANSWER_WINDOW_MS = 24 * 3_600_000;
export const closedInfo = (n: Notice, how: ClosedCard["how"]): ClosedCard | undefined => {
	const d = n.decision;
	return d?.draft ? { text: n.text, how, label: d.answer ?? "", ...(d.card ?? {}) } : undefined;
};
// A send-approval card the gateway could not read as its draft (2026-11-14, issue #7): its 보내기 / 고치기 / 보내지 않기 question ends in "(<ref>)",
// yet no draft was read from it (the bot re-worded the card, or put two cards in one message). Its 보내기 would send the draft by that ref while the
// owner saw other words, so it closes at once and its session is told to post the card again as the draft printed it (repostNote).
export const unreadDraftRef = (i: Notice): string | undefined => (i.decision && !i.decision.draft ? blockDraftRef(i.title, i.decision.options.map(o => o.label)) : undefined);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const sameAddresses = (a: string, b: string) => addressesIn(a).sort().join() === addressesIn(b).sort().join();
// The gateway reads a card's body up to DRAFT_BODY_MAX characters (draft-approval.ts parseDraftLines): a card read that far shows a longer draft's start.
const sameBody = (real: string, shown: string) => (shown.length < DRAFT_BODY_MAX ? flat(real) === flat(shown) : flat(real).startsWith(flat(shown)));
// Whether a card shows its stored draft as is: the same body and, when the card shows an address, the stored draft's addresses.
export function shownAsStored(draft: DraftApproval): boolean {
	const real = draft.ref ? storedDraftOf(draft.ref) : undefined;
	return !real || (sameBody(real.body, draft.body) && (!addressesIn(draft.to).length || sameAddresses(real.to, draft.to)));
}
export function repostNote(i: Notice): string | undefined {
	const ref = unreadDraftRef(i);
	if (!ref) return undefined;
	return `[dotz gateway] Your send-approval card "${i.title}" was not read as draft (${ref}): its words differ from the card the draft printed, or it shares a message with another card. The owner approves only the draft he sees, so it was closed and cannot be sent. Post the card again exactly as the draft output printed it, one card per message: the same recipient line, the full body and the same question. Do not shorten, re-word or merge it.`;
}
export const refOf = (e: HubEvent): string | undefined => (typeof e.reply_to === "string" && e.reply_to ? e.reply_to : undefined);
export const hasChoice = (i: Notice) => !!i.decision && i.decision.options.length > 0 && !i.decision.assumed;
// Whether a typed message answers a decision that has real options: it points at an option's number ("2", "2)", "2번", "1번으로 해", "1로 하자",
// "ㄱㄱ 1로", "1-1") or is the option's label (alone, or followed by a comma / full stop). A number counts only as its own word (or with 번 / 로 /
// ) attached), never inside a time, count or date ("3시에", "10분 뒤에", "2026-11-10"). Anything else is another subject, so the decision stays open.
const NUMBER_REF = /(?<![\d.,:/-])(\d+)(?:\s*-\s*(\d+))?(?=번|으로|로|이요|요|\)|\]|\.(?!\d)|[,!?~]|\s+(?![시분초일월년개명원통건회%])|$)/gu;
const bare = (s: string) => s.replace(/\s*…\s*$/, "").trim().toLowerCase();
export function answersOption(options: { n: number; label: string; say?: string }[], text: string): boolean {
	const t = text.trim().toLowerCase();
	for (const m of t.matchAll(NUMBER_REF)) if (options.some(o => o.n === Number(m[1]) || (m[2] !== undefined && o.n === Number(m[2])))) return true;
	return options.some(o => [o.label, o.say ?? ""].some(w => bare(w) && (t === bare(w) || (t.startsWith(bare(w)) && /^[,.!~)]/.test(t.slice(bare(w).length))))));
}

export function authorOf(e: HubEvent): string | undefined {
	if (e.kind === "lane_report") return typeof e.lane === "string" && e.lane ? `lane:${e.lane}` : undefined;
	if (e.kind !== "out") return undefined;
	const src = String(e.source ?? "");
	return src.startsWith("lane:") || src === "orchestrator" || src === "gateway" ? src : undefined;
}
// Older items carry no `by`: a session's question shows in its decision target or lane key.
export const originOf = (i: Notice): string | undefined => i.by ?? (i.decision?.to.startsWith("lane:") ? i.decision.to : i.key?.startsWith("lane:") ? i.key : undefined);
export const isAsking = (i: Notice) => !i.dismissed && !i.decision?.to.startsWith("auth:") && (isOpenDecision(i) || (i.tone === "ask" && !i.read));

export const BACKFILL_DAYS = 7;
export const DAY_MS = 86_400_000;
