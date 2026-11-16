// A mail draft as the one reply flow shows it (hub/reply-types.ts DraftView), and the approval fingerprint of that view. The gateway's mail
// adapter (hub/reply-mail.ts) draws its cards from it and the send CLI's gate (flow.ts sendDraft) hashes it, so the version the owner approved
// and the version a CLI would send are read the same way in both processes.
import { approvalHash, fileSizeText } from "../../../hub/draft-approval.ts";
import type { DraftView, ReplyKind } from "../../../hub/reply-types.ts";
import { webmailSite } from "./senders.ts";
import { fileDigest, stagedFiles } from "./staged.ts";
import { getDraft, type DraftRec } from "./store.ts";

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

export function mailView(rec: DraftRec, mailOf: MailOf = () => undefined): DraftView {
	const pending = rec.status === "pending";
	const before = rec.replaces ? getDraft(rec.replaces) : undefined;
	const attachments = stagedFiles(rec.id).map(f => ({ name: f.name, size: fileSizeText(f.size), digest: fileDigest(f.path) }));
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
			...(attachments.length ? { attachments } : {}),
			...(rec.rule ? { rule: rec.rule.name } : {}),
			...(before ? { replaces: { ref: before.id, text: before.body } } : {}),
			...(rec.editedFrom !== undefined ? { edited: true as const } : {}),
		},
		...(rec.compose ? {} : { original: originalOf(rec, mailOf) }),
	};
}

/** The approvalHash of mail draft `rec` as it is stored now (the original it answers is not part of it). */
export const mailHash = (rec: DraftRec): string => approvalHash(mailView(rec));
