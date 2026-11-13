// The gateway's own path for send approvals (hub/approval-send.ts, hub/approval-batch.ts), wired to the real stores, the inbox and the queue:
//   GET  /api/approvals?to=<conv>        { cards: [{ ref, question, draft, notice?, sendable }], results: [...], triageMin }
//                                        the open card and the held ones of one conversation, in queue order, and recent sends there
//   POST /api/approvals                  { to, items: [{ ref, n: 1 | 2, note? }] }: the batch review / triage answer (n 1 = 보내기, 2 = 고치기)
//   POST /api/approvals/failed           { op: "retry" | "drop", items: [{ ref, to }] }: 다시 보내기 / 지우기 of sends the gateway ran for the owner's pick and that failed
//                                        -> { results: [{ ref, ok, reason? }] } (hub/reply-outcomes.ts); no new approval is recorded
//   POST /api/drafts/<ref>/body          { text, part?: "reply" | "mail" }: the owner's own edit of a pending draft's text, before he sends it
// and the single-card answers of the web (routes.ts) and Discord (main.ts), which take this path when the gateway can send the draft.
import { log, now } from "./config.ts";
import { approvals, convOfTarget, newMid } from "./outbound.ts";
import { answerDecision, type DecisionSend, allNotices, openDraftCards, settleOpenDecision } from "./notices.ts";
import type { Upload } from "./files.ts";
import { commentContextOf, commentDraftOf, commentPostedOf, commentDraftsByCode, commentPending, commentSendFailed, commentSourceApp, dropCommentDraft } from "./comments/gateway.ts";
import { dropFailed, retryFailed, type RetryDeps } from "./reply-outcomes.ts";
import { appEntries, commentOwner } from "./integrations.ts";
import { instanceOf } from "./reply-model.ts";
import { DATA_DIR } from "./config.ts";
import { getDraft } from "./reply-mail.ts";
import { refOfQuestion, sendActionOf } from "./approval-send.ts";
import { answerBatch, batchCard, STALE_OPTIONS, type BatchCard, type BatchPick } from "./approval-batch.ts";
import { draftActionOf, DRAFT_BODY_MAX, withAttachIssues, withStagedFiles } from "./draft-approval.ts";
import { mailOriginalOf, pendingDraftFiles, pendingDraftIssues, syncCardFiles } from "./draft-attach.ts";
import { channelOf, recordAnswer, replies, reportCliFailure, sender } from "./reply-wire.ts";
import type { ActInput } from "./reply-actions.ts";

export { recordAnswer, reportSend, sender, sendTargetOf, settleSends } from "./reply-wire.ts";
import { mailByKey, mailRecords } from "./mail.ts";
import { json } from "./routes-util.ts";

// How many waiting cards of one conversation make the web open its triage view instead of one card at a time (settings: web.triage_min).
export const TRIAGE_MIN_DEFAULT = 3;

/** Whether the mail of a comment draft whose reply is posted is still there to send (see RetryDeps.posted). */
const postedMailOf = (ref: string): "pending" | "gone" | undefined => {
	const m = commentPostedOf(ref)?.mail;
	return m ? (getDraft(m)?.status === "pending" ? "pending" : "gone") : undefined;
};

/** The app a draft belongs to (a comment draft's source app; a mail draft's app instance, found from its mail like groupOf), for the 실패 / 보낸 것 rows. */
export const draftAppOf = (ref: string): string | undefined => {
	const c = commentDraftOf(ref);
	if (c) return commentSourceApp(c.source);
	const m = getDraft(ref);
	if (!m || m.kind !== "mail" || m.compose) return m?.app;
	const inst = instanceOf(appEntries(DATA_DIR), "mail", `mail:${m.ref}`);
	return inst === "mail" ? m.app : inst;
};

/** What a card's picked label asks of the one reply flow (design 1.9 old routes), or undefined when the bot reads it (직접 입력, a 고치기 with no words). */
function replyInputOf(ref: string, label: string, note?: string): ActInput | undefined {
	const a = draftActionOf(label);
	if (a === "send" || a === "send-as-is") return { ref, action: "send", ...(a === "send-as-is" ? { asIs: true } : {}) };
	if (a === "send-main" || a === "send-mail") return { ref, action: "send", part: a === "send-main" ? "reply" : "mail" };
	if (a === "drop") return { ref, action: "drop" };
	if (a === "edit" && note?.trim()) return { ref, action: "revise", change: note.trim() };
	return undefined;
}
/** A pick on an open card whose draft an adapter knows, as one act of the reply flow; undefined = the answer keeps its old path. */
async function actOnCard(conv: string, q: string, label: string, note: string | undefined, surface: "web" | "discord", login: string) {
	const ref = refOfQuestion(q);
	if (!ref || conv.startsWith("lane:") || conv.startsWith("auth:") || !openDraftCards(conv).some(c => c.ref === ref)) return undefined;
	const input = replyInputOf(ref, label, note);
	if (!input || !(await replies.list()).some(i => i.ref === ref && i.kind !== "card")) return undefined;
	return replies.act(input, { surface, login });
}

/** A Discord button pick (hub/askbuttons.ts) on a draft the reply flow knows: the same act as the web's card (send, revise with its words, drop). */
export async function discordGatewayAnswer(_target: string, conv: string, text: string, picks: BatchPick[]): Promise<boolean> {
	const p = picks.length === 1 ? picks[0]! : undefined;
	if (!p) return false;
	const note = /\s-\s(.+)$/.exec(text)?.[1];
	const r = await actOnCard(conv, p.q, p.label, note, "discord", "owner");
	if (r && !r.body.ok) log(`discord pick on ${p.q}: ${r.body.error}`);
	return !!r;
}

export type WaitingCard = BatchCard & { to: string; sendable: boolean; editable: boolean; group: string; info: string[] };

// The lines a card carries above its draft (원댓글, 메일 대조, 확인 필요, a note of the bot): what the owner reads before he decides.
// A draft whose words POST /api/drafts/<ref>/body can change; a block a session wrote lives only in its message, so 고치기 asks the session instead.
const textEditable = (ref: string): boolean => !!commentDraftOf(ref) || getDraft(ref)?.status === "pending";
export const cardInfo = (text: string): string[] => {
	const lines = text.split("\n"), stop = lines.findIndex(l => l.startsWith(">") || l.startsWith("결정"));
	return (stop < 0 ? [] : lines.slice(0, stop)).map(l => l.trim().replace(/^\[[^\]]+\][ \t]*/, "")).filter(l => l && !/^-# /.test(l)).slice(0, 8).map(l => l.slice(0, 300));
};
export type CardGroup = { key: string; label: string; count: number; cards: WaitingCard[] };

// The app instance a draft belongs to (owner 2026-10-31: one mailbox split into categories by filter.source, each its own queue): the comment
// source's owning instance, the mail's instance; a card the gateway cannot place stays with its conversation.
/**
 * A card's button on the web (POST /api/notices/<id>/answer). 보내기 on a draft the gateway can send is recorded with no model turn, the
 * card closes (its queue shows the next one at once) and the send is queued; 직접 수정 files ride to the bot, so such an answer keeps its path.
 */
export async function webAnswer(id: string, body: { n?: unknown; label?: unknown; note?: unknown; files?: Upload[] }, login: string, deliver: DecisionSend) {
	const card = allNotices().find(n => n.id === id);
	const opt = card?.decision?.state === "open" ? card.decision.options.find(o => o.n === Number(body.n)) : undefined;
	// The page names the label it showed for `n`: a card whose options changed since (a staged file moves 이대로 보내기 and 답글만) answers 409 instead of running another action. No label = as before.
	if (typeof body.label === "string" && card?.decision?.state === "open" && opt?.label !== body.label) return { status: 409, body: { error: STALE_OPTIONS } };
	// A draft the reply flow knows: its act writes the pick, settles or moves the card and queues the send. Files ride to the bot as before.
	const acted = card && opt && !body.files?.length ? await actOnCard(card.decision!.to, card.title, opt.label, typeof body.note === "string" ? body.note : undefined, "web", login) : undefined;
	if (acted) {
		if (!acted.body.ok) return { status: acted.status, body: { error: acted.body.error } };
		const held = sender.results().find(x => x.ref === refOfQuestion(card!.title) && x.state === "undo");
		return { status: 200, body: { ok: true, ...(held ? { send: { state: held.state, until: held.until, left: Math.max(0, (held.until ?? 0) - now()) } } : {}) } };
	}
	return answerDecision(id, body, deliver);
}

function groupOf(ref: string, to: string, entries: ReturnType<typeof appEntries>, comments: ReturnType<typeof commentDraftsByCode>): { key: string; label?: string } {
	const c = comments.get(ref), app = c && commentSourceApp(c.source);
	const m = c ? undefined : getDraft(ref);
	const key = c && app ? commentOwner(entries, app, c.source) : m ? (m.compose ? m.app : instanceOf(entries, "mail", `mail:${m.ref}`)) : `conv:${to}`;
	return { key, label: entries.find(e => e.key === key)?.label };
}

const isMailRef = (ref: string) => /^R[A-Z2-7]{6}$/.test(ref) && getDraft(ref)?.status === "pending";

/** Every waiting send-approval card: the open ones, then the held ones, each with its conversation and app-instance group. */
export function waitingCards(): WaitingCard[] {
	const entries = appEntries(DATA_DIR), comments = commentDraftsByCode();
	syncCardFiles();
	const staged = (ref: string, text: string) => {
		const files = pendingDraftFiles(ref), issues = pendingDraftIssues(ref);
		const shown = files ? withStagedFiles(text, files) : text;
		return issues ? withAttachIssues(shown, issues) : shown;
	};
	const open = openDraftCards().map(c => ({ ref: c.ref, to: c.to, question: c.title, text: c.text, draft: c.draft, notice: c.id }));
	const held = approvals.held().map(h => ({ ...batchCard(h.ref, staged(h.ref, h.text)), to: convOfTarget(h.target) })).filter(h => !open.some(o => o.ref === h.ref && o.to === h.to));
	return [...open, ...held].map(c => ({ ...c, sendable: sender.can(c.ref, "send"), editable: textEditable(c.ref), group: groupOf(c.ref, c.to, entries, comments).key, info: cardInfo(c.text) }));
}

/** The waiting cards by app instance, largest group first; one category never mixes into another. */
export function cardGroups(cards = waitingCards()): CardGroup[] {
	const entries = appEntries(DATA_DIR), comments = commentDraftsByCode(), by = new Map<string, CardGroup>();
	for (const c of cards) {
		const g = by.get(c.group) ?? { key: c.group, label: groupOf(c.ref, c.to, entries, comments).label ?? "승인 대기", count: 0, cards: [] };
		g.cards.push(c);
		g.count++;
		by.set(c.group, g);
	}
	return [...by.values()].sort((x, y) => y.count - x.count);
}

const FAILED_BATCH_MAX = 100;

// The list carries only the start of the mail (two lines in a row); the screen reads the whole text from GET /api/drafts/<ref>/original when a card opens.
const ORIGINAL_MAX = 60;
/**
 * What the 빠른 처리 card of a mail draft shows besides the draft, so one list call is enough (no request per card for the rest): the mail it answers (text cut at
 * ORIGINAL_MAX, `cut` says so), the sending account (`many`: this install has more than one mail app), and the thread (`earlier` messages kept, `newer`: a newer message
 * arrived after the draft was made, hub/mail.ts reopenedAt). A comment card has its own `comment` context; a new mail answers nothing.
 */
function mailCardExtras(ref: string, group: string | undefined, entries: ReturnType<typeof appEntries>, threads: ReadonlyMap<string, number>) {
	const rec = getDraft(ref);
	if (!rec || rec.kind !== "mail") return {};
	const o = mailOriginalOf(rec), m = mailByKey(rec.ref);
	const label = [group, rec.account].filter(Boolean).join(" · ");
	return {
		...(o ? { original: { from: o.from, at: o.date, ...(o.subject ? { subject: o.subject } : {}), text: o.text.slice(0, ORIGINAL_MAX), ...(o.text.length > ORIGINAL_MAX ? { cut: true } : {}), files: o.attachments.length } } : {}),
		account: { label, many: entries.filter(e => e.app === "mail" && !e.gone).length > 1 },
		...(m?.thread || m?.reopenedAt ? { thread: { earlier: m.thread ? Math.max(0, (threads.get(m.thread) ?? 1) - 1) : 0, newer: !!m.reopenedAt && m.reopenedAt > rec.created } } : {}),
	};
}

/** The 보내지 않기 of a comment draft or a mail draft of the store, the same steps as the card's. */
async function dropDraftRef(ref: string): Promise<{ ok: boolean; reason?: string }> {
	if (commentDraftOf(ref)) {
		const r = dropCommentDraft(ref);
		return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "지우지 못했어요" };
	}
	if (getDraft(ref)?.status !== "pending") return { ok: false, reason: "이미 처리됐거나 없는 초안이에요" };
	const { dropDraft } = await import("../features/reply-drafts/lib/flow.ts");
	const r = dropDraft(ref);
	return r.ok ? { ok: true } : { ok: false, reason: r.text };
}

/**
 * The approval routes. `deliver` hands an owner answer to the bot as one turn (routes.ts: the same path as a card's answer).
 * `triageMin` is the setting read at call time.
 */
export async function approvalRoute(req: Request, url: URL, deps: { login: string; triageMin: number; deliver: (to: string, text: string, picks: BatchPick[], decision?: string) => Promise<void> }): Promise<Response | undefined> {
	if (url.pathname === "/api/approvals" && req.method === "GET") {
		const comments = commentDraftsByCode(), pending = commentPending(), entries = appEntries(DATA_DIR), threads = new Map<string, number>();
		for (const r of mailRecords()) if (r.thread) threads.set(r.thread, (threads.get(r.thread) ?? 0) + 1);
		const groups = cardGroups().map(g => ({ ...g, cards: g.cards.map(({ text: _text, ...c }) => ({ ...c, kind: comments.has(c.ref) ? "comment" : "mail", ...(comments.has(c.ref) ? { comment: commentContextOf(c.ref, pending) } : mailCardExtras(c.ref, g.label, entries, threads)) })) }));
		return json({ groups, results: sender.results(), triageMin: deps.triageMin });
	}
	if (url.pathname === "/api/approvals" && req.method === "POST") {
		const b = (await req.json().catch(() => ({}))) as { items?: unknown };
		if (!Array.isArray(b.items)) return json({ error: "items are required" }, 400);
		const items = b.items.filter((x): x is { ref: string; to: string; n: number; note?: string; label?: string } => !!x && typeof x.ref === "string" && typeof x.to === "string" && typeof x.n === "number");
		if (items.some(i => i.to.startsWith("lane:") || i.to.startsWith("auth:"))) return json({ error: "세션과 로그인 요청은 여기서 답하지 않아요" }, 400);
		// One answer per conversation (its picks are recorded where its cards were asked), in the order of the list.
		const convs = [...new Set(items.map(i => i.to))];
		const all = waitingCards();
		if (convs.length && items.some(i => !all.some(c => c.ref === i.ref && c.to === i.to))) return json({ error: "이미 처리됐거나 없는 카드가 있어요. 목록을 다시 열어 주세요" }, 409);
		let sending = 0, toBot = 0;
		for (const conv of convs) {
			const r = await answerConv(conv, items.filter(i => i.to === conv));
			if (r.status !== 200) return json({ ...r.body, sending, toBot }, r.status);
			sending += Number(r.body.sending);
			toBot += Number(r.body.toBot);
		}
		if (!convs.length) return json({ error: "고른 카드가 없어요" }, 400);
		return json({ ok: true, sending, toBot });
	}
	// 취소 inside the send window: nothing is sent and the draft waits for approval again (hub/approval-send.ts cancel).
	if (url.pathname === "/api/approvals/undo" && req.method === "POST") {
		const b = (await req.json().catch(() => ({}))) as { ref?: unknown };
		if (typeof b.ref !== "string") return json({ error: "ref is required" }, 400);
		const state = sender.cancel(b.ref);
		return state === "cancelled" ? json({ ok: true, state }) : json({ error: state === "late" ? "이미 보내고 있어서 취소할 수 없어요" : "취소할 보내기가 없어요", state }, 409);
	}
	if (url.pathname === "/api/approvals/failed" && req.method === "POST") {
		const b = (await req.json().catch(() => ({}))) as { op?: unknown; items?: unknown; ref?: unknown; conv?: unknown; text?: unknown };
		if (b.op === "report") {
			if (typeof b.ref !== "string" || typeof b.conv !== "string" || typeof b.text !== "string") return json({ error: "ref, conv and text are required" }, 400);
			reportCliFailure(b.ref, b.conv, b.text);
			return json({ ok: true });
		}
		if ((b.op !== "retry" && b.op !== "drop") || !Array.isArray(b.items) || b.items.length > FAILED_BATCH_MAX) return json({ error: "op (retry | drop) and items are required" }, 400);
		const deps: RetryDeps = { notices: allNotices(), can: (ref, action) => sender.can(ref, action), enqueue: j => sender.enqueue(j), commentFailed: commentSendFailed, drop: dropDraftRef, posted: postedMailOf };
		return json({ results: b.op === "retry" ? retryFailed(b.items, deps) : await dropFailed(b.items, deps) });
	}
	async function answerConv(conv: string, items: { ref: string; n: number; note?: string; label?: string }[]) {
		return answerBatch(conv, items, {
			cards: c => waitingCards().filter(x => x.to === c),
			take: (c, refs) => approvals.take(c, refs),
			record: async (c, text, picks, deliver, notice) => {
				if (deliver) await deps.deliver(c, text, picks, notice ?? `gateway:${newMid()}`);
				else recordAnswer({ source: "web", channel: channelOf(c), author: deps.login, text, picks, ...(notice ? { decision: notice } : {}) });
			},
			settle: settleOpenDecision,
			canSend: ref => sender.can(ref, "send"),
			enqueue: j => void sender.enqueue(j),
			canDrop: ref => !!commentDraftOf(ref) || isMailRef(ref),
			dropDraft: async ref => {
				if (commentDraftOf(ref)) {
					const r = dropCommentDraft(ref);
					if (!r.ok) log(`draft ${ref}: 보내지 않기 not applied: ${r.reason}`);
					return;
				}
				const { dropDraft } = await import("../features/reply-drafts/lib/flow.ts");
				const r = dropDraft(ref);
				if (!r.ok) log(`draft ${ref}: 보내지 않기 not applied to the store: ${r.text}`);
			},
		});
	}
	const body = req.method === "POST" ? /^\/api\/drafts\/([A-Za-z0-9_.-]{2,64})\/body$/.exec(url.pathname) : null;
	if (body) {
		const ref = body[1]!;
		const b = (await req.json().catch(() => ({}))) as { text?: unknown; part?: unknown };
		const text = typeof b.text === "string" ? b.text.replace(/\r\n?/g, "\n").trim() : "";
		if (!text || text.length > DRAFT_BODY_MAX) return json({ error: text ? "글이 너무 길어요" : "보낼 글을 적어 주세요" }, 400);
		// 직접 수정 is the reply flow's edit (design 3.3): saved as written, the owner-text lint, a 고치기 pick so an older 보내기 no longer covers it.
		const r = await replies.act({ ref, action: "edit", text, ...(b.part === "mail" ? { part: "mail" as const } : {}) }, { surface: "web", login: deps.login });
		if (!r.body.ok) return json({ error: r.body.error, ...(r.body.lint ? { lint: r.body.lint } : {}) }, r.status === 404 ? 404 : r.status);
		log(`draft ${ref}${b.part === "mail" ? " (mail)" : ""}: the owner edited its text in place (${text.length} chars)`);
		return json({ ok: true });
	}
	return undefined;
}
