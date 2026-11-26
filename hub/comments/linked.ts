// A mail draft that rides on a comment reply: the comment draft names it (Draft.mail) and one pick on the reply's card approves both.
// The mail then is not sent on its own: hub/mail-cli.ts send and features/reply-drafts sendDraft refuse it and point to the reply's send.
import { type DraftPart, PAIR_NOTE, pairCheck } from "../draft-approval.ts";
import { dataDir } from "../../features/reply-drafts/lib/settings.ts";
import { fileDigest, stagedFiles } from "../../features/reply-drafts/lib/staged.ts";
import { type DraftRec, getDraft, setStatus } from "../../features/reply-drafts/lib/store.ts";
import type { MailView } from "./engine.ts";
import { commentsDir, createStore, type Draft, type Store } from "./store.ts";

/** The pending comment draft that carries the mail draft `mailId`, or undefined when it is a mail of its own. */
export const linkedComment = (mailId: string): string | undefined => createStore(commentsDir(dataDir())).drafts().find(d => d.status === "pending" && d.mail === mailId)?.code;

/** The comment a mail draft rode on (the comment draft that carries it, or kept it after 메일만 보내기), whatever their states: its source key and text. */
export function mailComment(mailId: string): { source: string; text: string } | undefined {
	const store = createStore(commentsDir(dataDir()));
	const d = store.drafts().findLast(x => x.mail === mailId || x.mailKept === mailId);
	const c = d && store.comments().find(x => x.id === d.commentId);
	return d && c ? { source: d.source, text: c.text } : undefined;
}

/** The mail drafts that ride on a pending comment draft: the reply queue shows each inside that reply's card, not as a card of its own. */
export const ridingMails = (): Set<string> => new Set(createStore(commentsDir(dataDir())).drafts().flatMap(d => (d.status === "pending" && d.mail ? [d.mail] : [])));
/** The mail drafts that went out together with a comment reply (the reply's send record carries a sent mail outcome): that reply's row shows each, so it is never a sent row of its own.
 * A mail that failed after its reply was posted, or was left behind by 답글만 보내기 and sent later alone, is not one of them. */
export const pairedMails = (): Set<string> => {
	const store = createStore(commentsDir(dataDir()));
	const together = new Set(store.replies().filter(r => r.mail?.state === "sent").map(r => r.draft));
	return new Set(store.drafts().flatMap(d => (d.mail && together.has(d.code) ? [d.mail] : [])));
};
/** Puts the mail draft on the comment draft `code` (a mail attached before is dropped). The card is new then: `mailAt` keeps older picks from approving it.
 * The reply is checked against the mail (pairCheck): what disagrees is a "확인:" line on the card. */
export function attachMail(store: Store, code: string, mailId: string, now: number): Draft {
	const d = store.drafts().find(x => x.code === code)!;
	if (d.mail && d.mail !== mailId) setStatus(d.mail, "dropped");
	const next: Draft = { ...d, mail: mailId, mailAt: now, clean: false, notes: [...d.notes.filter(n => !PAIR_NOTE.test(n)), ...pairCheck(d.text, mailViewOf(mailId), true)] };
	store.putDraft(next);
	return next;
}

/** The mail draft as the card shows it; `from` is the account its send goes out from (features/reply-drafts sendAccountOf), none when the caller has none to name. */
export function mailPartOf(rec: DraftRec, from: { account?: string; held?: true } = {}): DraftPart {
	const attachments = stagedFiles(rec.id).map(f => ({ name: f.name, size: f.size }));
	return { id: rec.id, to: rec.to, ...(from.account ? { account: from.account } : {}), ...(from.held ? { accountHeld: true as const } : {}), ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, ...(attachments.length ? { attachments } : {}), ...(rec.asksFile ? { asksFile: true } : {}), ...(rec.libraryMiss ? { libraryMiss: true } : {}) };
}

const viewOfRec = (rec: DraftRec): MailView => ({ id: rec.id, to: rec.to, ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, attachments: stagedFiles(rec.id).map(f => ({ name: f.name, size: f.size, digest: fileDigest(f.path) })), ...(rec.asksFile ? { asksFile: true } : {}), ...(rec.libraryMiss ? { libraryMiss: true } : {}) });

/** The pending mail draft `id` for the engine (card, sheet), or undefined when it is gone or already handled. */
export function mailViewOf(id: string): MailView | undefined {
	const rec = getDraft(id);
	return rec && rec.status === "pending" ? viewOfRec(rec) : undefined;
}

/** The mail draft `id` as its store record holds it now, whatever its state (a sent mail too): what a sent reply's row shows of the mail that went with it. */
export function mailRecordOf(id: string): MailView | undefined {
	const rec = getDraft(id);
	return rec ? viewOfRec(rec) : undefined;
}
