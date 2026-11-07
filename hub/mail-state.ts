// One place for what a mail item IS (hub/mail.ts keeps the records): its direction and, for an incoming one, its reply state.
//
// Direction: every mail is incoming ("in") or outgoing ("out"). Outgoing = written by the owner: its sender is one of his own addresses
// (the accounts `zele whoami` lists, aliases from config.json `mail.own_addresses` / `zele.aliases`, plus-tags and Gmail dots ignored),
// or the poster says so (`direction: "out"`, a sent `folder`: SENT / 보낸편지함, or a SENT label). An outgoing mail is listed under 보낸 메일
// and never counts as unread, never wakes the bot, never gets a reply draft.
//
// A mail he sent to himself is the exception that stays where the mailbox put it: read by its sender address alone (`selfSent`), it may be listed as
// incoming, and only its reply state is affected.
//
// Reply state of an incoming thread, kept apart from read / unread (reading never changes it):
//   (none)  nothing is expected          needs   답장 필요        draft  초안 있음 (a draft waits for approval)
//   replied 답장함 (sent by dotz, or an outgoing mail of his found later in the thread)
//   skipped 답장 안 함 (his mark, older)  fyi     답장 안 함 (his mark)
// skipped and fyi are kept apart in the data but read the same to him: one label, 답장 안 함. Only he sets either (hub/mail.ts setMailReply
// refuses them without `by: "owner"`), and his mark records who and when (`reply_by: "owner"`, `reply_at`), so a skipped without that
// evidence is known to be from older code (hub/mail-repair.ts lists them).
// `nextReply` is the only place that moves between them.
import { readAppsFile } from "./integrations.ts";
import { mailCueText, type MailLines } from "./mail-lines.ts";

export type MailDirection = "in" | "out";
export type MailReply = "needs" | "draft" | "replied" | "skipped" | "fyi";
/** need = a reply is expected; draft = a reply draft was offered; sent = a reply went out (dotz) or his own mail was found in the thread;
 *  skip / fyi = his marks; reopen = his 답장 필요로 표시 (from no state, a mark, or an answered thread that needs another answer). */
export type MailReplyEvent = "need" | "draft" | "sent" | "skip" | "fyi" | "reopen";

export const REPLY_LABEL: Readonly<Record<MailReply, string>> = { needs: "답장 필요", draft: "초안 있음", replied: "답장함", skipped: "답장 안 함", fyi: "답장 안 함" };
/** The reply-state tag of a mail row: an incoming mail's reply state, else none (""). Read / unread is never in this slot (the row has its own
 *  안 읽음 N pill), and an outgoing mail has no reply state (its sender slot says 나 → 받는 사람). */
export function mailLabel(dir: MailDirection, reply?: MailReply): string {
	return dir === "out" || !reply ? "" : REPLY_LABEL[reply];
}
/** Who set the reply state: "owner" = his own mark (답장 안 함, 답장 필요로 표시). Missing = the gateway, a poster or older code. */
export type ReplyBy = "owner";

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
			return cur === "draft" ? cur : "needs";
	}
}

// ---- does this incoming mail expect a reply? ----
// The poster may say so (`needsReply`); otherwise the gateway reads the mail itself, so 답장 필요 does not depend on a watcher or a bot
// remembering to mark it (owner 2026-10-27: every mail of the company webmail sat at no state). Conservative on purpose: a sender that
// is a machine or a mailing list, a bulk subject, an announcement or automated notice, an unsubscribe footer, or a mail whose To does not
// name one of the owner's addresses (he is only in CC / BCC, or it went to a group / distribution list) never expects one, nor does a mail he
// wrote himself, also one addressed to other people as well (owner 2026-11-05: "내가 나한테 보낸거는 답장 필요 안하는걸 디폴트로"); else
// a request in the subject or the text does (asks, questions, deadlines), and a mail that only delivers an answer does not.
const MACHINE_SENDER = /no-?reply|do-?not-?reply|mailer-daemon|postmaster|administrator|notification|newsletter|news@|marketing|알림|공지/i;
const BULK_SUBJECT = /^\s*[[(]?\s*(?:광고|ad|advertisement)\s*[\])]|스팸\s*리포트|spam report|뉴스레터|newsletter|시황|일일\s*(?:보고|리포트)|weekly digest|webinar|웨비나|unsubscribe|수신\s*거부|공지|공고|\bannouncement\b|\bnotice\b|out of office|부재\s*중|자동\s*(?:응답|발송)|auto-?reply/i;
const BULK_TEXT = /수신\s*거부|unsubscribe|더 이상 받지 않|광고성 정보|this email was sent to/i;
const ASKS = /요청|부탁|회신\s*(?:바랍|부탁|주|요망|해)|답변\s*(?:바랍|부탁|주|요망|해)|답장\s*(?:바랍|부탁|주)|문의|검토\s*(?:해|부탁|요청|후|바랍)|확인\s*(?:부탁|요청|해\s*주|바랍|하시고)|의견\s*(?:을|주|부탁|바랍)|제출\s*(?:해|부탁|바랍|요망)|견적|주시기\s*바랍|주시면|주세요|해\s*주실|해\s*주시|가능(?:하신지|할까요|한지|하실까요)|어떻게\s*생각|까지\s*(?:회신|제출|송부|보내)|[?？]|please|could you|can you|would you|let me know|request|kindly|asap/i;
const TODO = /할\s*일[\s\S]*/;
const TODO_NONE = /^할\s*일\W*\s*(?:•|-|·)?\s*없음/;
// Making something for the sender counts (작성, 견적, 해설, 자료 준비...): what is made goes back to him.
const REPLY_TODO = /회신|답장|답변|제출|작성|송부|보내|알려|의견|참석\s*여부|견적|해설|자료\s*(?:준비|정리|제공|전달)|reply|respond|send/i;
const ANSWERS = /답변\s*(?:전달|드립니다|드려요|입니다)|회신\s*(?:드립니다|드려요|입니다)|감사합니다\.?\s*$/i;
/** `list` = the poster saw a List-Id / List-Unsubscribe header (a mailing list or group mail). */
export type ReplyCue = { source?: string; account?: string; from?: string; to?: string; cc?: string; subject: string; text?: string; list?: boolean };

// ---- is the owner a main recipient? ----
// 답장 필요 is only for a mail written to him (owner 2026-10-31: "내가 주요 대상이 아닌 경우에는 답장 필요에서 제외"). Deterministic rules, no model:
//   cc     참조로 받음   his address is in Cc and not in To
//   list   단체 메일     a mailing list / group mail: List-Id or List-Unsubscribe, an unsubscribe footer or bulk subject, or a To that is a
//                       group address (all@, team@, googlegroups.com...) with none of his addresses in To / Cc
//   bulk   자동 발송     a machine sender (noreply, notification, newsletter...)
//   other  다른 사람 앞  he is one of 3+ To recipients and the mail greets another of them by name ("Lee님,", "Hi Lee,")
//   self   (no tag)     he wrote it (selfSent)
// A mail that is excluded still shows in the list, only never as 답장 필요, with the reason as a small tag (mailCard `why`).
// cc, and list by a group address in To, are the 받는 사람 rule: 메일 앱 설정 > 답장 필요는 받는 사람이 나인 메일만 (custom/apps.json mail.to_only, one value for the
// whole install; default on). Off, a mail without his address in To is read like any other, and every other exclusion still holds.
export type ReplyExclusion = "self" | "cc" | "list" | "bulk" | "other";
export const EXCLUSION_LABEL: Readonly<Record<Exclude<ReplyExclusion, "self">, string>> = { cc: "참조로 받음", list: "단체 메일", bulk: "자동 발송", other: "다른 사람 앞" };
const GROUP_ADDRESS = /^(?:all|everyone|team|staff|group|groups|list|members?|announce\w*|notice|news|company|office|전체)(?:[._-][\w.-]*)?@|@googlegroups\.com$|@groups\./i;
const parts = (s: string | undefined): string[] => (s ?? "").split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/).map(t => t.trim()).filter(Boolean);
const nameOf = (t: string): string => t.replace(/<[^>]*>/, "").replace(/["']/g, "").trim().toLowerCase();
// The name a mail greets in its first line: "이영희님," / "영희 님" / "Dear Lee," / "Hi Lee".
const GREETING = /^\s*(?:(?:dear|hi|hello)\s+([a-z][\w.-]*)|([가-힣a-z][가-힣\w.-]{0,20}?)\s*(?:님|씨))\s*[,.:!\s]/i;
let toOnlyDir: string | undefined;
/** Where the 받는 사람 rule is read from, live (the file's read is cached), so a change applies without a restart. Unset (a pure caller): the rule holds. */
export const setToOnlyDir = (dataDir: string | undefined): void => {
	toOnlyDir = dataDir;
};
const toOnly = (): boolean => !toOnlyDir || readAppsFile(toOnlyDir).mail?.to_only !== false;
export function replyExclusion(m: ReplyCue, own: ReadonlySet<string> = ownAddressesFor(m.source)): ReplyExclusion | undefined {
	if (selfSent(m, own)) return "self";
	if (m.list) return "list";
	if (MACHINE_SENDER.test(m.from ?? "")) return "bulk";
	const text = (m.text ?? "").slice(0, 4000);
	if (BULK_SUBJECT.test(m.subject) || BULK_TEXT.test(text)) return "list";
	if (!own.size || !m.to) return undefined;
	const to = parts(m.to), cc = parts(m.cc);
	const mine = (t: string) => own.has(addressKey(t));
	if (!to.some(mine) && toOnly()) {
		if (cc.some(mine)) return "cc";
		return to.some(t => GROUP_ADDRESS.test(addressKey(t))) ? "list" : undefined;
	}
	const others = to.filter(t => !mine(t));
	if (others.length < 2) return undefined;
	const g = GREETING.exec(text.split("\n").find(l => l.trim()) ?? "");
	const name = (g?.[1] ?? g?.[2] ?? "").toLowerCase();
	if (name.length < 2) return undefined;
	const named = (t: string) => { const n = nameOf(t); const local = addressKey(t).split("@")[0] ?? ""; return (!!n && (n === name || n.split(/\s+/).includes(name) || (name.length >= 2 && /[가-힣]/.test(name) && n.endsWith(name)))) || local === name; };
	return others.some(named) && !to.filter(mine).some(named) ? "other" : undefined;
}

/** Written by the owner: the sender is one of the addresses known for the mail's source, or its account. With none known at all a mail from
 *  X to X alone is his (only then: a bulk sender also writes to itself, with its readers in Bcc). */
export function selfSent(m: Pick<ReplyCue, "source" | "account" | "from" | "to" | "cc">, own: ReadonlySet<string> = ownAddressesFor(m.source)): boolean {
	const from = addressKey(m.from);
	if (!from) return false;
	if (own.has(from) || from === addressKey(m.account)) return true;
	if (own.size || m.account) return false;
	const recipients = [...parts(m.to), ...parts(m.cc)];
	return recipients.length === 1 && addressKey(recipients[0]) === from;
}

/** The addresses of a To or Cc line. */
export const recipientKeys = (s: string | undefined): string[] => parts(s).map(addressKey).filter(Boolean);

export function replyExpected(m: ReplyCue, own: ReadonlySet<string> = ownAddressesFor(m.source)): boolean {
	if (replyExclusion(m, own)) return false;
	const text = (m.text ?? "").slice(0, 4000);
	// The mail summary ends with what the owner has to do ("할 일"): when it is there, it decides. A reply is owed when one of those
	// things goes back to the sender (회신, 제출, 작성해 보내기, 참석 여부...); "없음" or only reading and checking owes none.
	const todo = TODO.exec(text)?.[0];
	if (todo) return !TODO_NONE.test(todo) && REPLY_TODO.test(todo);
	return asksSomething(m.subject, text);
}
function asksSomething(subject: string, text: string): boolean {
	if (!ASKS.test(`${subject}\n${text}`)) return false;
	// A mail that only hands over an answer ("답변 전달", "회신 드립니다") and asks nothing else of its own.
	return !(ANSWERS.test(subject) && !ASKS.test(text.replace(new RegExp(ANSWERS.source, "gi"), "")));
}
/** Does the owner's own sent mail wait for an answer (hub/mail-unanswered.ts): the same reading as replyExpected, without the rules about who it came to. */
export function sentExpectsReply(m: Pick<ReplyCue, "subject" | "text" | "list">): boolean {
	const text = (m.text ?? "").slice(0, 4000);
	return !m.list && !BULK_SUBJECT.test(m.subject) && !BULK_TEXT.test(text) && asksSomething(m.subject, text);
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

/** "Kim <Kim@Example.com>" -> "kim@example.com"; the plus-tag is dropped, and the dots of a Gmail address too. "" when there is no address.
 *  The address in <> is the address: a display name that looks like one is only a name. */
export function addressKey(text: string | undefined): string {
	const m = /([\w.!#$%&'*+/=?^`{|}~-]+)@([\w-]+(?:\.[\w-]+)+)/.exec(/<([^<>]+)>\s*$/.exec(text ?? "")?.[1] ?? text ?? "");
	if (!m) return "";
	const domain = m[2]!.toLowerCase();
	let user = m[1]!.toLowerCase().replace(/\+.*$/, "");
	if (domain === "gmail.com" || domain === "googlemail.com") user = user.replace(/\./g, "");
	return `${user}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

const registered = new Map<string, Set<string>>();
// What each mail source itself showed to be his: the sender of its outgoing mails, which covers a source no account is registered for (a webmail
// watcher). These never decide a mail's direction (`ownAddresses`), only selfSent. `sourceOwn` holds the merged sets, built once per change.
const senders = new Map<string, Set<string>>();
const sourceOwn = new Map<string, ReadonlySet<string>>();
export function noteOwnSender(source: string, from: string | undefined): void {
	const a = addressKey(from);
	if (!a || senders.get(source)?.has(a)) return;
	senders.set(source, new Set([...(senders.get(source) ?? []), a]));
	sourceOwn.delete(source);
}
/** Every address known as his for one mail source: `ownAddresses` plus the senders of its outgoing mails. Cached: cheap for every row of every render. */
export function ownAddressesFor(source: string | undefined): ReadonlySet<string> {
	const key = source ?? "";
	let own = sourceOwn.get(key);
	if (!own) sourceOwn.set(key, (own = ownAddresses([...(senders.get(key) ?? [])])));
	return own;
}
/** The accounts a mail source reads (zele: `zele whoami`), replacing what that source registered before. */
export function setOwnAddresses(source: string, addresses: readonly string[]): void {
	registered.set(source, new Set(addresses.map(addressKey).filter(Boolean)));
	sourceOwn.clear();
}
/** What one source registered: `zele` = the accounts it is logged in to. */
export const addressesOf = (source: string): ReadonlySet<string> => registered.get(source) ?? new Set();
export function resetOwnAddresses(): void {
	registered.clear();
	senders.clear();
	sourceOwn.clear();
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

export type StoredMail = LegacyReplyFacts & MailLines & { source?: string; account?: string; list?: true; reply_by?: ReplyBy; reply_at?: string; key: string; subject: string; from: string; to?: string; cc?: string; at: string; dir?: "out"; sentAt?: string; summary?: string; preview?: string };
/** Mails older than this keep no reply state from replyExpected when the stored mails are brought up to the rules: history, not a backlog. */
const JUDGE_WINDOW_MS = 30 * 24 * 3600 * 1000;
export const subjectKey = (s: string): string => s.replace(/^\s*(?:(?:re|fw|fwd|답장|회신|전달)\s*:\s*)+/gi, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * One idempotent pass over the stored mails: the owner's own mails become outgoing, the old flags become `reply`, and an incoming mail with a
 * reply of his own (a sent dotz draft for it, or an outgoing mail with the same subject to its sender after it) becomes 답장함.
 * A mail he wrote and marked 답장 필요 himself stays incoming: his mark wins.
 * Returns the number of records it changed; a second run changes none.
 */
export function migrateMails(records: StoredMail[], opts: { own?: ReadonlySet<string>; sentRefs?: ReadonlySet<string>; now?: number } = {}): number {
	const own = opts.own ?? ownAddresses();
	const now = opts.now ?? Date.now();
	let changed = 0;
	for (const r of records) if (r.dir === "out" && r.source) noteOwnSender(r.source, r.from);
	for (const r of records) {
		let touched = false;
		if (r.dir !== "out" && isOwnAddress(r.from, own) && !(r.reply === "needs" && r.reply_by === "owner")) {
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
			const fresh = now - Date.parse(r.at) <= JUDGE_WINDOW_MS;
			const cue = { source: r.source, account: r.account, from: r.from, to: r.to, cc: r.cc, subject: r.subject, text: mailCueText(r) || r.preview || "", list: r.list };
			const mine = opts.own ?? ownAddressesFor(r.source);
			let reply = opts.sentRefs?.has(r.key) ? "replied" : replyOf(r) ?? (fresh && replyExpected(cue, mine) ? "needs" : undefined);
			// 답장 필요 the gateway or a poster set, on a mail he is not a main recipient of or wrote himself: none (his own 답장 필요로 표시 stays).
			if (reply === "needs" && r.reply_by !== "owner" && replyExclusion(cue, mine)) reply = undefined;
			if (reply !== r.reply || "needsReply" in r || "noReply" in r) {
				if (reply) r.reply = reply;
				else delete r.reply;
				delete r.needsReply;
				delete r.noReply;
				touched = true;
			}
		}
		if (touched) changed++;
	}
	const sent = records.filter(r => r.dir === "out");
	for (const r of records) {
		if (r.dir === "out" || r.reply === "replied" || selfSent(r, opts.own)) continue;
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

/**
 * The keep limit for the stored mails: the surplus over `keep` is taken from the oldest end (`records` is sorted by time), `onDrop` gets each dropped key.
 * A mail with a reply draft waiting (reply "draft", or a suggest not sent) is never evicted: its card would lose its subject and close as handled
 * (hub/draft-handled.ts treats a missing mail as gone). A mail that only has reply "needs" stays while the list holds at most `needsMax` mails,
 * so a reply expected cannot grow the list forever.
 */
export function evictSurplus<T extends { key: string; reply?: MailReply; suggest?: { state?: string } }>(records: T[], keep: number, needsMax: number, onDrop?: (key: string) => void): T[] {
	let surplus = records.length - keep;
	if (surplus <= 0) return records;
	let total = records.length;
	return records.filter(x => {
		if (surplus <= 0 || x.reply === "draft" || (!!x.suggest && (x.suggest.state ?? "draft") !== "sent") || (x.reply === "needs" && total <= needsMax)) return true;
		surplus--;
		total--;
		onDrop?.(x.key);
		return false;
	});
}
