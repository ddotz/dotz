// The real wiring of the one reply flow (the reply unification design, 1.2 and lane C1): the send queue with its job file, the three
// adapters (mail and webmail, comments, KakaoTalk), the owner's word in the inbox, the cards in the notices and the reply event. Every
// approval entry (the web's card answer, Discord's buttons, the triage list, /api/reply/*) reaches a reply through `replies` from here.
import { triggerFollowup } from "./followup.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, log, now, writeAtomic } from "./config.ts";
import { broadcast, emit } from "./events.ts";
import { approvals, cardMoved, newMid, out, showSendOnCard } from "./outbound.ts";
import { allNotices, markDraftSend, onDecision, openDraftCards, redrawDraftCards, repostDraftCard, setCardFingerprint, setStoredDraft, settleOpenDecision, stampDraftCard } from "./notices.ts";
import { settleSoon } from "./notices-drafts.ts";
import { commentPostedOf, commentProveSends, commentReply, commentSendOutcome, commentSettleSending, commentSettleStale } from "./comments/gateway.ts";
import { kakaoReply } from "./kakao/gateway.ts";
import { linkedComment } from "./comments/linked.ts";
import { isCommentPlace } from "./comments/reply-adapter.ts";
import { claimFile, getDraft, mailAdapter, replyLearning, unlessUnreadable } from "./reply-mail.ts";
import { mailByKey } from "./mail.ts";
import { claimHolder } from "./draft-claim.ts";
import { approvalHash, createApprovalSender, MAY_HAVE_GONE_OUT, refOfQuestion, runCli, type SendAction, type SendJob, type SendLook, type SendResult, type SendTarget } from "./approval-send.ts";
import { DRAFT_UNDO, draftActionOf, SEND_GATE } from "./draft-approval.ts";
import { askText, withRecipient } from "./draft-attach.ts";
import { createReplyActions, sendOf, setReplies } from "./reply-actions.ts";
import type { ReplyAdapter } from "./reply-types.ts";

const mail = mailAdapter(undefined, mailByKey);
const adapters: ReplyAdapter[] = [mail, commentReply, kakaoReply];
/** The adapter whose store holds `ref`. */
const adapterOf = (ref: string): ReplyAdapter | undefined => adapters.find(a => a.target(ref));
/** The approval fingerprint of draft `ref` as the first store that knows it holds it now (the queue's one gate reads it before every run). */
async function fingerprintOf(ref: string): Promise<string | undefined> {
	for (const a of adapters) {
		const view = await a.get(ref);
		if (view) return approvalHash(view);
	}
	return undefined;
}
// Every card drawn keeps the fingerprint of the version it shows, when that is the store's (hub/notices-drafts.ts): a pick from a card drawn before
// a change, or from one that never showed the store's version, is refused. The card text is drawn from the same store the fingerprint reads.
setCardFingerprint(async ref => {
	for (const a of adapters) {
		const view = await a.get(ref);
		if (view) return { hash: approvalHash(view), text: await a.ask(ref) };
	}
	return undefined;
});

// A mail send card must show its pending draft as stored, or it keeps no draft (hub/notices-rules.ts shownAsStored), with the recipient its send
// will use: an address-less one takes the mail's sender (flow.ts withRecipient).
setStoredDraft(ref => {
	const m = unlessUnreadable(() => getDraft(ref), undefined, line => log(`approval card ${ref}: its stored draft is not known (${line})`));
	if (m?.status !== "pending") return undefined;
	const r = withRecipient(m);
	return { to: r.to, body: r.body };
});

/** Where the gateway would send draft `ref`: a pending comment reply (per source), a pending mail draft (per sending account) or a KakaoTalk draft (one lane). */
export function sendTargetOf(ref: string, action?: SendAction): SendTarget | undefined {
	const c = commentReply.target(ref);
	if (c && action !== "send-mail") return c;
	// A posted reply whose mail is still owed: only the mail can go (comments.ts send --only mail), so no other action is answered.
	const p = commentPostedOf(ref);
	if (p?.mail && (!action || action === "send-mail") && getDraft(p.mail)?.status === "pending") return { kind: "comment", lane: `comment:${p.source}` };
	if (c) return c;
	const m = getDraft(ref);
	if (m && m.kind === "mail" && m.status === "pending" && !linkedComment(ref)) return { kind: "mail", lane: `mail:${m.source}:${m.account ?? m.app}` };
	return action === undefined || action === "send" ? kakaoReply.target(ref) : undefined;
}

// A conversation's gateway note goes where its cards were posted.
const targetOf = (conv: string, ref: string): string => approvals.targetOf(conv, ref) ?? (conv === "main" ? "web" : conv);
// A note about draft `ref` goes where its card was asked. One sent from the web's reply list that never had a card carries only its store's place
// (a comment's `comment:<source>`), which no surface delivers to ("unknown target comment:site-indi", 2026-11-15): its note goes to the main conversation.
const noteTarget = (conv: string, ref: string): string => {
	const card = allNotices().findLast(n => n.decision?.draft?.ref === ref)?.decision?.to;
	return card ? targetOf(card, ref) : isCommentPlace(conv) ? "web" : targetOf(conv, ref);
};
export const channelOf = (conv: string) => (conv === "main" ? "web" : conv);

// 답글만 보내기 posts the reply and leaves its mail draft on its own; the card is posted as the assistant would post it, judged from the stores.
function cardOwedMail(r: SendResult): void {
	const mailId = commentPostedOf(r.ref)?.mail;
	const m = mailId ? getDraft(mailId) : undefined;
	if (!mailId || m?.status !== "pending" || openDraftCards().some(c => c.ref === mailId)) return;
	void out(noteTarget(r.conv, mailId), askText(m, []), undefined, { source: "orchestrator" }).catch(e => log(`mail card for ${mailId} failed: ${e instanceof Error ? e.message : String(e)}`));
}

export const reportSend = (r: SendResult): void => {
	markDraftSend(r.conv, r.ref, r.state, r.text, r.until, r.reason?.code);
	showSendOnCard(r.conv, r.ref, r.state, r.text, r.until ? r.until - Date.now() : 0);
	const send = sendOf(r);
	broadcast({ ts: now(), kind: "reply", ref: r.ref, ...(send ? { send } : {}) });
	if (r.state === "failed" || r.state === "unsure") void replies.view(r.ref).then(item => item && broadcast({ ts: now(), kind: "reply", ref: r.ref, item }), e => log(`reply ${r.ref}: item after its send not read: ${(e as Error).message}`));
	if (kakaoReply.target(r.ref)) broadcast({ kind: "kakao_draft", chatId: "" });
	if (r.state === "sent") cardOwedMail(r);
	// A KakaoTalk draft goes out in this process (no CLI posts /api/followup for it): the app's 이어서 할 일 is woken here, once per draft.
	if (r.state === "sent" && kakaoReply.target(r.ref)) triggerFollowup({ app: "kakao", kind: "kakao", key: r.ref, ids: { draft: r.ref } });
	const what = r.title.replace(/\s*\([^()]*\)\s*$/, "");
	if (r.state === "back" && r.cause === "restart") return void out(noteTarget(r.conv, r.ref), `[wait] ${what} (${r.ref}): ${r.text}`, undefined, { source: "gateway" }).catch(e => log(`send back note for ${r.ref} failed: ${e}`));
	if (r.state !== "failed" && r.state !== "unsure") return;
	// Code is still retrying a surely-unsent send: the card shows it; the owner hears only when it needs him.
	if (r.state === "failed" && r.safeToAuto) return;
	if (r.state === "unsure") return void out(noteTarget(r.conv, r.ref), `[wait] 보냈는지 확인되지 않았어요: ${what} (${r.ref})\n${r.text}\n자동으로 다시 보내지 않아요. 답장 대기에서 나갔어요 또는 다시 보내기를 골라 주세요.`, undefined, { source: "gateway" }).catch(e => log(`send check note for ${r.ref} failed: ${e}`));
	void out(noteTarget(r.conv, r.ref), `[fail] 보내지 못했어요: ${what} (${r.ref})\n${r.text || "이유를 알 수 없어요"}\n다른 카드는 그대로 보내고 있어요.`, undefined, { source: "gateway" }).catch(e => log(`send failure note for ${r.ref} failed: ${e}`));
};

// Every send that is not finished is kept here (hub/approval-send.ts), so a restart finds it.
const JOBS_FILE = join(DATA_DIR, "approval-sends.json");
const jobStore = {
	load: (): unknown[] => {
		if (!existsSync(JOBS_FILE)) return [];
		const list = JSON.parse(readFileSync(JOBS_FILE, "utf8"));
		return Array.isArray(list) ? list : [];
	},
	save: (body: string): void => writeAtomic(JOBS_FILE, `${body}\n`),
};
/** A send that was running when the gateway stopped: sent, its sender still running, or nobody can say (unsure; code never sends it again). */
function lookSend(j: SendJob): SendLook {
	const m = getDraft(j.ref);
	if (m) return m.status === "sent" ? { state: "sent" } : claimHolder(claimFile(j.ref)) === "live" ? { state: "alive" } : { state: "unsure", text: MAY_HAVE_GONE_OUT };
	return commentSendOutcome(j.ref) ?? { state: "unsure", text: MAY_HAVE_GONE_OUT };
}
// The cancel window (settings: web.send_undo_sec, seconds, default 10, 0 = off) is read when a send is approved.
const undoMs = (): number => ((s => (typeof s === "number" && Number.isFinite(s) && s >= 0 ? s : 10))(cfg.web.send_undo_sec)) * 1000;

/** One card's pick as the inbox keeps it: the question, the option number and its label; a 보내기 of the reply flow also the approvalHash it approved. */
export type AnswerPick = { q: string; n: number; label: string; note?: string; hash?: string; until?: number };
// The owner's answer as the inbox keeps it (the CLIs' approval check reads it there), with no model turn. `decision`: the open card it answers.
// `from`: the owner's chat message the model read it from (`read_by: "model"`, `owner_msg`), the audit of a pick no button made.
export function recordAnswer(a: { source: "web" | "discord"; channel: string; author: string; text: string; picks: AnswerPick[]; decision?: string; from?: { mid: string } }): void {
	const mid = newMid();
	emit("inbox", { ts: now(), kind: "message", source: a.source, channel: a.channel, author: a.author, text: a.text, mid, picks: a.picks, decision: a.decision ?? `gateway:${mid}`, ...(a.from ? { read_by: "model", owner_msg: a.from.mid } : {}) });
}
// A send taken back: the owner's cancel becomes his latest word on the draft, so the old 보내기 sends nothing from a CLI either.
function revokeSend(j: SendJob): void {
	recordAnswer({ source: "web", channel: channelOf(j.conv), author: "owner", text: DRAFT_UNDO, picks: [{ q: j.title, n: 0, label: DRAFT_UNDO }] });
}
// The sender's mark on a 보내기 for the CLIs' gate (hub/draft-approval.ts draftVerdict): a sealed inbox line of its own kind, with no text, so no
// conversation shows it and no reader takes it for the owner's word. A `go` carries its own id, so its seal (the CLI's one-run token) is never another's.
function markSend(j: SendJob, mark: "spent" | "go"): void {
	emit("inbox", { ts: now(), kind: SEND_GATE, source: "gateway", text: "", ref: j.ref, mark, ...(mark === "go" ? { id: newMid(), action: j.action, ...(j.hash ? { hash: j.hash } : {}) } : {}) });
}

export const sender = createApprovalSender({
	kind: sendTargetOf,
	fingerprint: fingerprintOf,
	run: runCli,
	runJob: j => (j.kind === "kakao" ? kakaoReply.run?.(j) : undefined),
	repair: async (j, code) => (await adapterOf(j.ref)?.repair?.(j.ref, code)) ?? "failed",
	prove: async j => (await adapterOf(j.ref)?.prove?.(j.ref)) ?? "unknown",
	report: reportSend,
	log,
	store: jobStore,
	look: lookSend,
	undoMs,
	revoke: revokeSend,
	mark: markSend,
});

// The bot's turn for a hand-written card (kind `card`): routes.ts hands its deliver here once it exists.
let toBot: (conv: string, text: string) => Promise<void> = async conv => log(`reply: a hand-written card in ${conv} has no bot path yet`);
export const setReplyBot = (fn: typeof toBot): void => void (toBot = fn);
const openCardOf = (conv: string, ref: string) => openDraftCards(conv).find(c => c.ref === ref);
// The card of draft `ref`, open or answered: the conversation its sends report to.
const cardOfRef = (ref: string) => allNotices().find(i => i.decision && i.title.endsWith(`(${ref})`));

export const replies = createReplyActions({
	adapters,
	sender,
	recordPick: ({ surface, conv, q, n, label, note, hash, until, from }) => {
		const ref = refOfQuestion(q);
		const card = ref ? openCardOf(conv, ref) : undefined;
		// A word that is no card option (직접 고치기, n 0) is written as its label alone.
		const said = `${n ? `${n}) ` : ""}${label}`;
		// A change (고치기, 직접 고치기) keeps its card open: the revise moves it to the new draft, the edit redraws it in place. Its record names no
		// card, since a message that names one answers it (notices-store.ts ownerReplied).
		const settles = card && draftActionOf(label) !== "edit";
		recordAnswer({ source: surface === "discord" ? "discord" : "web", channel: channelOf(conv), author: "owner", text: `${said}${note ? ` - ${note}` : ""}`, picks: [{ q: card?.title ?? q, n, label, ...(hash ? { hash } : {}), ...(until !== undefined ? { until } : {}) }], ...(settles ? { decision: card.id } : {}), ...(from ? { from } : {}) });
		if (settles) settleOpenDecision(card.id, said);
	},
	recordText: (conv, text) => recordAnswer({ source: "web", channel: channelOf(conv), author: "owner", text, picks: [] }),
	learning: replyLearning(),
	cards: {
		open: () => openDraftCards().map(c => ({ ref: c.ref, conv: c.to, notice: c.id, title: c.title, ...(c.hash ? { hash: c.hash } : {}), ...(c.discord ? { discord: c.discord } : {}), ...(c.asked ? { asked: c.asked } : {}), ...(c.posts ? { posts: c.posts } : {}) })),
		convOf: ref => cardOfRef(ref)?.decision?.to,
		replace: (oldRef, newRef, text, hash) => void redrawDraftCards(oldRef, text, hash, newRef),
		rewrite: (ref, text, hash) => void redrawDraftCards(ref, text, hash),
		// The confirm card goes where the card was; its old post is marked moved only once the new one is out.
		repost: async (ref, text, hash) => {
			const n = repostDraftCard(ref, text, hash);
			if (!n) return;
			const r = await out(targetOf(n.to, ref), n.text, undefined, { queued: true, repost: n.id });
			if (r.delivered && n.card) cardMoved(n.to, ref, { ...n.card, text: n.text });
		},
		close: ref => {
			for (const c of openDraftCards().filter(x => x.ref === ref)) settleOpenDecision(c.id, "");
		},
	},
	toBot: (conv, text) => toBot(conv, text),
	emit: e => broadcast({ ts: now(), ...e }),
	log,
	settle: () => {
		settleSoon();
		void replies.settleOwed().catch(e => log(`reply: settle of owed sends failed: ${(e as Error).message}`));
	},
	// Milliseconds: config's now() is an ISO string for event stamps.
	now: Date.now,
});
setReplies(replies);
// A draft's card just opened: every surface gets the reply as that card shows it (the web swaps its inline placeholder for the real card at once).
onDecision(n => {
	const ref = n.decision?.draft?.ref;
	if (ref) void stampDraftCard(n.id);
	if (ref) void replies.view(ref).then(item => item && broadcast({ ts: now(), kind: "reply", ref, item: { ...item, conv: n.decision!.to, notice: n.id } }), e => log(`reply ${ref}: carded item not read: ${(e as Error).message}`));
});

let sendsBooted = false;
// A card left 확인 필요 follows the comment's record: proof read back, the owner's 완료 or 다시 보내기, or the old sender that finished after all.
function settleUnsureCards(): void {
	for (const n of allNotices()) {
		const d = n.decision, ref = d?.draft?.ref;
		if (d?.send?.state !== "unsure" || !ref) continue;
		const o = commentSendOutcome(ref);
		if (o?.state === "sent" || o?.state === "failed") sender.settle({ ref, conv: d.to, action: "send", title: n.title }, o.state, o.state === "failed" ? o.text : "");
	}
}
function proveSends(): void {
	void commentProveSends().then(
		r => {
			if (r.proved.length || r.errors.length) log(`comment read-back: proved ${r.proved.join(", ") || "none"}${r.errors.length ? `; not read: ${r.errors.join("; ")}` : ""}`);
			settleUnsureCards();
		},
		e => log(`comment read-back failed: ${e instanceof Error ? e.message : String(e)}`),
	);
}
const settleOwedSends = (): Promise<void> => replies.settleOwed().then(() => undefined, e => log(`reply: settle of owed sends failed: ${(e as Error).message}`));
/** Boot and every sweep after it: the sends the last run left are taken up (never re-run, and a failed or unsure one is held again without a note), a failed or unsure record whose draft was closed elsewhere is cleared (settleOwed) before anything reads back or reports, unsure comments are read back and proof is asked for every unsure send; a comment reply whose sender died while running is left unsure. */
export function settleSends(): void {
	if (!sendsBooted) {
		sendsBooted = true;
		commentSettleSending();
		sender.recover();
		sender.recheck();
		void settleOwedSends().then(() => {
			proveSends();
			settleUnsureCards();
		});
		return;
	}
	if (commentSettleStale(draft => claimHolder(claimFile(draft)) === "live")) proveSends();
	sender.recheck();
	settleUnsureCards();
	void settleOwedSends();
}
// A send run from a CLI (a session's draft.ts send) failed: the card it answers shows it and the owner hears it, like a send of the gateway's own.
export function reportCliFailure(ref: string, conv: string, text: string): void {
	const card = cardOfRef(ref);
	reportSend({ ref, conv: card?.decision?.to ?? conv, title: card?.title ?? "답장", state: "failed", text, at: Date.now() });
}
