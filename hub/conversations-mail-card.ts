import type { ConvRow } from "./conversations-page.ts";
import { originalDeletable } from "./mail-delete.ts";
import { canOf, type SyncDeps } from "./mail-sync.ts";
import { mailByKey, mailCard } from "./mail.ts";
import { boxPass } from "./routes-mailbox.ts";

/** The `build` of conversationPage for GET /api/conversations: the full card of a mail row that goes out. The card's deps (the trash check and the mailbox placement read the mail folder) are made on the first card, so a page with no mail row makes none. */
export function lazyMailCard(o: { owed: ReadonlySet<string>; sent: ReadonlySet<string>; dataDir: string; syncDeps: SyncDeps }): (c: ConvRow) => ConvRow {
	let deps: { trashable: ReturnType<typeof originalDeletable>; place: ReturnType<typeof boxPass> } | undefined;
	return c => {
		const m = mailByKey(c.target.slice(5))!, { trashable, place } = (deps ??= { trashable: originalDeletable(o.dataDir, o.syncDeps), place: boxPass(o.dataDir) });
		return { ...c, mail: mailCard(m, o.owed.has(m.key), o.sent.has(m.key), { read: c.unread === 0, can: canOf(m.source, o.syncDeps), trashOriginal: trashable(m), place }) };
	};
}
