import { type DraftRec, listDrafts as listMailDrafts } from "../features/reply-drafts/lib/store.ts";
import { askText } from "./draft-attach.ts";
import { log } from "./config.ts";
import { mailKeyOfRef } from "./draft-handled.ts";
import { mailTarget } from "./mail.ts";
import { openDraftCards } from "./notices.ts";
import { out } from "./outbound.ts";

/**
 * Start-up reconcile for installs where the bot's own mail card (`mail:<mailId>`) took the item and the app's reply draft of that mail lost its card
 * (2026-11-02: a held draft card was dropped as redundant, so the bot card stayed open with no staged files and the draft waited with no card).
 * The app draft's card goes back through out(), so route() finds the open bot card as the same item and rewrites it in place to the draft's ref and
 * its staged files. Idempotent: the rewritten card's ref is the draft code (not `mail:`), so a second pass has nothing to replace. 고치기 keeps the
 * older pending draft as handled, so the newest pending draft of a mail is the card to rescue.
 */
export async function reconcileMailCards(): Promise<number> {
	const waiting = new Map<string, DraftRec>();
	for (const d of listMailDrafts()) {
		if (d.status !== "pending") continue;
		const seen = waiting.get(d.ref);
		if (!seen || seen.created < d.created) waiting.set(d.ref, d);
	}
	let replaced = 0;
	for (const c of openDraftCards()) {
		if (!c.ref.startsWith("mail:")) continue;
		const key = mailKeyOfRef(c.ref, c.to);
		const draft = key ? waiting.get(key) : undefined;
		if (!key || !draft) continue;
		try {
			await out(mailTarget(key), askText(draft, []));
			replaced++;
		} catch (e) {
			log(`approval card ${c.ref} in ${c.to} not replaced by its draft ${draft.id}: ${(e as Error).message}`);
		}
	}
	return replaced;
}
