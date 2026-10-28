// Who a mail reply draft goes to: 답장 (the sender alone) or 전체 답장 (the sender plus the original mail's 받는 사람 and 참조, minus the
// owner's own addresses). Pure: the caller hands in the original's headers and the owner's addresses (hub/mail-state.ts ownAddresses,
// which knows the config aliases and each source's account), so nothing here reads a config or a mail store.
import { addressesOf } from "../../../hub/reply-draft.ts";

export type ReplyMode = "reply" | "all";
export type Recipients = { to: string[]; cc: string[] };

/** 받는 사람 / 참조 rows the owner may keep: a mail that needs more than this is not a reply to answer on a card. */
export const RECIPIENTS_MAX = 20;

const key = (a: string) => a.trim().toLowerCase();

/** The same list without repeats and empty entries: every address in one form ("Kim <KIM@x>" and "kim@x" are one person), a name kept as written. */
export function uniqAddresses(list: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of list) {
		const text = raw.trim();
		if (!text) continue;
		const address = addressesOf(text)[0];
		const k = address ?? key(text);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(address ?? text);
	}
	return out;
}

/** One address per entry from what a source gives ("Kim <kim@x>", "a@x, b@y"); a sender the source names without an address stays as it is. */
export function recipientList(s: string | undefined): string[] {
	const found = uniqAddresses(addressesOf(s));
	if (found.length || !s?.trim()) return found;
	return [s.trim()];
}

/** The stored form of a 받는 사람 list: one comma list, which every sender already takes (`--to`). */
export const recipientText = (list: readonly string[]): string => list.join(", ");

// One mail's two answers: 답장 = the sender alone; 전체 답장 = the sender and the original's 받는 사람, with its 참조 kept in 참조. The owner's own
// addresses are never a recipient: a mail addressed to several people is delivered to each of them, and no answer goes to oneself.
export function replyRecipients(m: { sender: string; to?: string; cc?: string; self?: readonly string[] }): { reply: Recipients; all: Recipients } {
	const own = new Set(m.self?.flatMap(a => addressesOf(a)) ?? []);
	const reply: Recipients = { to: recipientList(m.sender), cc: [] };
	const to = uniqAddresses([...reply.to, ...addressesOf(m.to)]);
	const cc = uniqAddresses(addressesOf(m.cc));
	const all: Recipients = { to: to.filter(a => !own.has(a)), cc: cc.filter(a => !own.has(a) && !to.includes(a)) };
	return { reply, all };
}

export type ParsedRecipients = { ok: true; list: string[] } | { ok: false; error: string };

/**
 * What the card's input sends, checked where it enters the gateway: every entry must carry a mail address ("Kim <kim@x>" is read as kim@x),
 * and no entry may be one of the owner's own addresses. A value the card did not send is an empty list.
 */
export function parseRecipients(value: unknown, own: readonly string[] = []): ParsedRecipients {
	const raw = (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string");
	const list: string[] = [];
	for (const entry of raw) {
		const found = addressesOf(entry);
		if (!found.length) return { ok: false, error: `'${entry.trim() || "(빈 값)"}'은(는) 메일 주소가 아니에요` };
		for (const a of found) if (!list.includes(a)) list.push(a);
	}
	const mine = new Set(own.flatMap(a => addressesOf(a)));
	const self = list.find(a => mine.has(a));
	if (self) return { ok: false, error: `${self}은(는) 내 주소라서 받는 사람이 될 수 없어요` };
	if (list.length > RECIPIENTS_MAX) return { ok: false, error: `받는 사람·참조는 ${RECIPIENTS_MAX}명까지예요` };
	return { ok: true, list };
}
