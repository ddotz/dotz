// The single-card answers of the web (routes.ts) and Discord (main.ts) on a draft the one reply flow knows (hub/reply-wire.ts), and the one
// approval route left beside /api/reply/*:
//   POST /api/approvals/failed           { op: "report", ref, conv, text }: a session's own CLI send of a draft failed; the card shows it and the owner hears it
import { log, now } from "./config.ts";
import { answerDecision, type DecisionSend, allNotices, openDraftCards } from "./notices.ts";
import type { Upload } from "./files.ts";
import { refOfQuestion } from "./approval-send.ts";
import { draftActionOf } from "./draft-approval.ts";
import { type AnswerPick, replies, reportCliFailure, sender } from "./reply-wire.ts";
import type { ActInput } from "./reply-actions.ts";

export { recordAnswer, reportSend, sender, sendTargetOf, settleSends } from "./reply-wire.ts";
import { json } from "./routes-util.ts";

/** The refusal of an answer whose label is not the option's label now: the card changed since the owner looked. */
const STALE_OPTIONS = "카드 선택지가 바뀌었어요. 다시 확인하고 골라 주세요";

/** What a card's picked label asks of the one reply flow, or undefined when the bot reads it (직접 입력, a 고치기 with no words). */
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
export async function discordGatewayAnswer(_target: string, conv: string, text: string, picks: AnswerPick[]): Promise<boolean> {
	const p = picks.length === 1 ? picks[0]! : undefined;
	if (!p) return false;
	const note = /\s-\s(.+)$/.exec(text)?.[1];
	const r = await actOnCard(conv, p.q, p.label, note, "discord", "owner");
	if (r && !r.body.ok) log(`discord pick on ${p.q}: ${r.body.error}`);
	return !!r;
}

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

/** POST /api/approvals/failed with `op: "report"` (hub/followup.ts reportSendFailed); undefined for any other path. */
export async function approvalRoute(req: Request, url: URL): Promise<Response | undefined> {
	if (url.pathname !== "/api/approvals/failed" || req.method !== "POST") return undefined;
	const b = (await req.json().catch(() => ({}))) as { op?: unknown; ref?: unknown; conv?: unknown; text?: unknown };
	if (b.op !== "report") return json({ error: "op must be report" }, 400);
	if (typeof b.ref !== "string" || typeof b.conv !== "string" || typeof b.text !== "string") return json({ error: "ref, conv and text are required" }, 400);
	reportCliFailure(b.ref, b.conv, b.text);
	return json({ ok: true });
}
