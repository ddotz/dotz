// The gateway's own path for send approvals (hub/approval-send.ts, hub/approval-batch.ts), wired to the real stores, the inbox and the queue:
//   GET  /api/approvals?to=<conv>        { cards: [{ ref, question, draft, notice?, sendable }], results: [...], triageMin }
//                                        the open card and the held ones of one conversation, in queue order, and recent sends there
//   POST /api/approvals                  { to, items: [{ ref, n: 1 | 2, note? }] }: the batch review / triage answer (n 1 = 보내기, 2 = 고치기)
//   POST /api/drafts/<ref>/body          { text, part?: "reply" | "mail" }: the owner's own edit of a pending draft's text, before he sends it
// and the single-card answers of the web (routes.ts) and Discord (main.ts), which take this path when the gateway can send the draft.
import { log, now } from "./config.ts";
import { broadcast, emit } from "./events.ts";
import { approvals, convOfTarget, newMid, out } from "./outbound.ts";
import { answerDecision, type DecisionSend, listNotices, markDraftSend, NOTICE_CAP, openDraftCards, settleOpenDecision } from "./notices.ts";
import type { Upload } from "./files.ts";
import { commentDraftOf, commentSourceApp, setCommentDraftText } from "./comments/gateway.ts";
import { appEntries, commentOwner } from "./integrations.ts";
import { instanceOf } from "./reply-model.ts";
import { DATA_DIR } from "./config.ts";
import { linkedComment } from "./comments/linked.ts";
import { getDraft, patchDraft } from "../features/reply-drafts/lib/store.ts";
import { createApprovalSender, refOfQuestion, runCli, sendActionOf, type SendTarget } from "./approval-send.ts";
import { answerBatch, batchCard, type BatchCard, type BatchPick } from "./approval-batch.ts";
import { DRAFT_BODY_MAX } from "./draft-approval.ts";

// How many waiting cards of one conversation make the web open its triage view instead of one card at a time (settings: web.triage_min).
export const TRIAGE_MIN_DEFAULT = 3;

/** Where the gateway would send draft `ref`: a pending comment reply (per source) or a pending mail draft of its own (per sending account). */
export function sendTargetOf(ref: string): SendTarget | undefined {
	const c = commentDraftOf(ref);
	if (c) return { kind: "comment", lane: `comment:${c.source}` };
	const m = getDraft(ref);
	if (m && m.kind === "mail" && m.status === "pending" && !linkedComment(ref)) return { kind: "mail", lane: `mail:${m.source}` };
	return undefined;
}

// A conversation's gateway note goes where its cards were posted.
const targetOf = (conv: string, ref: string): string => approvals.targetOf(conv, ref) ?? (conv === "main" ? "web" : conv);

export const sender = createApprovalSender({
	kind: sendTargetOf,
	run: runCli,
	report: r => {
		markDraftSend(r.conv, r.ref, r.state, r.text);
		broadcast({ ts: now(), kind: "approval_send", source: "gateway", ...r });
		if (r.state !== "failed") return;
		const what = r.title.replace(/\s*\([^()]*\)\s*$/, "");
		void out(targetOf(r.conv, r.ref), `[fail] 보내지 못했어요: ${what} (${r.ref})\n${r.text || "이유를 알 수 없어요"}\n다른 카드는 그대로 보내고 있어요.`, undefined, { source: "gateway" }).catch(e => log(`send failure note for ${r.ref} failed: ${e}`));
	},
	log,
});

// The owner's answer as the inbox keeps it (the CLIs' approval check reads it there), with no model turn. `decision`: the open card it answers;
// any other value settles nothing (notices.ts ownerReplied otherwise answers every open card of the conversation with it).
export function recordAnswer(a: { source: "web" | "discord"; channel: string; author: string; text: string; picks: BatchPick[]; decision?: string }): void {
	const mid = newMid();
	emit("inbox", { ts: now(), kind: "message", source: a.source, channel: a.channel, author: a.author, text: a.text, mid, picks: a.picks, decision: a.decision ?? `gateway:${mid}` });
}
const channelOf = (conv: string) => (conv === "main" ? "web" : conv);

/** The send the gateway runs for this pick on an open card of `conv`, or undefined (the answer then goes to the bot as before). */
export function gatewaySendOf(conv: string, q: string, label: string): { ref: string; notice: string; action: NonNullable<ReturnType<typeof sendActionOf>> } | undefined {
	const ref = refOfQuestion(q), action = sendActionOf(label);
	if (!ref || !action || conv.startsWith("lane:") || conv.startsWith("auth:") || !sender.can(ref, action)) return undefined;
	const card = openDraftCards(conv).find(c => c.ref === ref);
	return card ? { ref, notice: card.id, action } : undefined;
}

/** A Discord button pick (hub/askbuttons.ts) the gateway sends itself: recorded, the card closed (the next one shows), the send queued. */
export function discordGatewayAnswer(target: string, conv: string, text: string, picks: BatchPick[]): boolean {
	const p = picks.length === 1 ? picks[0]! : undefined;
	const g = p && gatewaySendOf(conv, p.q, p.label);
	if (!p || !g) return false;
	recordAnswer({ source: "discord", channel: target, author: "owner", text, picks, decision: g.notice });
	settleOpenDecision(g.notice, `${p.n}) ${p.label}`);
	sender.enqueue({ ref: g.ref, conv, action: g.action, title: p.q });
	return true;
}

export type WaitingCard = BatchCard & { to: string; sendable: boolean; group: string };
export type CardGroup = { key: string; label: string; count: number; cards: WaitingCard[] };

// The app instance a draft belongs to (owner 2026-10-31: one mailbox split into categories by filter.source, each its own queue): the comment
// source's owning instance, the mail's instance; a card the gateway cannot place stays with its conversation.
/**
 * A card's button on the web (POST /api/notices/<id>/answer). 보내기 on a draft the gateway can send is recorded with no model turn, the
 * card closes (its queue shows the next one at once) and the send is queued; 직접 수정 files ride to the bot, so such an answer keeps its path.
 */
export async function webAnswer(id: string, body: { n?: unknown; note?: unknown; files?: Upload[] }, login: string, deliver: DecisionSend) {
	const card = listNotices(NOTICE_CAP).items.find(n => n.id === id);
	const opt = card?.decision?.state === "open" ? card.decision.options.find(o => o.n === Number(body.n)) : undefined;
	const gw = card && opt && !body.files?.length ? gatewaySendOf(card.decision!.to, card.title, opt.label) : undefined;
	const r = await answerDecision(id, body, async a => (gw ? recordAnswer({ source: "web", channel: channelOf(a.to), author: login, text: a.text, picks: a.picks ?? [], decision: a.notice }) : deliver(a)));
	if (gw && r.status === 200 && !r.body.already) sender.enqueue({ ref: gw.ref, conv: card!.decision!.to, action: gw.action, title: card!.title });
	return r;
}

function groupOf(ref: string, to: string, entries = appEntries(DATA_DIR)): { key: string; label?: string } {
	const c = commentDraftOf(ref), app = c && commentSourceApp(c.source);
	const m = c ? undefined : getDraft(ref);
	const key = c && app ? commentOwner(entries, app, c.source) : m ? (m.compose ? m.app : instanceOf(entries, "mail", `mail:${m.ref}`)) : `conv:${to}`;
	return { key, label: entries.find(e => e.key === key)?.label };
}

/** Every waiting send-approval card: the open ones, then the held ones, each with its conversation and app-instance group. */
export function waitingCards(): WaitingCard[] {
	const entries = appEntries(DATA_DIR);
	const open = openDraftCards().map(c => ({ ref: c.ref, to: c.to, question: c.title, text: "", draft: c.draft, notice: c.id }));
	const held = approvals.held().map(h => ({ ...batchCard(h.ref, h.text), to: convOfTarget(h.target) })).filter(h => !open.some(o => o.ref === h.ref && o.to === h.to));
	return [...open, ...held].map(c => ({ ...c, sendable: sender.can(c.ref, "send"), group: groupOf(c.ref, c.to, entries).key }));
}

/** The waiting cards by app instance, largest group first; one category never mixes into another. */
export function cardGroups(cards = waitingCards()): CardGroup[] {
	const entries = appEntries(DATA_DIR), by = new Map<string, CardGroup>();
	for (const c of cards) {
		const g = by.get(c.group) ?? { key: c.group, label: groupOf(c.ref, c.to, entries).label ?? "승인 대기", count: 0, cards: [] };
		g.cards.push(c);
		g.count++;
		by.set(c.group, g);
	}
	return [...by.values()].sort((x, y) => y.count - x.count);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * The approval routes. `deliver` hands an owner answer to the bot as one turn (routes.ts: the same path as a card's answer).
 * `triageMin` is the setting read at call time.
 */
export async function approvalRoute(req: Request, url: URL, deps: { login: string; triageMin: number; deliver: (to: string, text: string, picks: BatchPick[], decision?: string) => Promise<void> }): Promise<Response | undefined> {
	if (url.pathname === "/api/approvals" && req.method === "GET") {
		const groups = cardGroups().map(g => ({ ...g, cards: g.cards.map(({ text: _text, ...c }) => c) }));
		return json({ groups, results: sender.results(), triageMin: deps.triageMin });
	}
	if (url.pathname === "/api/approvals" && req.method === "POST") {
		const b = (await req.json().catch(() => ({}))) as { items?: unknown };
		if (!Array.isArray(b.items)) return json({ error: "items are required" }, 400);
		const items = b.items.filter((x): x is { ref: string; to: string; n: number; note?: string } => !!x && typeof x.ref === "string" && typeof x.to === "string" && typeof x.n === "number");
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
	async function answerConv(conv: string, items: { ref: string; n: number; note?: string }[]) {
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
		});
	}
	const body = req.method === "POST" ? /^\/api\/drafts\/([A-Za-z0-9_.-]{2,64})\/body$/.exec(url.pathname) : null;
	if (body) {
		const ref = body[1]!;
		const b = (await req.json().catch(() => ({}))) as { text?: unknown; part?: unknown };
		const text = typeof b.text === "string" ? b.text.replace(/\r\n?/g, "\n").trim() : "";
		if (!text || text.length > DRAFT_BODY_MAX) return json({ error: text ? "글이 너무 길어요" : "보낼 글을 적어 주세요" }, 400);
		const c = commentDraftOf(ref);
		if (c && b.part === "mail") {
			if (!c.mail || getDraft(c.mail)?.status !== "pending") return json({ error: "함께 보낼 메일이 없어요" }, 404);
			patchDraft(c.mail, { body: text });
		} else if (c) setCommentDraftText(ref, text);
		else if (getDraft(ref)?.status === "pending") patchDraft(ref, { body: text });
		else return json({ error: "이미 처리됐거나 없는 초안이에요" }, 404);
		log(`draft ${ref}${b.part === "mail" ? " (mail)" : ""}: the owner edited its text in place (${text.length} chars)`);
		return json({ ok: true });
	}
	return undefined;
}
