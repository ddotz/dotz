// The single-card answers of the web (routes.ts) and Discord (main.ts) on a draft the one reply flow knows (hub/reply-wire.ts), and the one
// approval route left beside /api/reply/*:
//   POST /api/approvals/failed           { op: "report", ref, conv, text }: a session's own CLI send of a draft failed; the card shows it and the owner hears it
import { log } from "./config.ts";
import { answerDecision, type DecisionSend, type Notice, allNotices, openDraftCards } from "./notices.ts";
import type { Upload } from "./files.ts";
import { refOfQuestion } from "./approval-send.ts";
import { draftActionOf, questionRef } from "./draft-approval.ts";
import { escalations } from "./escalate.ts";
import { type AnswerPick, replies, reportCliFailure, sender } from "./reply-wire.ts";
import type { ActInput, ActResult } from "./reply-actions.ts";
import { reasonOf } from "./reply-reasons.ts";
import { msg } from "./i18n.ts";
import { DECISION_HEAD, unnumbered } from "./choices.ts";
import { heldOf } from "./notices-answers.ts";
import { noTurnLine } from "./card-answer.ts";

export { recordAnswer, reportSend, sender, sendTargetOf, settleSends } from "./reply-wire.ts";
import { json } from "./routes-util.ts";

/** The refusal of an answer whose label is not the option's label now: the card changed since the owner looked. */
const STALE_OPTIONS = "카드 선택지가 바뀌었어요. 다시 확인하고 골라 주세요";

/** A card only the owner may settle: a send approval, a card naming a draft ref, a stronger-model request or a login request. An agent's call (the hub token) never closes, ignores or reopens one. */
export const ownerOnlyCard = (card: Notice): boolean => {
	const d = card.decision;
	return !!d && (!!d.draft || questionRef(card.title) !== undefined || d.to.startsWith("auth:") || d.options.some(o => !!escalations()?.answers({ to: d.to, label: o.label })));
};

/** What a card's picked label asks of the one reply flow, or undefined when the bot reads it (직접 입력, a 고치기 with no words). */
function replyInputOf(ref: string, label: string, note?: string): ActInput | undefined {
	const a = draftActionOf(label);
	if (a === "send" || a === "send-as-is") return { ref, action: "send", ...(a === "send-as-is" ? { asIs: true } : {}) };
	if (a === "send-main" || a === "send-mail") return { ref, action: "send", part: a === "send-main" ? "reply" : "mail" };
	if (a === "drop") return { ref, action: "drop" };
	if (a === "edit" && note?.trim()) return { ref, action: "revise", change: note.trim() };
	return undefined;
}
/** How a pick reached the card: `agent` (the hub token, never the owner's word), `hash` (the version the web page showed; absent: the one the
 * card stored when it was drawn; on Discord always the one its message shows, hub/notices-drafts.ts) and `text` (고치기 with the owner's own text: saved first, then his words, if any, revise it). */
type CardPick = { surface: "web" | "discord"; login: string; agent?: boolean; hash?: string; text?: string };
/** A pick on an open card whose draft an adapter knows, as one act of the reply flow; undefined = the answer keeps its old path. */
async function actOnCard(conv: string, q: string, label: string, note: string | undefined, o: CardPick): Promise<ActResult | undefined> {
	const ref = refOfQuestion(q);
	const card = ref && !conv.startsWith("lane:") && !conv.startsWith("auth:") ? openDraftCards(conv).find(c => c.ref === ref) : undefined;
	if (!ref || !card) return undefined;
	const input = o.text !== undefined ? undefined : replyInputOf(ref, label, note);
	if ((o.text === undefined && !input) || !(await replies.list()).some(i => i.ref === ref && i.kind !== "card")) return undefined;
	const ctx = { surface: o.surface, login: o.login, ...(o.agent ? { agent: true } : {}) };
	if (o.text !== undefined) return replies.amend({ ref, text: o.text, ...(note?.trim() ? { change: note } : {}) }, ctx);
	// No version known for what the surface showed (""): a send is refused `changed` and the card drawn anew (hub/reply-actions.ts act).
	const hash = o.surface === "discord" ? (card.discord ?? "") : (o.hash ?? card.hash ?? "");
	return replies.act({ ...input!, hash }, ctx);
}

/** A Discord button pick (hub/askbuttons.ts) on a draft the reply flow knows: the same act as the web's card (send, revise with its words, drop),
 * checked against the version the card was drawn with. `edit`: the 고치기 form's text, changed by the owner (edit, then revise if he wrote words).
 * A pick on a card whose web answer is held for its undo window (hub/notices-answers.ts holdDecision) is refused with that answer's label: it is not sent.
 * A pick that closes its card with no model turn (hub/card-answer.ts noTurnLine: an option the gateway marked as changing nothing) is answered here as on the web.
 * Undefined when the reply flow did not take it (the answer keeps its old path); `error`: why it refused (the owner hears it, the buttons stay). */
export async function discordGatewayAnswer(target: string, conv: string, text: string, picks: AnswerPick[], edit?: string): Promise<{ error?: string } | undefined> {
	const p = picks.length === 1 ? picks[0]! : undefined;
	if (!p) return undefined;
	const q = DECISION_HEAD.exec(p.q)?.[1] ?? p.q, card = allNotices().find(n => n.decision?.state === "open" && n.title === q && (n.decision.to === target || n.decision.to === conv)), hold = card && heldOf(card);
	if (hold) return { error: msg().answerHeld(hold.label.replace(/^\d+\)\s*/, "")) };
	const picked = card?.decision?.options.find(o => o.n === p.n && unnumbered(o.label) === unnumbered(p.label));
	if (card && picked && noTurnLine(card, picked)) {
		const r = await answerDecision(card.id, { n: picked.n }, async () => undefined);
		return r.status === 200 ? {} : { error: String(r.body.error) };
	}
	const note = p.note ?? /\s-\s(.+)$/.exec(text)?.[1];
	const r = await actOnCard(conv, p.q, p.label, note, { surface: "discord", login: "owner", ...(edit !== undefined ? { text: edit } : {}) });
	if (!r) return undefined;
	if (r.body.ok) return {};
	log(`discord pick on ${p.q}: ${r.body.error}`);
	// The Discord message may still show the old text (a card of several messages or with a [file] line is not edited there): the web shows the draft.
	return { error: r.body.code === "changed" ? DISCORD_CHANGED : r.body.error };
}
const DISCORD_CHANGED = "초안이 바뀌었어요. 보내지 않았어요. 웹앱 답장 대기에서 지금 초안을 확인하고 보내 주세요";

/**
 * A card's button on the web (POST /api/notices/<id>/answer). 보내기 on a draft the gateway can send is recorded with no model turn, the
 * card closes (its queue shows the next one at once) and the send is queued; 직접 수정 files ride to the bot, so such an answer keeps its path.
 */
export async function webAnswer(id: string, body: { n?: unknown; label?: unknown; note?: unknown; hash?: unknown; files?: Upload[]; handoff?: unknown }, login: string, deliver: DecisionSend, agent = false) {
	const card = allNotices().find(n => n.id === id);
	const d = card?.decision;
	const opt = d?.state === "open" ? d.options.find(o => o.n === Number(body.n)) : undefined;
	const ownersOnly = agent && !!card && ownerOnlyCard(card);
	// The hub token is an agent's, never the owner's word: on a draft's card it may only ask for a change (고치기), on any path the answer takes.
	if (ownersOnly && !(d!.draft?.ref && draftActionOf(opt?.label ?? "") === "edit")) return { status: 403, body: { code: "owner_only", error: reasonOf("owner_only").text } };
	// The page names the label it showed for `n`: a card whose options changed since (a staged file moves 이대로 보내기 and 답글만) answers 409 instead of running another action. No label = as before.
	if (typeof body.label === "string" && card?.decision?.state === "open" && opt?.label !== body.label) return { status: 409, body: { error: STALE_OPTIONS } };
	// A draft the reply flow knows: its act writes the pick, settles or moves the card and queues the send. Files ride to the bot as before.
	const pick: CardPick = { surface: "web", login, ...(agent ? { agent } : {}), ...(typeof body.hash === "string" ? { hash: body.hash } : {}) };
	const acted = card && opt && !body.files?.length ? await actOnCard(card.decision!.to, card.title, opt.label, typeof body.note === "string" ? body.note : undefined, pick) : undefined;
	if (acted) {
		if (!acted.body.ok) return { status: acted.status, body: { code: acted.body.code, error: acted.body.error, ...(acted.body.item ? { item: acted.body.item } : {}) } };
		const held = sender.results().find(x => x.ref === refOfQuestion(card!.title) && x.state === "undo");
		return { status: 200, body: { ok: true, ...(held ? { send: { state: held.state, until: held.until, left: Math.max(0, (held.until ?? 0) - Date.now()) } } : {}) } };
	}
	if (ownersOnly) return { status: 403, body: { code: "owner_only", error: reasonOf("owner_only").text } };
	return answerDecision(id, body, deliver);
}

/** POST /api/approvals/failed with `op: "report"` (hub/followup.ts reportSendFailed); undefined for any other path. */
export async function approvalRoute(req: Request, url: URL): Promise<Response | undefined> {
	if (url.pathname !== "/api/approvals/failed" || req.method !== "POST") return undefined;
	const b = (await req.json().catch(() => ({}))) as { op?: unknown; ref?: unknown; conv?: unknown; text?: unknown };
	if (b.op !== "report") return json({ error: "op must be report" }, 400);
	if (typeof b.ref !== "string" || typeof b.conv !== "string" || typeof b.text !== "string") return json({ error: "ref, conv and text are required" }, 400);
	reportCliFailure(b.ref, b.conv, b.text);
	return json({ ok: true });
}
