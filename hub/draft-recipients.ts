// The 받는 사람·참조 of a mail reply draft, edited from its cards (web/js/10-decision-card.js draftToNode):
//   GET  /api/drafts/<ref>/recipients   { to: [..], cc: [..], mode, editable, reply } - `reply` = the draft answers a mail, so 전체 답장 exists
//   POST /api/drafts/<ref>/recipients   one of { mode: "reply" | "all" } (recomputed from the original mail),
//                                       { to: [addresses] }, { cc: [addresses] } (the owner's own edit); a change is one request
// Only a pending mail draft of reply-drafts can change, and nothing is sent from here (the owner's 보내기 does that). The original mail's
// headers come from the mail record; the owner's own addresses from hub/mail-state.ts (the config aliases and each source's account).
import { addressesOf } from "./reply-draft.ts";
import { getDraft, patchDraft } from "../features/reply-drafts/lib/store.ts";
import { type Recipients, replyRecipients, recipientList, recipientText, parseRecipients, uniqAddresses, type ReplyMode } from "../features/reply-drafts/lib/recipients.ts";
import { mailByKey } from "./mail.ts";

import { ownAddresses } from "./mail-state.ts";
import { updateDraftRecipients } from "./notices.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const editable = (rec: { kind: string; status: string } | undefined) => !!rec && rec.kind === "mail" && rec.status === "pending";

// The sender a 답장 goes to: the address the reply follows (a 회신 주소 first), else the draft's own recipient.
function senderOf(rec: { to: string; item: { from: string; replyTo?: string } }): string {
	return addressesOf(rec.item.replyTo)[0] ?? addressesOf(rec.item.from)[0] ?? recipientList(rec.to)[0] ?? rec.to;
}

export async function draftRecipientsRoute(req: Request, ref: string): Promise<Response> {
	const rec = getDraft(ref);
	const mail = rec && rec.kind === "mail" && !rec.compose ? mailByKey(rec.ref) : undefined;
	// 전체 답장 needs the original mail's headers; a new mail has no answer to answer, and a record that fell away leaves the reply alone.
	const reply = !!rec && rec.kind === "mail" && !rec.compose && !!mail;
	const view = () => ({ to: rec ? recipientList(rec.to) : [], cc: rec?.cc ?? [], mode: rec?.mode ?? "reply", editable: editable(rec), reply });
	if (req.method === "GET") return json(view());
	if (!rec) return json({ error: "이 초안을 찾지 못했어요" }, 404);
	if (!editable(rec)) return json({ error: "이 초안은 이미 처리돼서 받는 사람을 바꿀 수 없어요" }, 409);

	try {
		const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		// The owner's own addresses as the sources registered them; an install that registered none falls back to the mail's 받는 사람
		// (a received mail is addressed to its owner), which keeps an answer from going to oneself.
		const registered = [...ownAddresses()];
		const own = registered.length ? registered : addressesOf((rec.item.to ?? []).join(", "));
		let next: Recipients = { to: recipientList(rec.to), cc: uniqAddresses(rec.cc ?? []) };
		let mode: ReplyMode | undefined = rec.mode ?? (reply ? "reply" : undefined);
		if (b.mode !== undefined) {
			if (b.mode !== "reply" && b.mode !== "all") return json({ error: 'mode는 "reply" 또는 "all"이에요' }, 400);
			if (!rec.compose && !reply) return json({ error: "원래 메일을 찾지 못해서 전체 답장을 고를 수 없어요" }, 409);
			if (rec.compose) return json({ error: "새 메일 초안에는 답장·전체 답장이 없어요" }, 400);
			next = replyRecipients({ sender: senderOf(rec), to: mail!.to, cc: mail!.cc, self: own })[b.mode];
			mode = b.mode;
		}
		for (const row of ["to", "cc"] as const) {
			if (b[row] === undefined) continue;
			const parsed = parseRecipients(b[row], own);
			if (!parsed.ok) return json({ error: parsed.error }, 400);
			next = { ...next, [row]: parsed.list };
		}
		if (!next.to.length) return json({ error: "받는 사람을 한 명 이상 남겨 주세요" }, 400);
		const to = recipientText(next.to);
		if (to === rec.to && (next.cc.join(",") === (rec.cc ?? []).join(",")) && mode === rec.mode) return json({ ok: true, ...view() });
		// A list the owner wrote may hold people the original mail never named; the send's lint lets those through (ownerRecipients).
		const mine = b.to !== undefined || b.cc !== undefined;
		// A draft offered before this feature carries the mail's 받는 사람 as the owner's own addresses; the send's lint would then refuse a
		// colleague on the list. The registered addresses replace that guess.
		const self = registered.length && registered.join(",") !== (rec.item.self ?? []).join(",") ? { item: { ...rec.item, self: registered } } : {};
		patchDraft(rec.id, { to, cc: next.cc, ...(mode ? { mode } : {}), ...(mine ? { ownerRecipients: true as const } : {}), ...self });
		updateDraftRecipients(rec.id, { to, cc: next.cc, ...(mode ? { mode } : {}) });
		const saved = getDraft(rec.id);
		return json({ ok: true, to: saved ? recipientList(saved.to) : next.to, cc: saved?.cc ?? [], mode: saved?.mode ?? mode ?? "reply", editable: editable(saved), reply });
	} catch (error) {
		return json({ error: (error as Error).message }, 400);
	}
}
