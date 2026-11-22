import { eventTarget, onEmit, tailEvents, type HubEvent } from "./events.ts";
import { paths } from "./config.ts";
import { briefMail, mailByKey } from "./mail.ts";
import { laneLive, lanes } from "./lanestate.ts";
import { readOf, unreadFrom } from "./reads.ts";
import { dropIdNote, noticeKo, plainTable } from "./notice.ts";
import { dropClaim, parseTone, previewSource } from "./tone.ts";

// The messenger overview: one row per conversation (the main chat, each project channel, each session) with its newest real
// message. Built once from the inbox/outbox tail, then kept current by onEmit; a request never rescans the files.
// The web mirrors the "real message" rule (web/js/31-conversations.js), so keep the two in step.
type ConversationLast = { ts: string; text: string; from: "owner" | "bot" | "session" };
// `read`: where the owner has read up to (hub/reads.ts), `unread`: real messages after it that are not the owner's own.
export type Conversation = { target: string; last: ConversationLast | null; read: string | null; unread: number };

const PREVIEW_MAX = 120;
// Kinds that show as a message in a conversation. Not here: delivery states, activity, progress notes (`out` with an
// update_key), lane_start, and the bell's notice / notice_read.
const OWNER_KINDS = new Set(["message", "lane_message"]);
const MESSAGE_KINDS = new Set([...OWNER_KINDS, "out", "lane_report", "result", "mail", "schedule", "watch"]);

export function isRealMessage(e: HubEvent): boolean {
	if (!MESSAGE_KINDS.has(e.kind)) return false;
	if (e.kind !== "out" || !e.update_key) return true;
	// A post edited in place is a message only in the two fixed conversations (a lane's worklog line, an alert's update_key); in the
	// main chat, a project or a session it is a progress note.
	const t = eventTarget(e);
	return e.update_key !== "progress" && (t === "alert" || t === "worklog");
}

// First meaningful line of a message as plain text: the handoff block, the [done]-style marker, code fences and markdown
// decoration are dropped.
export function previewOf(raw: string): string {
	const text = plainTable(noticeKo(dropClaim(parseTone(previewSource(raw)).text)));
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		const plain = dropIdNote(line
			.replace(/^\s*-#\s+/, "")
			.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/[*~`]+|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, ""))
			.replace(/\s+/g, " ")
			.trim();
		if (!plain) continue;
		return plain.length > PREVIEW_MAX ? `${plain.slice(0, PREVIEW_MAX - 1)}…` : plain;
	}
	return "";
}

const fromOf = (e: HubEvent): ConversationLast["from"] => (OWNER_KINDS.has(e.kind) ? "owner" : e.kind === "lane_report" || (typeof e.source === "string" && e.source.startsWith("lane:")) ? "session" : "bot");

function lastOf(e: HubEvent): ConversationLast | undefined {
	if (!isRealMessage(e) || gatewayWake(e)) return undefined;
	const card = e.card && typeof e.card === "object" ? (e.card as { title?: unknown }).title : undefined;
	const hasFiles = Array.isArray(e.files) && e.files.length > 0;
	const text = previewOf(String(e.text ?? "")) || previewOf(typeof card === "string" ? card : "") || (hasFiles ? "파일" : "");
	if (!text) return undefined;
	return { ts: e.ts, text, from: fromOf(e) };
}

const tailLast = new WeakMap<HubEvent, ConversationLast | null>();
function lastOfTail(e: HubEvent): ConversationLast | undefined {
	if (!tailLast.has(e)) tailLast.set(e, lastOf(e) ?? null);
	return tailLast.get(e) ?? undefined;
}

const known = new Map<string, ConversationLast | null>([["main", null], ["alert", null], ["worklog", null]]);
let loaded = false;
let sorted: { target: string; last: ConversationLast | null }[] | undefined;

// The newest messages that can be unread, per target: event key -> ts. The load from the log tail and the live event of the
// same message meet here, so the key keeps it counted once.
const UNREAD_KEEP = 500;
const incoming = new Map<string, Map<string, string>>();
type Pending = { key: string; ts: string; e?: HubEvent };
const pending = new Map<string, { ops: Pending[]; limit: number }>();
// The gateway's own wake for a check (hub/main.ts wakeOnce) is an instruction to the assistant: the chat draws no card for it, so it is no message (web/js/11-todo-strip.js gatewayWake).
const gatewayWake = (e: HubEvent) => e.kind === "schedule" && e.source === "gateway";
const cleanRestart = (e: HubEvent) => e.kind === "out" && e.source === "gateway" && /^게이트웨이(?: 재시작했어요|를 다시 시작했어요)/.test(String(e.text ?? "")) && /끊긴 작업은 없어요/.test(String(e.text ?? ""));
const countable = (e: HubEvent, from: ConversationLast["from"]) => from !== "owner" && !cleanRestart(e) && !e.system;
const incomingKey = (e: HubEvent) => (e.kind === "out" && typeof e.update_key === "string" && e.update_key ? `key|${e.update_key}` : `${e.ts}|${e.kind}|${String(e.text ?? "").slice(0, 60)}`);
const counts = (op: Pending) => !op.e || lastOfTail(op.e) !== undefined;

function keep(bucket: Map<string, string>, key: string, ts: string): void {
	bucket.set(key, ts);
	if (bucket.size > UNREAD_KEEP) bucket.delete(bucket.keys().next().value as string);
}

function countIncoming(target: string, e: HubEvent, last: ConversationLast): void {
	// A gateway system line (`system`, e.g. a deferral receipt) is a status, not a message to read.
	if (!countable(e, last.from)) return;
	const lazy = pending.get(target);
	if (lazy) {
		lazy.ops.push({ key: incomingKey(e), ts: e.ts });
		if (lazy.ops.length > lazy.limit) settled(target);
		return;
	}
	let bucket = incoming.get(target);
	if (!bucket) incoming.set(target, (bucket = new Map()));
	// An edited post counts once, at its newest version.
	keep(bucket, incomingKey(e), e.ts);
}

function settled(target: string): Map<string, string> | undefined {
	const lazy = pending.get(target);
	if (!lazy) return incoming.get(target);
	pending.delete(target);
	const bucket = new Map<string, string>();
	for (const op of lazy.ops) if (counts(op)) keep(bucket, op.key, op.ts);
	incoming.set(target, bucket);
	return bucket;
}

function pendingCount(ops: readonly Pending[], read: string | null): number | undefined {
	const fresh = new Set<string>();
	for (const op of ops) if (!read || op.ts > read) fresh.add(op.key);
	if (!fresh.size) return 0;
	const from = ops.findIndex(op => fresh.has(op.key));
	if (new Set(ops.slice(from).map(op => op.key)).size > UNREAD_KEEP) return undefined;
	const seen = new Set<string>();
	let n = 0;
	for (let i = ops.length - 1; i >= from; i--) {
		const op = ops[i]!;
		if (!fresh.has(op.key) || seen.has(op.key) || !counts(op)) continue;
		seen.add(op.key);
		if (!read || op.ts > read) n++;
	}
	return n;
}

export function unreadOf(target: string): number {
	if (target.startsWith("mail:") && mailByKey(target.slice(5))?.dir === "out") return 0;
	// An ended session has nothing unread (owner 2026-11-03: "끝난 세션에 있는 안읽음 표시는 무시"), and once it runs again only what came
	// after its end counts. Every surface (session rows, sidebar counts, the other computer's snapshot) reads this count.
	const lane = target.startsWith("lane:") ? lanes.get(target.slice(5)) : undefined;
	if (lane && !laneLive(lane)) return 0;
	const read = [unreadFrom(target), lane?.endedAt].reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null);
	const lazy = pending.get(target);
	const quick = lazy && pendingCount(lazy.ops, read);
	let n = quick ?? 0;
	if (quick === undefined) for (const ts of settled(target)?.values() ?? []) if (!read || ts > read) n++;
	// An old mail whose message is no longer in the log tail has nothing to count; 안 읽음 on it (hub/reads.ts markUnread) put the owner's own position before it, and that counts it once.
	if (!n && target.startsWith("mail:") && !(lazy ? lazy.ops.findLast(counts) : incoming.get(target)?.size)) {
		const own = readOf(target), m = mailByKey(target.slice(5));
		if (own && m && m.dir !== "out" && m.at > own) n = 1;
	}
	return n;
}

function note(e: HubEvent): void {
	if (typeof e.ts !== "string") return;
	const target = eventTarget(e);
	const last = target ? lastOf(e) : undefined;
	if (!target || !last) return;
	// A mail posted without a summary gets the one its conversation says (once; the list then needs no conversation).
	if (target.startsWith("mail:") && !OWNER_KINDS.has(e.kind)) briefMail(target.slice(5), String(e.text ?? ""));
	countIncoming(target, e, last);
	const prev = known.get(target);
	if (prev && prev.ts > last.ts) return;
	known.set(target, last);
	sorted = undefined;
}

onEmit(note);

function load(): void {
	if (loaded) return;
	loaded = true;
	// Oldest first, so the tail never overwrites a newer live event already noted.
	const tail = [...tailEvents(paths.inbox), ...tailEvents(paths.outbox)].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
	const byTarget = new Map<string, HubEvent[]>();
	const firstAt = new Map<HubEvent, number>();
	tail.forEach((e, i) => {
		const target = typeof e.ts === "string" && isRealMessage(e) && !gatewayWake(e) ? eventTarget(e) : undefined;
		if (!target) return;
		const events = byTarget.get(target);
		if (events) events.push(e);
		else byTarget.set(target, [e]);
		firstAt.set(e, i);
	});
	const added: { target: string; last: ConversationLast; at: number }[] = [];
	for (const [target, events] of byTarget) {
		if (target.startsWith("mail:")) briefFromTail(target.slice(5), events);
		deferIncoming(target, events);
		let i = events.length;
		let last: ConversationLast | undefined;
		while (!last && i > 0) last = lastOfTail(events[--i]!);
		if (!last) continue;
		const newest = last.ts;
		if (events.slice(0, i).some(e => e.ts > newest)) last = events.reduce<ConversationLast | undefined>((cur, e) => { const l = lastOfTail(e); return l && !(cur && cur.ts > l.ts) ? l : cur; }, undefined)!;
		const prev = known.get(target);
		if (prev && prev.ts > last.ts) continue;
		if (known.has(target)) known.set(target, last);
		else added.push({ target, last, at: firstAt.get(events.find(e => lastOfTail(e))!)! });
	}
	for (const a of added.sort((x, y) => x.at - y.at)) known.set(a.target, a.last);
	sorted = undefined;
}

function briefFromTail(key: string, events: readonly HubEvent[]): void {
	for (const e of events) {
		const mail = mailByKey(key);
		if (!mail || mail.summary || mail.preview) return;
		if (!OWNER_KINDS.has(e.kind) && lastOfTail(e)) briefMail(key, String(e.text ?? ""));
	}
}

function deferIncoming(target: string, events: readonly HubEvent[]): void {
	const ops: Pending[] = [...(incoming.get(target) ?? [])].map(([key, ts]) => ({ key, ts }));
	for (const e of events) if (countable(e, fromOf(e))) ops.push({ key: incomingKey(e), ts: e.ts, e });
	if (!ops.length) return;
	incoming.delete(target);
	pending.set(target, { ops, limit: ops.length + UNREAD_KEEP });
}

// `live`: the targets that exist right now (live sessions, project channels); they are listed even before their first message.
export function conversationList(live: readonly string[] = []): Conversation[] {
	load();
	for (const t of live) if (!known.has(t)) known.set(t, null);
	if (!sorted || sorted.length !== known.size) {
		sorted = [...known].map(([target, last]) => ({ target, last })).sort((a, b) => (b.last?.ts ?? "").localeCompare(a.last?.ts ?? ""));
	}
	return sorted.map(c => ({ ...c, read: readOf(c.target), unread: unreadOf(c.target) }));
}
