// A mail draft that rides on a comment reply: the comment draft names it (Draft.mail) and one pick on the reply's card approves both.
// The mail then is not sent on its own: hub/mail-cli.ts send and features/reply-drafts sendDraft refuse it and point to the reply's send.
import { type DraftPart } from "../draft-approval.ts";
import { dataDir } from "../../features/reply-drafts/lib/settings.ts";
import { stagedFiles } from "../../features/reply-drafts/lib/staged.ts";
import { type DraftRec, getDraft, setStatus } from "../../features/reply-drafts/lib/store.ts";
import type { MailView } from "./engine.ts";
import { commentsDir, createStore, type Draft, type Store } from "./store.ts";

/** The pending comment draft that carries the mail draft `mailId`, or undefined when it is a mail of its own. */
export const linkedComment = (mailId: string): string | undefined => createStore(commentsDir(dataDir())).drafts().find(d => d.status === "pending" && d.mail === mailId)?.code;

/** Puts the mail draft on the comment draft `code` (a mail attached before is dropped). The card is new then: `mailAt` keeps older picks from approving it. */
export function attachMail(store: Store, code: string, mailId: string, now: number): Draft {
	const d = store.drafts().find(x => x.code === code)!;
	if (d.mail && d.mail !== mailId) setStatus(d.mail, "dropped");
	const next: Draft = { ...d, mail: mailId, mailAt: now, clean: false };
	store.putDraft(next);
	return next;
}

/** The mail draft as the card shows it. */
export function mailPartOf(rec: DraftRec): DraftPart {
	const attachments = stagedFiles(rec.id).map(f => ({ name: f.name, size: f.size }));
	return { to: rec.to, ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, ...(attachments.length ? { attachments } : {}), ...(rec.asksFile ? { asksFile: true } : {}), ...(rec.libraryMiss ? { libraryMiss: true } : {}) };
}

/** The pending mail draft `id` for the engine (card, sheet), or undefined when it is gone or already handled. */
export function mailViewOf(id: string): MailView | undefined {
  const rec = getDraft(id);
  if (!rec || rec.status !== "pending") return undefined;
  return { id: rec.id, to: rec.to, ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, attachments: stagedFiles(rec.id).map(f => ({ name: f.name, size: f.size })), ...(rec.asksFile ? { asksFile: true } : {}), ...(rec.libraryMiss ? { libraryMiss: true } : {}) };
}
