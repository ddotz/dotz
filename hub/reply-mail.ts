// The mail and webmail adapter of the one reply flow (the reply unification design, 1.8 columns 1 and 2) and the one learning
// implementation ("record, then refine"). It is the hub's single door into the reply-drafts feature: it imports exactly flow.ts and store.ts,
// and re-exports what the gateway's other modules read of it, so no other hub file needs a feature edge for them.
import { askText, defaultCall, dropDraft, editDraft, realFlowDeps, recordCorrection, refineAfterCorrection, restoreDraft, reviseDraft, type FlowDeps, webmailSite } from "../features/reply-drafts/lib/flow.ts";
import { claimFile, getDraft, listDrafts, patchDraft, setStatus, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { reasonOf } from "./reply-reasons.ts";
import type { DraftView, Lesson, ReasonCode, ReplyAdapter, ReplyKind } from "./reply-types.ts";

export { claimFile, defaultCall, getDraft, patchDraft };

const STATE: Record<DraftRec["status"], DraftView["draft"]["state"]> = { pending: "pending", dropped: "dropped", stale: "stale", sent: "sent", answered: "closed", held: "closed" };
const kindOf = (rec: DraftRec): ReplyKind => (webmailSite(rec.source) ? "webmail" : "mail");

/** The mail record a draft answers (hub/mail.ts mailByKey), read only for a draft that kept no text of it. */
export type MailOf = (key: string) => { from?: string; subject?: string; summary?: string; preview?: string } | undefined;

// What the draft answers, quoted on its card. The reply the owner writes under an open mail (hub/mail-manual.ts) keeps no text of that mail,
// so the card reads the mail record instead: its first lines, else its summary, else its subject.
function originalOf(rec: DraftRec, mailOf: MailOf): NonNullable<DraftView["original"]> {
	const m = rec.item.text.trim() ? undefined : mailOf(rec.ref), subject = rec.item.subject || m?.subject;
	return { who: rec.item.from || m?.from || "", text: m ? m.preview || m.summary || subject || "" : rec.item.text, ...(subject ? { subject } : {}) };
}

function viewOf(rec: DraftRec, mailOf: MailOf): DraftView {
	const pending = rec.status === "pending";
	const before = rec.replaces ? getDraft(rec.replaces) : undefined;
	return {
		item: `mail:${rec.ref}`,
		ref: rec.id,
		kind: kindOf(rec),
		app: rec.profile ?? rec.app,
		label: rec.compose ? "새 메일" : "메일",
		conv: `mail:${rec.ref}`,
		at: Date.parse(rec.created) || 0,
		can: { send: pending, revise: pending, edit: pending, drop: pending, restore: rec.status === "dropped" },
		draft: {
			state: STATE[rec.status],
			toLabel: "받는이",
			to: rec.to,
			...(rec.cc?.length ? { cc: rec.cc } : {}),
			...(rec.subject ? { subject: rec.subject } : {}),
			text: rec.body,
			...(rec.rule ? { rule: rec.rule.name } : {}),
			...(before ? { replaces: { ref: before.id, text: before.body } } : {}),
			...(rec.editedFrom !== undefined ? { edited: true as const } : {}),
		},
		...(rec.compose ? {} : { original: originalOf(rec, mailOf) }),
	};
}

const known = (ref: string): DraftRec | undefined => {
	const rec = getDraft(ref);
	return rec?.kind === "mail" ? rec : undefined;
};
const done = (r: { ok: boolean; text: string }, code: ReasonCode = "not_pending") => (r.ok ? { ok: true as const } : { ok: false as const, reason: { code, text: r.text } });

/** The mail and webmail adapter over the reply-drafts store; `deps` gives the model and tool runner of a revise (the real ones by default), `mailOf` the mail records. */
export function mailAdapter(deps: () => FlowDeps = realFlowDeps, mailOf: MailOf = () => undefined): ReplyAdapter {
	return {
		kind: "mail",
		get: async ref => {
			const rec = known(ref);
			return rec ? viewOf(rec, mailOf) : undefined;
		},
		list: async () => listDrafts().filter(d => d.kind === "mail" && d.status === "pending").map(d => viewOf(d, mailOf)),
		target: ref => {
			const rec = known(ref);
			if (!rec) return undefined;
			const site = webmailSite(rec.source);
			return { kind: "mail", lane: site ? `mail:${site}` : `mail:${rec.source}:${rec.account ?? ""}` };
		},
		revise: async (ref, change) => {
			const r = await reviseDraft(ref, change, deps(), { learn: false });
			if (!r.ok || !r.id) return { ok: false, reason: { code: "revise_failed", text: r.text || reasonOf("revise_failed").text } };
			return { ok: true, ref: r.id, replaces: ref, ...(r.lesson ? { lesson: r.lesson as Lesson } : {}) };
		},
		edit: async (ref, text) => {
			const r = editDraft(ref, text);
			if (r.ok) return { ok: true };
			return { ok: false, reason: { code: (r.code as ReasonCode | undefined) ?? "not_pending", text: r.text }, ...(r.lint ? { lint: r.lint } : {}) };
		},
		drop: async ref => done(dropDraft(ref)),
		restore: async ref => done(restoreDraft(ref)),
		markSent: async ref => {
			const rec = known(ref);
			if (!rec) return { ok: false, reason: reasonOf("gone") };
			if (rec.status !== "sent") setStatus(ref, "sent");
			return { ok: true };
		},
		// Proof can say "sent", never "not sent": the draft itself, or the mail answered since.
		prove: async ref => (["sent", "answered"].includes(known(ref)?.status ?? "") ? "sent" : "unknown"),
		repair: async (ref, code) => {
			const rec = known(ref);
			if (!rec) return "failed";
			if (code === "subject_re" && rec.subject !== undefined && !/^re\s*:/i.test(rec.subject.trim())) {
				patchDraft(ref, { subject: `Re: ${rec.subject.trim()}` });
				return "fixed";
			}
			// A rejected mail login (zele, or a webmail with no kept login) needs the owner.
			return "needs_owner";
		},
		ask: async (ref, headline) => {
			const rec = known(ref);
			return rec ? askText(rec, [], headline) : undefined;
		},
		question: ref => `${known(ref)?.compose ? "이 메일 보낼까요?" : "이 답장 보낼까요?"} (${ref})`,
	};
}

/** The one "record, then refine" of every kind (design 3.4): a lesson line enters its tone profile, and every few fold into the identity. */
export function replyLearning(deps: () => FlowDeps = realFlowDeps) {
	return {
		record: async (key: Lesson["key"], line: string) => recordCorrection(key, line, new Date()),
		refine: (key: Lesson["key"]) => refineAfterCorrection(key, deps()),
	};
}
