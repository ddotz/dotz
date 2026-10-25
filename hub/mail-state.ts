// One place for what a mail item IS (hub/mail.ts keeps the records): its direction and, for an incoming one, its reply state.
//
// Direction: every mail is incoming ("in") or outgoing ("out"). Outgoing = written by the owner: its sender is one of his own addresses
// (the accounts `zele whoami` lists, aliases from config.json `mail.own_addresses` / `zele.aliases`, plus-tags and Gmail dots ignored),
// or the poster says so (`direction: "out"`, a sent `folder`: SENT / 보낸편지함, or a SENT label). An outgoing mail is listed under 보낸 메일
// and never counts as unread, never wakes the bot, never gets a reply draft.
//
// Reply state of an incoming thread, kept apart from read / unread (reading never changes it):
//   (none)  nothing is expected          needs   답장 필요        draft  초안 있음 (a draft waits for approval)
//   replied 답장함 (sent by dotz, or an outgoing mail of his found later in the thread)
//   skipped 답장 안 함 (his mark)         fyi     참고만 (no reply needed, his mark)
// `nextReply` is the only place that moves between them.
export type MailDirection = "in" | "out";
export type MailReply = "needs" | "draft" | "replied" | "skipped" | "fyi";
/** need = a reply is expected; draft = a reply draft was offered; sent = a reply went out (dotz) or his own mail was found in the thread;
 *  skip / fyi = his marks; reopen = he took a mark back. */
export type MailReplyEvent = "need" | "draft" | "sent" | "skip" | "fyi" | "reopen";

export const REPLY_LABEL: Readonly<Record<MailReply, string>> = { needs: "답장 필요", draft: "초안 있음", replied: "답장함", skipped: "답장 안 함", fyi: "참고만" };
/** The label of a mail row: outgoing = 내가 보냄; incoming = its reply state, else 읽음 / 새 메일. */
export function mailLabel(dir: MailDirection, read: boolean, reply?: MailReply): string {
	return dir === "out" ? "내가 보냄" : reply ? REPLY_LABEL[reply] : read ? "읽음" : "새 메일";
}

/** The transition table. A sent reply wins over everything; his marks only replace an open state; a new expectation never reopens a closed one. */
export function nextReply(cur: MailReply | undefined, ev: MailReplyEvent): MailReply | undefined {
	switch (ev) {
		case "sent":
			return "replied";
		case "need":
			return cur ?? "needs";
		case "draft":
			return !cur || cur === "needs" ? "draft" : cur;
		case "skip":
			return cur === "replied" ? cur : "skipped";
		case "fyi":
			return cur === "replied" ? cur : "fyi";
		case "reopen":
			return cur === "skipped" || cur === "fyi" ? "needs" : cur;
	}
}

/** What older records say: `needsReply` / `noReply` flags and the suggested reply draft's state. */
export type LegacyReplyFacts = { reply?: MailReply; needsReply?: boolean; noReply?: boolean; suggest?: { state?: string } };
export function replyOf(m: LegacyReplyFacts): MailReply | undefined {
	if (m.reply) return m.reply;
	if (m.suggest?.state === "sent") return "replied";
	if (m.noReply) return "skipped";
	if (m.suggest) return m.suggest.state === "waiting" ? "needs" : "draft";
	return m.needsReply ? "needs" : undefined;
}

// ---- addresses ----

/** "Kim <Kim@Example.com>" -> "kim@example.com"; the plus-tag is dropped, and the dots of a Gmail address too. "" when there is no address. */
export function addressKey(text: string | undefined): string {
	const m = /([\w.!#$%&'*+/=?^`{|}~-]+)@([\w-]+(?:\.[\w-]+)+)/.exec(text ?? "");
	if (!m) return "";
	const domain = m[2]!.toLowerCase();
	let user = m[1]!.toLowerCase().replace(/\+.*$/, "");
	if (domain === "gmail.com" || domain === "googlemail.com") user = user.replace(/\./g, "");
	return `${user}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

const registered = new Map<string, Set<string>>();
/** The accounts a mail source reads (zele: `zele whoami`), replacing what that source registered before. */
export function setOwnAddresses(source: string, addresses: readonly string[]): void {
	registered.set(source, new Set(addresses.map(addressKey).filter(Boolean)));
}
export function resetOwnAddresses(): void {
	registered.clear();
}
/** Every address that is the owner's: what the sources registered (the "config" source holds the aliases of config.json, hub/mail.ts) plus `extra`. */
export function ownAddresses(extra: readonly string[] = []): Set<string> {
	return new Set([...[...registered.values()].flatMap(s => [...s]), ...extra.map(addressKey)].filter(Boolean));
}
export const isOwnAddress = (from: string | undefined, own: ReadonlySet<string> = ownAddresses()): boolean => {
	const a = addressKey(from);
	return !!a && own.has(a);
};

const SENT_FOLDER = /^(?:sent|sent mail|sent items|sentmail|보낸\s*편지함|보낸\s*메일함?)$/i;
export type DirectionFacts = { from?: string; direction?: string; folder?: string; labels?: readonly string[] };
/** Outgoing when the poster says so, the mail sits in a sent folder / carries a SENT label, or it was written from one of the owner's addresses. */
export function directionOf(f: DirectionFacts, own: ReadonlySet<string> = ownAddresses()): MailDirection {
	if (f.direction === "out") return "out";
	if (f.direction === "in") return "in";
	if (f.folder && SENT_FOLDER.test(f.folder.trim())) return "out";
	if (f.labels?.some(l => SENT_FOLDER.test(l.trim()))) return "out";
	return isOwnAddress(f.from, own) ? "out" : "in";
}

// ---- migration ----

export type StoredMail = LegacyReplyFacts & { key: string; subject: string; from: string; to?: string; at: string; dir?: "out"; sentAt?: string };
const subjectKey = (s: string): string => s.replace(/^\s*(?:(?:re|fw|fwd|답장|회신|전달)\s*:\s*)+/gi, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * One idempotent pass over the stored mails: the owner's own mails become outgoing, the old flags become `reply`, and an incoming mail with a
 * reply of his own (a sent dotz draft for it, or an outgoing mail with the same subject to its sender after it) becomes 답장함.
 * Returns the number of records it changed; a second run changes none.
 */
export function migrateMails(records: StoredMail[], opts: { own?: ReadonlySet<string>; sentRefs?: ReadonlySet<string> } = {}): number {
	const own = opts.own ?? ownAddresses();
	let changed = 0;
	for (const r of records) {
		let touched = false;
		if (r.dir !== "out" && isOwnAddress(r.from, own)) {
			r.dir = "out";
			touched = true;
		}
		if (r.dir === "out") {
			if (r.reply || "needsReply" in r || "noReply" in r) {
				delete r.reply;
				delete r.needsReply;
				delete r.noReply;
				touched = true;
			}
		} else {
			const reply = opts.sentRefs?.has(r.key) ? "replied" : replyOf(r);
			if (reply !== r.reply || "needsReply" in r || "noReply" in r) {
				if (reply) r.reply = reply;
				delete r.needsReply;
				delete r.noReply;
				touched = true;
			}
		}
		if (touched) changed++;
	}
	const sent = records.filter(r => r.dir === "out");
	for (const r of records) {
		if (r.dir === "out" || r.reply === "replied") continue;
		const subject = subjectKey(r.subject);
		const who = addressKey(r.from);
		const answer = sent.find(s => s.at >= r.at && subjectKey(s.subject) === subject && !!who && (s.to ?? "").split(",").some(t => addressKey(t) === who));
		if (!answer) continue;
		r.reply = "replied";
		r.sentAt = answer.at;
		changed++;
	}
	return changed;
}
