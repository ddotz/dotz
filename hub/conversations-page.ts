import type { Conversation } from "./conversations.ts";

// One page of GET /api/conversations (docs/web-app-design.md 대화 목록). The sessions and project channels (few) always come with the first page;
// the mail rows (thousands) come `limit` at a time in the list's order, newest message first, and `next` is the cursor of the older ones.
// The first page also carries the newest few mails that owe a reply or hold a draft and are older than it (the 메일 · 카카오톡 card is drawn from them,
// web/js/31-conversations.js convWaiting). The later pages are the plain cursor walk, so such a row may come twice; the web keys rows by target (convApply).
export const CONV_PAGE = 100;
export const CONV_PAGE_MAX = 500;
/** How many owed mails older than the first page ride along with it: the card shows 5 rows at most (convWaiting ends with `.slice(0, 5)`), so more would never be drawn. */
export const CONV_OWED_EXTRA = 5;

type MailCard = { dir?: string; archived?: true; read?: boolean; reply?: string; unreplied?: true; source?: string };
export type ConvRow = Conversation & { mail?: MailCard };
type Tally = { total: number; unread: number };
export type ConvCounts = { rows: number; mail: Tally & { filters: Record<"all" | "unread" | "owed" | "replied" | "archived" | "sent", number>; sources: Record<string, Tally> } };

const stamp = (r: ConvRow): string => r.last?.ts ?? "";
// The order of the list, made total: newest first, equal stamps by target.
const order = (a: ConvRow, b: ConvRow): number => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
const cursorOf = (r: ConvRow): string => `${stamp(r)}|${r.target}`;
// The rows convWaiting keeps: an incoming, not archived mail with a draft or a reply owed.
const owes = (r: ConvRow): boolean => !!r.mail && r.mail.dir !== "out" && !r.mail.archived && (r.mail.reply === "draft" || r.mail.unreplied === true);
const olderThan = (cursor: string) => (r: ConvRow): boolean => {
	const at = cursor.indexOf("|"), ts = cursor.slice(0, at), target = cursor.slice(at + 1);
	return stamp(r) < ts || (stamp(r) === ts && r.target > target);
};

/** The counts over every row, whatever page is drawn: the same rules as the web's mail filters (web/js/30-monitoring-mail.js MAIL_FILTERS). */
export function countRows(rows: readonly ConvRow[]): ConvCounts {
	const mail = rows.filter(r => r.mail);
	const filters = { all: 0, unread: 0, owed: 0, replied: 0, archived: 0, sent: 0 };
	const sources: Record<string, Tally> = {};
	let unread = 0;
	for (const r of mail) {
		const m = r.mail!, incoming = m.dir !== "out";
		unread += r.unread;
		const s = (sources[m.source ?? ""] ??= { total: 0, unread: 0 });
		s.total++;
		s.unread += r.unread;
		if (!incoming) filters.sent++;
		else if (m.archived) filters.archived++;
		else {
			filters.all++;
			if (m.read === false) filters.unread++;
			if (m.reply === "needs" || m.reply === "draft") filters.owed++;
			if (m.reply === "replied") filters.replied++;
		}
	}
	return { rows: rows.length, mail: { total: mail.length, unread, filters, sources } };
}

/** The answer to a query: `target=<t>` (repeat it, at most 50) those rows only; `all=1` every row; `before=<cursor>` the next `limit` mail rows after it; otherwise the first page with the counts and the newest CONV_OWED_EXTRA owed mails older than it.
 *  The page is decided from `rows`, whose `mail` holds only the cheap fields (the counts and the order need no more); `build` makes the full row of a mail row that goes out, so a long mailbox costs a card per row sent, not per mail. */
export function conversationPage(rows: readonly ConvRow[], q: URLSearchParams, build: (row: ConvRow) => ConvRow = row => row): { status: number; body: Record<string, unknown> } {
	const full = (list: readonly ConvRow[]): ConvRow[] => list.map(r => (r.mail ? build(r) : r));
	const want = new Set(q.getAll("target").slice(0, 50));
	if (want.size) return { status: 200, body: { items: full(rows.filter(r => want.has(r.target))), page: { limit: want.size, more: false } } };
	if (q.get("all") === "1") return { status: 200, body: { items: full(rows), page: { limit: rows.length, more: false }, counts: countRows(rows) } };
	const asked = Math.floor(Number(q.get("limit")));
	const limit = asked >= 1 ? Math.min(asked, CONV_PAGE_MAX) : CONV_PAGE;
	const before = q.get("before");
	if (before !== null && !/^[^|]*\|.+$/.test(before)) return { status: 400, body: { error: "before is a cursor from a page's next" } };
	const mails = rows.filter(r => r.mail).sort(order);
	const left = before === null ? mails : mails.filter(olderThan(before));
	const shown = left.slice(0, limit), rest = left.slice(limit), more = rest.length > 0;
	const page = { limit, more, ...(more ? { next: cursorOf(shown[shown.length - 1]!) } : {}) };
	if (before !== null) return { status: 200, body: { items: full(shown), page } };
	return { status: 200, body: { items: full([...rows.filter(r => !r.mail), ...shown, ...rest.filter(owes).slice(0, CONV_OWED_EXTRA)].sort(order)), page, counts: countRows(rows) } };
}
