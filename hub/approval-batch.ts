// Reviewing every waiting send-approval card of a conversation at once (owner 2026-10-31: a user with 28 comment replies + mails wanted to
// read the drafts, approve them and have them go out back to back). The web sheet lists the open card and the held ones (hub/approval-queue.ts)
// with each draft; the owner picks 보내기, 고치기 … (with the change) or 건너뛰기 per card, and "확인한 것 보내기" answers the picked ones at once.
// Nothing is sent that the owner did not pick one by one: a card left on 건너뛰기 stays in the queue as it was.
//
// One answer becomes at most two owner messages in the inbox, each with a pick per card (what the CLIs' approval check reads):
//   - the sends the gateway runs itself (hub/approval-send.ts): recorded only, no model turn, then queued in the order of the list;
//   - the rest (고치기, and 보내기 on a card the gateway cannot send): one message to the bot, so it revises or sends them in one turn.
import { parseDecisions } from "./choices.ts";
import { DRAFT_DROP, DRAFT_EDIT, DRAFT_SEND, parseDraftApproval, type DraftApproval } from "./draft-approval.ts";
import { parseTone, stripHandoff } from "./tone.ts";
import type { SendJob } from "./approval-send.ts";

export type BatchCard = { ref: string; question: string; text: string; draft?: DraftApproval; notice?: string };
export type BatchPick = { q: string; n: number; label: string; note?: string };
export type BatchItem = { ref: string; n: number; note?: string };

export type BatchDeps = {
	/** The open card (with its notice id) and the held ones of `conv`, in queue order. */
	cards: (conv: string) => BatchCard[];
	/** Takes the held cards `refs` out of the queue (they are answered without being shown). */
	take: (conv: string, refs: string[]) => void;
	/** Records the owner's answer in the inbox; `deliver` also hands it to the bot as one turn. `notice` = the open card it settles. */
	record: (conv: string, text: string, picks: BatchPick[], deliver: boolean, notice?: string) => Promise<void>;
	/** Marks the open card answered (its queue then shows the next held card). */
	settle: (notice: string, label: string) => void;
	canSend: (ref: string) => boolean;
	enqueue: (job: SendJob) => void;
	/** 보내지 않기 (n 3) on a draft the gateway can drop itself (a comment reply, a reply-drafts mail): `dropDraft` does the store step. Without it the pick goes to the bot. */
	canDrop?: (ref: string) => boolean;
	dropDraft?: (ref: string) => Promise<void> | void;
};

const MAX_NOTE = 2000;

/** One card's draft and question, from the text the bot posted. */
export function batchCard(ref: string, text: string, notice?: string): BatchCard {
	const body = parseTone(stripHandoff(text)).text.trim();
	const draft = parseDraftApproval(body);
	const title = parseDecisions(body).blocks.find(b => b.title?.includes(`(${ref})`))?.title ?? `(${ref})`;
	return { ref, question: title, text: body, ...(draft ? { draft } : {}), ...(notice ? { notice } : {}) };
}

export async function answerBatch(conv: string, items: BatchItem[], deps: BatchDeps): Promise<{ status: number; body: Record<string, unknown> }> {
	const cards = deps.cards(conv);
	const chosen: { card: BatchCard; pick: BatchPick }[] = [];
	for (const it of items) {
		const card = cards.find(c => c.ref === it.ref);
		if (!card) return { status: 409, body: { error: "이미 처리됐거나 없는 카드가 있어요. 목록을 다시 열어 주세요", ref: it.ref } };
		if (chosen.some(c => c.card.ref === it.ref)) return { status: 400, body: { error: "같은 카드가 두 번 있어요" } };
		const note = String(it.note ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
		if (it.n === 1) chosen.push({ card, pick: { q: card.question, n: 1, label: DRAFT_SEND } });
		else if (it.n === 2) {
			if (!note) return { status: 400, body: { error: "고칠 카드마다 무엇을 고칠지 적어 주세요", ref: it.ref } };
			chosen.push({ card, pick: { q: card.question, n: 2, label: DRAFT_EDIT, note } });
		} else if (it.n === 3) chosen.push({ card, pick: { q: card.question, n: 3, label: DRAFT_DROP } });
		else return { status: 400, body: { error: "unknown option" } };
	}
	if (!chosen.length) return { status: 400, body: { error: "고른 카드가 없어요" } };
	const gw = chosen.filter(c => (c.pick.n === 1 && deps.canSend(c.card.ref)) || (c.pick.n === 3 && deps.canDrop?.(c.card.ref)));
	const bot = chosen.filter(c => !gw.includes(c));
	const open = chosen.find(c => c.card.notice);
	const line = (c: (typeof chosen)[number]) => `${c.card.question}: ${c.pick.n}) ${c.pick.label}${c.pick.note ? ` - ${c.pick.note}` : ""}`;
	// The card the gateway answers keeps the button's own label as its answer (hub/reply-outcomes.ts pickedSend reads it): a record naming the card would settle it with the batch line,
	// so it names none and the card is settled once the answer is safely recorded.
	const gwOpen = gw.find(c => c.card.notice);
	// Nothing leaves the queue before the answer is recorded: a record that throws loses no card, and its error reaches the caller.
	if (gw.length) await deps.record(conv, `결정 답: ${gw.map(line).join(" · ")}`, gw.map(c => c.pick), false);
	if (bot.length) await deps.record(conv, `결정 답 ${bot.length}건:\n${bot.map(c => `- ${line(c)}`).join("\n")}`, bot.map(c => c.pick), true, bot.find(c => c.card.notice)?.card.notice);
	// Held cards leave the queue before the open card is settled, so settling shows a card that is still waiting, not one answered here.
	deps.take(conv, chosen.filter(c => !c.card.notice).map(c => c.card.ref));
	for (const c of new Set([gwOpen, open])) if (c) deps.settle(c.card.notice!, `${c.pick.n}) ${c.pick.label}`);
	for (const c of gw) {
		if (c.pick.n === 3) await deps.dropDraft?.(c.card.ref);
		else deps.enqueue({ ref: c.card.ref, conv, action: "send", title: c.card.question });
	}
	return { status: 200, body: { ok: true, sending: gw.length, toBot: bot.length } };
}
