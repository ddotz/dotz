// Send-approval cards: staged files, recipients, Discord post, the settle pass. A part of the notice store split out of hub/notices.ts, code unchanged.
import { createHash } from "node:crypto";
import { log, now } from "./config.ts";
import { parseDecisions } from "./choices.ts";
import { ATTACH_REFUSED, blockDraftRef, type DraftApproval, type DraftFileIn, parseDraftApproval, refreshDraft, rewriteDraftTo, sameDraft, withAttachIssues, withStagedFiles } from "./draft-approval.ts";
import { policyOf } from "./reply-reasons.ts";
import type { ReasonCode } from "./reply-types.ts";
import { parseTone, stripHandoff } from "./tone.ts";
import type { Decision, DecisionOpt, Notice } from "./notices-types.ts";
import { appLabelOf, appOf, type ClosedCard, draftHandled } from "./notices-wiring.ts";
import { TEXT_MAX, closedInfo, isOpenDecision } from "./notices-rules.ts";
import { items, save, settleDecision } from "./notices-store.ts";
import { refreshNoticeDrafts, retitleDraftCard } from "./notices-stored.ts";
import { announce, reopenNotices } from "./notices-answers.ts";

// An open send-approval card shows the files staged for its draft now, not the ones staged when it was posted: a file attached later
// (첨부 API, draft.ts revise, a rule or the 첨부 파일 폴더) rewrites its `> 첨부:` rows and the "no file" warning goes, without asking again
// (owner 2026-11-02). `filesOf(id)`: the files staged for a pending draft, undefined when dotz does not stage that draft's files.
// The reply part is its card ref, the 함께 보낼 메일 part its own id. Returns the cards that changed.
// `issuesOf(id)`: where that draft's words and files disagree (flow.ts draftAttachIssues), undefined when it is not a draft of dotz: the card's
// `첨부 확인` line and its 4th option follow it the same way (an open card may be answered 이대로 보내기 only while it carries them).
function optionsOf(old: DecisionOpt[], text: string): DecisionOpt[] {
	const blocks = parseDecisions(text).blocks;
	return blocks.length === 1 ? blocks[0]!.options.map(o => ({ ...old.find(x => x.label === o.label), ...o })) : old;
}
export function refreshDraftFiles(list: Notice[], filesOf: (id: string) => DraftFileIn[] | undefined, issuesOf?: (id: string) => string[] | undefined): Notice[] {
	const hit: Notice[] = [];
	for (const it of list) {
		const d = it.decision?.draft;
		if (!d?.ref || !isOpenDecision(it)) continue;
		const main = filesOf(d.ref);
		let text = main ? withStagedFiles(it.text, main) : it.text;
		const mail = d.mail?.ref ? filesOf(d.mail.ref) : undefined;
		if (mail) text = withStagedFiles(text, mail, "mail");
		const found = [issuesOf?.(d.ref), d.mail?.ref ? issuesOf?.(d.mail.ref) : undefined];
		const before = text;
		if (found.some(x => x !== undefined)) text = withAttachIssues(text, found.flatMap(x => x ?? []));
		if (text === it.text) continue;
		if (text !== before) it.decision!.options = optionsOf(it.decision!.options, text);
		it.text = text;
		it.decision!.draft = refreshDraft(d, text);
		hit.push(it);
	}
	return hit;
}
// A card whose words changed this way is out on Discord as it was: outbound.ts edits it there, buttons included.
const refreshedHooks: ((n: Notice) => void)[] = [];
export const onDraftCardRefreshed = (fn: (n: Notice) => void): void => void refreshedHooks.push(fn);
// A draft as its store holds it now (hub/reply-wire.ts wires the reply flow's): its approval fingerprint and the card text drawn from it. A card
// keeps that fingerprint (Decision.hash) only while it shows that very draft (sameDraft); a card showing anything else (a store changed outside
// the hub, a hand-written text) keeps none, so its next 보내기 is refused `changed` and the card drawn anew from the store (hub/reply-actions.ts).
let fingerprint: (ref: string) => Promise<{ hash: string; text?: string } | undefined> = async () => undefined;
export const setCardFingerprint = (fn: typeof fingerprint): void => void (fingerprint = fn);
const cardBody = (text: string): string => parseTone(stripHandoff(text)).text.trim();
// The latest stamp started on each card: only its read is kept, so an earlier read that answers later never undoes a newer one.
const stamping = new WeakMap<Notice, number>();
function stamp(hit: Notice[]): Promise<void> {
	const runs: Promise<void>[] = [];
	for (const n of hit) {
		const shown = n.decision?.draft, ref = shown?.ref, text = n.text;
		if (!ref) continue;
		const turn = (stamping.get(n) ?? 0) + 1;
		stamping.set(n, turn);
		const run = fingerprint(ref).then(
			now => {
				// Drawn again or stamped again meanwhile: that drawing or stamp keeps its own fingerprint.
				if (stamping.get(n) !== turn || n.text !== text || n.decision?.draft?.ref !== ref) return;
				const store = now?.text ? parseDraftApproval(cardBody(now.text)) : undefined;
				const h = store && sameDraft(store, shown) ? now!.hash : undefined;
				if (n.decision.hash === h) return;
				if (h) n.decision.hash = h;
				else delete n.decision.hash;
				save();
			},
			e => log(`card hash of ${ref} not read: ${(e as Error).message}`),
		);
		runs.push(run);
	}
	return Promise.all(runs).then(() => undefined);
}
const redrawn = (hit: Notice[]): void => {
	for (const n of hit) for (const fn of refreshedHooks) fn(n);
	void stamp(hit);
};
export function syncDraftFiles(filesOf: (id: string) => DraftFileIn[] | undefined, issuesOf?: (id: string) => string[] | undefined): number {
	const hit = refreshDraftFiles(items, filesOf, issuesOf);
	if (hit.length) announce(hit, now());
	redrawn(hit);
	return hit.length;
}
/** The newest open card of draft `ref` in `to` went to Discord as these messages. */
export function markDraftPosted(to: string, ref: string, target: string, ids: string[]): void {
	const n = items.findLast(i => isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref === ref);
	if (!n || !ids.length) return;
	n.decision!.card = { target, ids, shows: digest(n.text) };
	save();
	void stamp([n]);
}
// What a card's Discord message shows: the digest of the card text it was last posted or edited with (hub/outbound.ts, on success only).
const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** The Discord message of the open card of draft `ref` in `to` was edited to show `text` (the card's text then). */
export function markCardShown(to: string, ref: string, text: string): void {
	const card = items.findLast(i => isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref === ref)?.decision!.card;
	if (!card) return;
	card.shows = digest(text);
	save();
}
// The version a card's Discord message shows: the card's own while that message shows the card's text, else none (a long card cut into several
// messages, a [file] line, a failed edit keep the old text there; a pick from it is refused, hub/approval-wire.ts).
const discordHash = (i: Notice): string | undefined => (i.decision!.card?.shows && i.decision!.card.shows === digest(i.text) ? i.decision!.hash : undefined);
/** A draft's card just opened (notice `id`, hub/reply-wire.ts): it keeps the version it shows, when that is the store's. */
export const stampDraftCard = (id: string): Promise<void> => stamp(items.filter(i => i.id === id && isOpenDecision(i)));
export const openDraftRefs = (to: string): string[] => items.flatMap(i => (isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref ? [i.decision!.draft.ref] : []));
/** The open send-approval cards (of one conversation, or all): notice id, conversation, draft ref, question and draft (hub/approval-wire.ts);
 * `hash`: the version the card shows, `discord`: the one its Discord message shows; `asked`: the ts of the post that asked it, `posts`: its Discord message ids;
 * `shown`: when the card was last drawn as it reads now. */
export const openDraftCards = (to?: string): { id: string; to: string; ref: string; title: string; draft: DraftApproval; at: string; shown: string; text: string; hash?: string; discord?: string; asked?: string; posts?: string[] }[] =>
	items.flatMap(i => (isOpenDecision(i) && (to === undefined || i.decision!.to === to) && i.decision!.draft?.ref ? [{ id: i.id, to: i.decision!.to, ref: i.decision!.draft.ref, title: i.title, draft: i.decision!.draft, at: i.at ?? i.ts, shown: i.updated, text: i.text, ...(i.decision!.hash ? { hash: i.decision!.hash } : {}), ...(discordHash(i) ? { discord: discordHash(i) } : {}), ...(i.decision!.reply_to ? { asked: i.decision!.reply_to } : {}), ...(i.decision!.card?.ids.length ? { posts: i.decision!.card.ids } : {}) }] : []));
/** The newest card of draft `ref`, open or answered, in the order the cards were made (not the screen's order, which lists open and unread ones first). */
export const newestDraftCard = (ref: string): Notice | undefined => items.findLast(i => i.decision && (openDraftRef(i) === ref || i.title.endsWith(`(${ref})`)));
/** The newest card of draft `ref` in `to` the owner already answered, as it closed, with the Discord message it was posted as (undefined: none, or never on Discord). */
export function answeredDraftCard(to: string, ref: string): (ClosedCard & { target: string; ids: string[] }) | undefined {
	const n = items.findLast(i => i.decision?.state === "answered" && i.decision.to === to && openDraftRef(i) === ref);
	const c = n && closedInfo(n, n.decision!.resolved ? "resolved" : "answered");
	return c?.target && c.ids?.length ? { ...c, target: c.target, ids: c.ids } : undefined;
}
/** The newest card of draft `ref` in `to` shows how the gateway's send of it went. */
export function markDraftSend(to: string, ref: string, state: NonNullable<Decision["send"]>["state"], text = "", until?: number, code?: ReasonCode): void {
	const n = items.findLast(i => i.decision?.to === to && openDraftRef(i) === ref) ?? newestDraftCard(ref);
	if (!n) return;
	const at = now();
	const prev = n.decision!.send;
	const attempts = state === "queued" && prev?.state === "failed" ? (prev.attempts ?? 1) + 1 : prev?.attempts;
	n.decision!.send = { state, ...(text ? { text: text.slice(0, 300) } : {}), at, ...(attempts ? { attempts } : {}), ...(until ? { until } : {}) };
	// A send refused for its files leaves the draft pending: its card opens again with the reason, so it can be answered (이대로 보내기) or the files fixed.
	// A send taken back (cancelled in its window, or the gateway restarted in it) leaves the draft pending: the card opens again with the reason, once, on the card.
	const refused = state === "failed" && (code ? policyOf(code).reopen === true : text.startsWith(ATTACH_REFUSED));
	if ((refused || state === "back") && n.decision!.state !== "open") reopenNotices([n.id], `${state}:${code ?? text}`);
	else announce([n], at);
}
// The bot posted the open card of draft `ref` again with changes (or the queue changed its "남은 N건" line): the open card shows the new text in place.
export const openDraftText = (to: string, ref: string): string | undefined => items.find(i => isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref === ref)?.text;
export function rewriteOpenDraft(to: string, ref: string, text: string): number {
	const hit = items.filter(i => isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref === ref);
	rewriteCards(hit, text);
	void stamp(hit);
	return hit.length;
}
/** The reply flow changed draft `ref` (an edit, or a revise into `newRef`; the reply unification design, 3.5): every open card of it, in any
 * conversation, shows the new text, draft and title, keeps its id (the bell row, the queue row and the chat card stay one object) and stores
 * `hash`, the version it now shows; a card out on Discord is edited there, buttons included. */
export function redrawDraftCards(ref: string, text: string, hash: string | undefined, newRef?: string): number {
	const hit = items.filter(i => isOpenDecision(i) && i.decision!.draft?.ref === ref);
	for (const n of hit) {
		if (hash) n.decision!.hash = hash;
		else delete n.decision!.hash;
	}
	rewriteCards(hit, text, newRef);
	for (const n of hit) for (const fn of refreshedHooks) fn(n);
	return hit.length;
}
/** A confirm card (the reply intent design, 4.3): the open card of draft `ref` is to be posted again at the bottom of its conversation. Its notice keeps
 * its id (bell, queue row and chat card stay one object), takes `text` and `hash` when given and forgets its old Discord place until the new post
 * lands (hub/outbound.ts markDraftPosted); the post carries `repost: <id>`, so the notice adopts it (notices-store.ts) instead of a second one being made.
 * Returns what to post, where, and where the old card was; undefined when no card of `ref` is open. */
export function repostDraftCard(ref: string, text: string | undefined, hash: string | undefined): { id: string; to: string; text: string; card?: { target: string; ids: string[] } } | undefined {
	const n = items.findLast(i => isOpenDecision(i) && i.decision!.draft?.ref === ref);
	if (!n) return undefined;
	const card = n.decision!.card;
	if (text) rewriteCards([n], text);
	if (hash) n.decision!.hash = hash;
	delete n.decision!.card;
	save();
	return { id: n.id, to: n.decision!.to, text: text ?? `[ask] ${n.text}`, ...(card ? { card } : {}) };
}
/** A hand-written card revised (hub/approval-queue.ts): the open card of `ref` in `to` becomes the card `text` shows (text, draft, ref and its question as the title)
 * and keeps its id, and forgets its old Discord place until the new post lands (hub/outbound.ts markDraftPosted); the post carries `repost: <id>`, so the notice
 * adopts it (notices-store.ts) instead of a second one being made. Returns the notice, the text it showed and where it was out; undefined when no card of `ref` is open there. */
export function reviseDraftCard(to: string, ref: string, text: string): { id: string; was: string; card?: { target: string; ids: string[] } } | undefined {
	const n = items.findLast(i => isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref === ref);
	if (!n) return undefined;
	const was = n.text, card = n.decision!.card;
	const body = cardBody(text), question = parseDecisions(body).blocks[0]?.title, next = parseDraftApproval(body)?.ref;
	delete n.decision!.card;
	delete n.decision!.hash;
	if (question) n.title = question;
	rewriteCards([n], text, next !== ref ? next : undefined);
	return { id: n.id, was, ...(card ? { card: { target: card.target, ids: card.ids } } : {}) };
}
function rewriteCards(hit: Notice[], text: string, newRef?: string): number {
	if (!hit.length) return 0;
	const body = cardBody(text);
	const draft = parseDraftApproval(body);
	const at = now();
	for (const n of hit) {
		n.text = body.slice(0, TEXT_MAX);
		if (draft) n.decision!.draft = draft;
		// A new draft has no send yet: the old one's state stays with the old ref.
		if (newRef) delete n.decision!.send;
		retitleDraftCard(n);
		n.updated = at;
	}
	announce(hit, at);
	return hit.length;
}

const openDraftRef = (i: Notice): string | undefined => i.decision!.draft?.ref ?? blockDraftRef(i.title, i.decision!.options.map(o => o.label));
export type SendOwed = (ref: string) => Promise<boolean>;
let sendOwed: SendOwed = async () => false;
export const setSendOwed = (fn: SendOwed): SendOwed => {
	const was = sendOwed;
	sendOwed = fn;
	return was;
};
export async function settleHandledDrafts(at = now()): Promise<number> {
	const open = items.flatMap(i => {
		const ref = isOpenDecision(i) && !i.decision!.to.startsWith("auth:") ? openDraftRef(i) : undefined;
		return ref ? [{ i, ref }] : [];
	});
	const marked = items.flatMap(i => {
		const d = i.decision, state = d?.send?.state;
		const ref = d && d.state !== "open" && (state === "failed" || state === "unsure") && !d.to.startsWith("auth:") && typeof i.handled !== "string" && !i.dismissed ? openDraftRef(i) : undefined;
		return ref ? [{ i, ref }] : [];
	});
	const hit: Notice[] = [];
	for (const { i, ref } of open)
		if (await (async () => draftHandled(i.decision!, i, ref))().catch(() => false)) hit.push(i);
	const ended: Notice[] = [];
	for (const { i, ref } of marked)
		if ((await (async () => draftHandled(i.decision!, i, ref))().catch(() => false)) && !(await sendOwed(ref).catch(() => true))) ended.push(i);
	for (const i of hit) if (isOpenDecision(i)) settleDecision(i, "", at, true);
	for (const i of ended) {
		i.handled = at;
		i.read = true;
	}
	if (ended.length) announce(ended, at);
	return hit.length;
}
// The one-time card audit (hub/migrations.ts): the send-approval cards of this install, open or closed, and those still open.
const isDraftCard = (i: Notice) => !!i.decision && !i.decision.to.startsWith("auth:") && !!openDraftRef(i);
export const draftCardCounts = (): { all: number; open: number } => {
	const all = items.filter(isDraftCard);
	return { all: all.length, open: all.filter(isOpenDecision).length };
};
/** The re-read of the load, on the live cards: an open card's title follows its draft's ref, so its 보내기 passes the send gate, and a card
 * stored without the version it shows keeps it now, when it shows the store's. */
export function refreshStoredDrafts(at = now()): number {
	const n = refreshNoticeDrafts(items);
	void stamp(items.filter(i => isOpenDecision(i) && i.decision!.draft?.ref && !i.decision!.hash));
	if (n) announce(items.filter(i => isOpenDecision(i) && i.decision!.draft), at);
	return n;
}

// A draft sent or dropped from 모니터링 closes its card in the conversation at once, not at the next 30 s sweep: the apps announce every change
// of a draft or a send (the one reply flow's `reply`), so a burst of them runs one pass and at most one more after it.
export const DRAFT_CHANGED = new Set(["reply", "comment_send", "comment_draft", "kakao_send", "kakao_draft", "mail_unreplied"]);
let settling = false, settleAgain = false;
export function settleSoon(): void {
	if (settling) return void (settleAgain = true);
	settling = true;
	void settleHandledDrafts()
		.catch(e => log(`handled-draft settle failed: ${(e as Error).message}`))
		.finally(() => {
			settling = false;
			if (settleAgain) {
				settleAgain = false;
				settleSoon();
			}
		});
}
export const confirmNoun = (key: string) => (["mail", "kakao"].includes(key.split("-")[0]!) ? "답장 확인" : "댓글 답글");
export function confirmGroup(n: Notice): { key: string; label: string; count: number } | undefined {
	if (!isOpenDecision(n) || !n.decision!.draft) return undefined;
	const key = appOf(n);
	if (!key) return undefined;
	const count = items.filter(i => isOpenDecision(i) && i.decision!.draft && appOf(i) === key).length;
	return { key, label: `${appLabelOf(key)} ${confirmNoun(key)}`, count };
}

// The send approvals of drafts that wait again (답장 필요로 되돌리기 restored a held draft): a card that was settled as resolved (never answered
// by the owner) opens again in 확인 대기.
export function reopenDraftNotices(draftIds: string[]): { reopened: string[]; unread: number } {
	const want = new Set(draftIds);
	return reopenNotices(items.filter(i => i.decision?.draft?.ref && want.has(i.decision.draft.ref) && i.decision.state === "answered" && i.decision.resolved).map(i => i.id));
}

// The 받는 사람·참조 of a waiting mail draft changed (hub/draft-recipients.ts): every open card of that draft shows the new lines at once, on
// every page, and its stored text is rewritten so a restart reads the same card. Returns how many cards changed.
export function updateDraftRecipients(ref: string, r: { to: string; cc: string[]; mode?: "reply" | "all" }): number {
	const hit = items.filter(i => i.decision?.state === "open" && i.decision.draft?.ref === ref);
	if (!hit.length) return 0;
	const at = now();
	for (const n of hit) {
		const d = n.decision!;
		const next: DraftApproval = { ...d.draft!, to: r.to, ...(r.cc.length ? { cc: r.cc } : {}), ...(r.mode ? { mode: r.mode } : {}) };
		if (!r.cc.length) delete next.cc;
		d.draft = next;
		n.text = rewriteDraftTo(n.text, r.to, r.cc);
		n.updated = at;
	}
	announce(hit, at);
	redrawn(hit);
	return hit.length;
}
