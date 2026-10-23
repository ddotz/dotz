// The app item a watch report points at (a `DOTZ_ITEM <app>:<id>` line, hub/watchtext.ts itemRefOf), as the card the app draws for it.
// The one place that turns a reference into something to show: a mail on this hub is its stored record (hub/mail.ts mailCard, what the mail row
// draws); anything else keeps the reference and the subject / sender the check printed. The web (web/js/30-monitoring.js itemCardOf) is the
// other half: it prefers the live copy it already holds and falls back to this card.
import { mailByKey, mailCard, mailKey } from "./mail.ts";
import type { ItemRef } from "./watchtext.ts";

export type WatchItem = { app: string; id: string; key?: string; card?: ReturnType<typeof mailCard> | { subject?: string; from?: string } };

function mailRecordOf(id: string) {
	const slash = id.indexOf("/");
	try {
		return mailByKey(slash > 0 ? mailKey(id.slice(0, slash), id.slice(slash + 1)) : id) ?? mailByKey(id);
	} catch {
		return undefined;
	}
}

export function resolveItem(ref: ItemRef): WatchItem {
	const item: WatchItem = { app: ref.app, id: ref.id };
	const said = ref.subject || ref.from ? { ...(ref.subject ? { subject: ref.subject } : {}), ...(ref.from ? { from: ref.from } : {}) } : undefined;
	const mail = ref.app === "mail" ? mailRecordOf(ref.id) : undefined;
	if (mail) return { ...item, key: mail.key, card: mailCard(mail) };
	return said ? { ...item, card: said } : item;
}
