// Is the item behind a send approval already handled? hub/notices.ts settleHandledDrafts asks this for every open draft decision, at start and on a timer,
// so a draft sent, dropped, replaced, answered by the owner himself or gone at its source leaves the answer-needed list whichever path handled it.
// Pure: each app answers from its own store through the facts below (hub/main.ts wires the real ones).
//
//   undefined = the app does not know this draft (another app's ref, or its store is unreadable): the notice stays as it is.

/** A reply draft of the mail app (features/reply-drafts): `ref` is the mail key the draft answers. */
export type MailDraftLike = { id: string; ref: string; status: string; created: string };
export type MailFacts = {
	drafts: () => MailDraftLike[];
	/** The stored mail: reply skipped / fyi (or the older noReply flag) = no reply wanted, suggest.state = the reply state ("sent" = a reply went out, also when sent from his own client). Missing = deleted at the source. */
	record: (key: string) => { reply?: string; noReply?: boolean; suggest?: { state?: string } } | undefined;
};
export function mailDraftHandled(code: string, f: MailFacts): boolean | undefined {
	const all = f.drafts();
	const d = all.find(x => x.id === code);
	if (!d) return undefined;
	if (d.status !== "pending") return true;
	// 고치기 makes a new draft for the same mail: the older pending one is replaced.
	if (all.some(x => x.id !== d.id && x.ref === d.ref && x.status === "pending" && x.created > d.created)) return true;
	const m = f.record(d.ref);
	return !m || mailEnded(m);
}
const mailEnded = (m: NonNullable<ReturnType<MailFacts["record"]>>) => m.reply === "replied" || m.reply === "skipped" || m.reply === "fyi" || m.noReply === true || m.suggest?.state === "sent";

/** The mail key behind a bot-written `mail:<mailId>` card, read from the conversation it was posted in (`mail:<key>`, key = `<instance>-<mailId>`); undefined when the conversation is not that mail's. */
export function mailKeyOfRef(ref: string, conv: string | undefined): string | undefined {
	const id = ref.startsWith("mail:") ? ref.slice(5) : "";
	const key = conv?.startsWith("mail:") ? conv.slice(5) : "";
	return id && key && (key === id || key.endsWith(`-${id}`)) ? key : undefined;
}
/**
 * A bot-written `mail:<mailId>` card: handled when its mail is gone, answered (from here or his own client), skipped / fyi / noReply, or a reply draft of it was sent.
 * A pending app draft of the same mail does not make it handled (that draft's own card is the same item, see mailItemKey).
 * The conversation carries the key, so the check never guesses a key from the id alone: a conversation that is not that mail's is unknown (undefined).
 */
export function mailRefHandled(ref: string, conv: string | undefined, f: MailFacts): boolean | undefined {
	const key = mailKeyOfRef(ref, conv);
	if (!key) return undefined;
	const m = f.record(key);
	return !m || mailEnded(m) || f.drafts().some(d => d.ref === key && d.status === "sent");
}
/** The item a send-approval card is about, so two cards of one mail (the bot's `mail:<mailId>` and the app's reply draft) count as one; other refs are their own item. */
export function mailItemKey(ref: string, conv: string, drafts: () => MailDraftLike[]): string {
	if (ref.startsWith("mail:")) {
		const key = mailKeyOfRef(ref, conv);
		return key ? `mail:${key}` : ref;
	}
	const d = drafts().find(x => x.id === ref);
	return d ? `mail:${d.ref}` : ref;
}

/** A reply draft of a comment source (hub/comments): handled when the comment no longer waits (reply sent, answered on the platform, 답장 안 함, deleted). */
export type CommentDraftLike = { code: string; commentId: string; status: string; created: number };
export type CommentFacts = {
	drafts: () => CommentDraftLike[];
	/** undefined = the comment is gone; else whether it still waits for a reply. */
	waiting: (commentId: string) => boolean | undefined;
};
export function commentDraftHandled(code: string, f: CommentFacts): boolean | undefined {
	const all = f.drafts();
	const d = all.find(x => x.code === code);
	if (!d) return undefined;
	if (d.status !== "pending") return true;
	if (all.some(x => x.code !== d.code && x.commentId === d.commentId && x.status === "pending" && x.created > d.created)) return true;
	return f.waiting(d.commentId) !== true;
}

/** A KakaoTalk reply draft: handled when the room no longer waits (his own message in the room, a finished send, 답장 안 함). */
export type KakaoDraftLike = { code: string; chatId: string; status: string; created: string };
export type KakaoFacts = {
	drafts: () => Promise<KakaoDraftLike[]>;
	/** undefined = the room is not watched or the database cannot be read; else whether the room still waits for a reply. */
	waiting: (chatId: string) => Promise<boolean | undefined>;
};
export async function kakaoDraftHandled(code: string, f: KakaoFacts): Promise<boolean | undefined> {
	const all = await f.drafts();
	const d = all.find(x => x.code === code);
	if (!d) return undefined;
	if (d.status !== "pending") return true;
	if (all.some(x => x.code !== d.code && x.chatId === d.chatId && x.status === "pending" && x.created > d.created)) return true;
	const w = await f.waiting(d.chatId);
	return w === undefined ? false : !w;
}

export type AllFacts = { mail: MailFacts; comment: CommentFacts; kakao: KakaoFacts };
/** The ref of a send approval is a draft id (mail), a draft code (comment, kakao). The first app that knows it answers. */
export async function draftHandled(ref: string, facts: AllFacts, conv?: string): Promise<boolean> {
	if (ref.startsWith("mail:")) return mailRefHandled(ref, conv, facts.mail) ?? false;
	return mailDraftHandled(ref, facts.mail) ?? commentDraftHandled(ref, facts.comment) ?? (await kakaoDraftHandled(ref, facts.kakao)) ?? false;
}
