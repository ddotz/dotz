// The mail and webmail adapter of the one reply flow (the reply unification design, 1.8 columns 1 and 2) and the one learning
// implementation ("record, then refine"). It is the hub's single door into the reply-drafts feature: it imports exactly flow.ts and store.ts,
// and re-exports what the gateway's other modules read of it, so no other hub file needs a feature edge for them.
import { askText, defaultCall, dropDraft, editDraft, mailView, realFlowDeps, recordCorrection, refineAfterCorrection, restoreDraft, reviseDraft, type FlowDeps, type MailOf, webmailSite } from "../features/reply-drafts/lib/flow.ts";
import { claimFile, DRAFT_ID, draftStoreIntact, getDraft, listDrafts, patchDraft, setStatus, unlessUnreadable, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { pairedMails, ridingMails } from "./comments/linked.ts";
import { sinceMidnight } from "./reply-route.ts";
import { reasonOf } from "./reply-reasons.ts";
import type { DraftView, Lesson, ReasonCode, ReplyAdapter } from "./reply-types.ts";

export { claimFile, defaultCall, DRAFT_ID, draftStoreIntact, getDraft, listDrafts, patchDraft, unlessUnreadable };

const known = (ref: string): DraftRec | undefined => {
	const rec = getDraft(ref);
	return rec?.kind === "mail" ? rec : undefined;
};
const done = (r: { ok: boolean; text: string }, code: ReasonCode = "not_pending") => (r.ok ? { ok: true as const } : { ok: false as const, reason: { code, text: r.text } });
/** The lane a pending mail draft is sent in: a webmail site's own, else its source and sending account. */
export const mailLane = (rec: DraftRec): string => {
	const site = webmailSite(rec.source);
	return site ? `mail:${site}` : `mail:${rec.source}:${rec.account ?? ""}`;
};
const sentAtOf = (rec: DraftRec): number | undefined => {
	const at = rec.status === "sent" && rec.sentAt ? Date.parse(rec.sentAt) : Number.NaN;
	return Number.isFinite(at) ? at : undefined;
};

/** The mail and webmail adapter over the reply-drafts store; `deps` gives the model and tool runner of a revise (the real ones by default), `mailOf` the mail records. */
export function mailAdapter(deps: () => FlowDeps = realFlowDeps, mailOf: MailOf = () => undefined): ReplyAdapter {
	const viewOf = (rec: DraftRec): DraftView => {
		const at = sentAtOf(rec);
		return at === undefined ? mailView(rec, mailOf) : { ...mailView(rec, mailOf), sent: { at, how: "owner" } };
	};
	return {
		kind: "mail",
		get: async ref => {
			const rec = known(ref);
			// The same view the send CLI's gate hashes (features/reply-drafts/lib/view.ts).
			return rec ? viewOf(rec) : undefined;
		},
		// A mail riding on a waiting comment reply is part of that reply's card (one item, one 보내기); once the reply is gone it is listed on its own.
		list: async () => {
			const riding = ridingMails(), paired = pairedMails();
			return listDrafts().filter(d => d.kind === "mail" && ((d.status === "pending" && !riding.has(d.id)) || (!paired.has(d.id) && sinceMidnight(sentAtOf(d) ?? Number.NEGATIVE_INFINITY)))).map(viewOf);
		},
		target: ref => {
			const rec = known(ref);
			if (!rec) return undefined;
			return { kind: "mail", lane: mailLane(rec) };
		},
		revise: async (ref, change) => {
			const r = await reviseDraft(ref, change, deps(), { learn: false });
			if (!r.ok || !r.id) return { ok: false, reason: { code: "revise_failed", text: r.text || reasonOf("revise_failed").text } };
			return { ok: true, ref: r.id, replaces: ref, ...(r.lesson ? { lesson: r.lesson as Lesson } : {}) };
		},
		edit: async (ref, text, _part, subject) => {
			const r = editDraft(ref, text, subject);
			if (r.ok) return { ok: true };
			return { ok: false, reason: { code: (r.code as ReasonCode | undefined) ?? "not_pending", text: r.text }, ...(r.lint ? { lint: r.lint } : {}) };
		},
		drop: async ref => done(dropDraft(ref)),
		restore: async ref => {
			const r = await restoreDraft(ref, deps());
			return done(r, r.code ?? "not_pending");
		},
		markSent: async ref => {
			const rec = known(ref);
			if (!rec) return { ok: false, reason: reasonOf("gone") };
			if (rec.status === "pending") setStatus(ref, "sent");
			else if (rec.status !== "sent") return { ok: false, reason: reasonOf("not_pending") };
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
